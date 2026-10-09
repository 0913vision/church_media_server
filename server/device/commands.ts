import fs from 'node:fs';
import { RejectReason } from '../protocol.ts';
import type { CommandName, StatePatch } from '../protocol.ts';
import { ADMIN_CONFIG } from '../constants/authConfig.ts';
import { verifyPassword } from '../auth/password.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { runsOn } from '../schedule/Schedule.ts';
import { isYoutube } from '../tracks/Fetcher.ts';
import { DeskHeldError } from '../console/DeskHolds.ts';
import { log } from '../utils/logger.ts';

/**
 * What running a command produced. A tagged result rather than "a reason, or
 * nothing": the same rule the protocol follows, so success and failure are
 * both something you have to look at.
 */
export type CommandOutcome = { ok: true } | { ok: false; reason: RejectReason };

export const DONE: CommandOutcome = { ok: true };
export function refuse(reason: RejectReason): CommandOutcome {
  return { ok: false, reason };
}

/**
 * A command's implementation. Arguments arrive untrusted, so each run narrows
 * them itself.
 *
 * Gating lives here rather than in the invoke handler because it differs per
 * command: authenticate has to work while the admin lock is held, or nobody
 * could ever release it.
 */
export interface CommandSpec {
  run(args: unknown, deps: ServerDeps, socket: ServerSocket): Promise<CommandOutcome>;
}

/** Untrusted args as a plain object; an empty one when the payload is not */
function argsObject(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

/**
 * Track ids an unchecked calendar entry appears to name.
 *
 * Note(yoochan.kim): read off the raw payload, before the calendar has validated it, so
 * a nonexistent track is answered with unknownTrack rather than swallowed into
 * a generic invalidValue. Anything malformed simply names nothing here and the
 * calendar refuses it a moment later.
 */
function tracksNamedBy(entry: unknown): string[] {
  const parts = argsObject(entry).parts;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    const tracks = argsObject(part).tracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map((track) => argsObject(track).id).filter((id): id is string => typeof id === 'string');
  });
}

/** Whether a title belongs to another track already, or to the one a fetch is bringing. */
function titleInUse(deps: ServerDeps, title: string, except?: string): boolean {
  const fetching = deps.fetcher.status();
  return deps.trackLibrary.titleTaken(title, except) || (fetching.kind === 'fetching' && fetching.title === title);
}

/** Makes a track of audio that has arrived, and tells every client in one patch. */
function addFrom(deps: ServerDeps, file: string, title: string, durationSec: number, alongside: StatePatch): CommandOutcome {
  const track = deps.trackLibrary.add(file, title, durationSec);
  deps.notifier.state({ ...alongside, tracks: deps.trackLibrary.list() });
  log.info('command', null, 'Track added', { id: track.id, title: track.title, durationSec: track.durationSec });
  return DONE;
}

/**
 * The device's command table. Only what this server actually implements
 * appears here; the ready payload is built from these keys, so a client hides
 * controls for anything missing instead of guessing.
 */
