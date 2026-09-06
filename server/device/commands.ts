import { RejectReason } from '../protocol.ts';
import type { CommandName } from '../protocol.ts';
import { ADMIN_CONFIG } from '../constants/authConfig.ts';
import { verifyPassword } from '../auth/password.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { runsOn } from '../schedule/Schedule.ts';
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
      const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
        await deps.mixerConsole.enable(input);
      });

      if (!allowed) {
        log.warn('command', socket, 'Console input blocked (admin lock)', { input });
        return refuse(RejectReason.ADMIN_LOCKED);
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
      const allowed = await deps.lockCoordinator.withAdminGate(isAdmin, async () => {
        await deps.mixerConsole.initialize();
      });

      if (!allowed) {
        log.warn('command', socket, 'Console initialize blocked (admin lock)');
        return refuse(RejectReason.ADMIN_LOCKED);
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
      deps.notifier.state({ trackVolumes: deps.trackLibrary.volumes() });
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
};

/** Command names this server implements, for the ready payload */
export const IMPLEMENTED_COMMANDS: readonly string[] = Object.keys(COMMAND_IMPL);