export const COMMAND_IMPL: Partial<Record<CommandName, CommandSpec>> = {
  authenticate: {
    async run(args, deps, socket) {
      const password = argsObject(args).password;
      if (typeof password !== 'string') return refuse(RejectReason.INVALID_VALUE);

      if (!verifyPassword(password, ADMIN_CONFIG.ADMIN_PASSWORD_HASH)) {
        log.warn('command', socket, 'Socket failed admin authentication');
        return refuse(RejectReason.INVALID_PASSWORD);
      }

      deps.adminSessionManager.addAdminSocket(socket);
      // Note(yoochan.kim): isAdmin is per-connection, so it goes only to the client it describes.
      deps.notifier.stateTo(socket, { isAdmin: true });
      log.info('command', socket, 'Socket authenticated as admin');
      return DONE;
    },
  },

  enableConsoleInput: {
    async run(args, deps, socket) {
      const input = argsObject(args).input;
      // Note(yoochan.kim): which inputs exist is the desk's configuration, so
      // only it can say whether this is one
      if (!deps.mixerConsole.has(input)) return refuse(RejectReason.INVALID_VALUE);

      // Note(yoochan.kim): The console holds no protected state and its OSC bursts are
      // instantaneous, so this takes no audio lock — only the admin gate.
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      try {
        const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
          await deps.mixerConsole.enable(input);
        });
        if (!allowed) {
          log.warn('command', socket, 'Console input blocked (admin lock)', { input });
          return refuse(RejectReason.ADMIN_LOCKED);
        }
      } catch (error) {
        if (!(error instanceof DeskHeldError)) throw error;
        log.warn('command', socket, 'Console input blocked (desk held)', { input, address: error.address });
        return refuse(RejectReason.CONSOLE_HELD);
      }
      return DONE;
    },
  },

  initializeConsole: {
    async run(_args, deps, socket) {
      // Note(yoochan.kim): gated exactly like enableConsoleInput — the desk keeps
      // no protected state, so the admin gate is the only thing in the way. The
      // pacing between steps belongs to the console, not here.
      const isAdmin = deps.adminSessionManager.isAdminSocket(socket);
      try {
        const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
          await deps.mixerConsole.initialize();
        });
        if (!allowed) {
          log.warn('command', socket, 'Console initialize blocked (admin lock)');
          return refuse(RejectReason.ADMIN_LOCKED);
        }
      } catch (error) {
        if (!(error instanceof DeskHeldError)) throw error;
        log.warn('command', socket, 'Console initialize blocked (desk held)', { address: error.address });
        return refuse(RejectReason.CONSOLE_HELD);
      }
      return DONE;
    },
  },

  startFlow: {
    // Note(yoochan.kim): The whole plan arrives here; the server keeps none of it once the run
    // is over. Validation and scheduling belong to the runner.
    async run(args, deps) {
      return deps.flowRunner.start(args);
    },
  },

  stopFlow: {
    async run(_args, deps) {
      return deps.flowRunner.stop();
    },
  },

  extendAdminHold: {
    async run(_args, deps) {
      if (deps.flowRunner.ownsAdminLock()) return refuse(RejectReason.FLOW_ACTIVE);
      if (!deps.adminSession.extend()) return refuse(RejectReason.ADMIN_UNLOCKED);

      deps.notifier.state({ adminHold: deps.adminSession.adminHold() });
      return DONE;
    },
  },

  saveFlow: {
    async run(args, deps) {
      const entry = argsObject(args).flow;
      // Note(yoochan.kim): the calendar checks its own shape and its own arithmetic; only
      // "is this a track we have" needs the library, so only that is asked here.
      const named = tracksNamedBy(entry);
      for (const id of named) {
        if (!deps.trackLibrary.get(id)) return refuse(RejectReason.UNKNOWN_TRACK);
      }

      const saved = deps.schedule.save(entry);
      if (!saved.ok) {
        log.warn('command', null, 'Refused a calendar entry', { reason: saved.reason });
        return refuse(RejectReason.INVALID_VALUE);
      }

      deps.notifier.state({ schedule: deps.schedule.list() });
      return DONE;
    },
  },

  deleteFlow: {
    async run(args, deps) {
      const id = argsObject(args).id;
      if (typeof id !== 'string') return refuse(RejectReason.INVALID_VALUE);
      if (!deps.schedule.remove(id)) return refuse(RejectReason.UNKNOWN_FLOW);

      deps.notifier.state({ schedule: deps.schedule.list() });
      return DONE;
    },
  },

  startScheduledFlow: {
    async run(args, deps) {
      const id = argsObject(args).id;
      if (typeof id !== 'string') return refuse(RejectReason.INVALID_VALUE);

      const entry = deps.schedule.get(id);
      if (!entry) return refuse(RejectReason.UNKNOWN_FLOW);

      // Note(yoochan.kim): which day a bare "19:30" belongs to is the calendar's decision,
      // and it is made against the day somebody pressed start.
      const now = deps.clock.now();
      if (!runsOn(entry, now)) return refuse(RejectReason.WINDOW_PASSED);

      return deps.flowRunner.start(deps.schedule.toRunArgs(entry, now));
    },
  },

  skipFlow: {
    async run(args, deps) {
      const id = argsObject(args).id;
      if (typeof id !== 'string') return refuse(RejectReason.INVALID_VALUE);
      if (!deps.schedule.get(id)) return refuse(RejectReason.UNKNOWN_FLOW);

      deps.autoStarter.skip(id);
      return DONE;
    },
  },

  setTrackVolume: {
    async run(args, deps) {
      const { id, volume } = argsObject(args);
      if (typeof id !== 'string') return refuse(RejectReason.INVALID_VALUE);
      if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
        return refuse(RejectReason.INVALID_VALUE);
      }
      if (!deps.trackLibrary.get(id)) return refuse(RejectReason.UNKNOWN_TRACK);

      deps.trackLibrary.setVolume(id, volume);
      deps.notifier.state({ tracks: deps.trackLibrary.list() });
      return DONE;
    },
  },

  addTrack: {
    async run(args, deps) {
      const { title, source } = argsObject(args);
      // Note(yoochan.kim): the title is checked before the upload is claimed, so a refusal
      // here leaves the same upload to try again with a name.
      if (typeof title !== 'string' || title.trim().length === 0) return refuse(RejectReason.INVALID_VALUE);
      const named = title.trim();
      if (titleInUse(deps, named)) return refuse(RejectReason.TITLE_TAKEN);
      const from = argsObject(source);

      if (from.kind === 'upload') {
        if (typeof from.upload !== 'string') return refuse(RejectReason.INVALID_VALUE);
        const upload = deps.uploads.take(from.upload);
        if (!upload) return refuse(RejectReason.UNKNOWN_UPLOAD);
        return addFrom(deps, upload.file, named, upload.durationSec, {});
      }

      if (from.kind === 'youtube') {
        if (typeof from.url !== 'string' || !isYoutube(from.url)) return refuse(RejectReason.INVALID_VALUE);
        if (deps.fetcher.busy()) return refuse(RejectReason.FETCH_BUSY);

        // Note(yoochan.kim): fetch() claims the slot before it first waits, so the status
        // sent here already says fetching.
        const tell = (): void => deps.notifier.state({ trackFetch: deps.fetcher.status() });
        const fetching = deps.fetcher.fetch(from.url, named, deps.trackLibrary.stagingBase(), tell);
        tell();
        const fetched = await fetching;
        if (!fetched.ok) {
          deps.notifier.state({ trackFetch: deps.fetcher.status() });
          return refuse(fetched.reason);
        }
        // Note(yoochan.kim): minutes have passed, and a rename meanwhile may have taken the title.
        if (deps.trackLibrary.titleTaken(named)) {
          fs.rmSync(fetched.file, { force: true });
          deps.notifier.state({ trackFetch: deps.fetcher.status() });
          return refuse(RejectReason.TITLE_TAKEN);
        }
        // Note(yoochan.kim): the fetch ends in the same patch the track arrives in, so no
        // screen sees it finished with nothing to show for it.
        return addFrom(deps, fetched.file, named, fetched.durationSec, { trackFetch: deps.fetcher.status() });
      }

      return refuse(RejectReason.INVALID_VALUE);
    },
  },

  renameTrack: {
    async run(args, deps) {
      const { id, title } = argsObject(args);
      if (typeof id !== 'string' || typeof title !== 'string') return refuse(RejectReason.INVALID_VALUE);
      const named = title.trim();
      if (named.length === 0) return refuse(RejectReason.INVALID_VALUE);
      if (!deps.trackLibrary.get(id)) return refuse(RejectReason.UNKNOWN_TRACK);
      // Note(yoochan.kim): the panel's songs are named once, in ready.songs, and a panel
      // installed by hand is not asked to notice a rename.
      if (deps.trackLibrary.isDeckSong(id)) return refuse(RejectReason.DECK_SONG);
      if (titleInUse(deps, named, id)) return refuse(RejectReason.TITLE_TAKEN);

      deps.trackLibrary.rename(id, named);
      deps.notifier.state({ tracks: deps.trackLibrary.list() });
      return DONE;
    },
  },

  deleteTrack: {
    async run(args, deps) {
      const id = argsObject(args).id;
      if (typeof id !== 'string') return refuse(RejectReason.INVALID_VALUE);
      if (!deps.trackLibrary.get(id)) return refuse(RejectReason.UNKNOWN_TRACK);
      if (deps.trackLibrary.isDeckSong(id)) return refuse(RejectReason.DECK_SONG);

      const deck = deps.player.getDeck();
      const onDeck = deck.source === 'track' && deck.id === id;
      if (deps.schedule.usedBy(id).length > 0 || deps.flowRunner.uses(id) || onDeck) {
        return refuse(RejectReason.TRACK_IN_USE);
      }

      deps.trackLibrary.remove(id);
      deps.notifier.state({ tracks: deps.trackLibrary.list() });
      log.info('command', null, 'Track deleted', { id });
      return DONE;
    },
  },

  selectTrack: {
    async run(args, deps) {
      const id = argsObject(args).id;
      if (typeof id !== 'string') return refuse(RejectReason.INVALID_VALUE);
      // Note(yoochan.kim): while the panel is open it shows the song it believes is
      // playing, and a track it never chose would make that a lie.
      if (!deps.lockCoordinator.getLockState().admin) return refuse(RejectReason.ADMIN_UNLOCKED);
      // Note(yoochan.kim): the same rule the deck's attributes follow. It was missing here,
      // and a run holds the gate — so the one check above passes during a service
      // and this was the one door left open onto music that is already sounding.
      if (deps.flowRunner.ownsDeck()) return refuse(RejectReason.FLOW_ACTIVE);
      if (deps.levelMatcher.ownsDeck()) return refuse(RejectReason.LEVEL_MATCHING);

      const track = deps.trackLibrary.get(id);
      if (!track) return refuse(RejectReason.UNKNOWN_TRACK);

      // Note(yoochan.kim): a song the panel can pick is one that runs under a service,
      // so it repeats; anything else is put on to be heard once.
      const loop = deps.trackLibrary.isDeckSong(id);
      const ran = await deps.lockCoordinator.withAudioLock(true, async () => {
        deps.player.setLoop(loop);
        await deps.player.selectTrack(track, track.volume, loop);
      });
      if (!ran) return refuse(RejectReason.DEVICE_BUSY);

      deps.adminSession.sync();
      deps.notifier.state({
        deck: deps.player.getDeck(),
        playback: deps.player.getState(),
        volume: deps.player.getVolume(),
        loop: deps.player.getLoop(),
      });
      return DONE;
    },
  },

  // Note(yoochan.kim): answers once accepted; a measurement runs for minutes, and
  // how it goes is the levelMatch attribute's to say.
  matchTrackLevel: {
    async run(args, deps) {
      return deps.levelMatcher.start(args);
    },
  },

  stopLevelMatch: {
    async run(_args, deps) {
      return deps.levelMatcher.stop();
    },
  },
};

/** Command names this server implements, for the ready payload */
export const IMPLEMENTED_COMMANDS: readonly string[] = Object.keys(COMMAND_IMPL);
