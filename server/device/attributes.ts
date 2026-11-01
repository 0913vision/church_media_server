import { ATTRIBUTES, PlaybackState, RejectReason, isMuteState, isPlaybackState } from '../protocol.ts';
import type { AttributeName, MusicEnd, State, StatePatch } from '../protocol.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';
import { isWireInstant } from '../utils/instant.ts';
import { HOLD_LIMIT_MS } from '../lock/AdminSession.ts';

/** Tagged so the caller must look at which it is, and so an attribute can say why it said no. */
export type WritePlan = { ok: true; apply: () => Promise<StatePatch> } | { ok: false; reason: RejectReason };

/** The value arrives untrusted, so prepare narrows it once and hands back the work to run. */
export interface WriteSpec {
  holdsAudioLock: boolean;
  prepare(value: unknown, deps: ServerDeps): WritePlan;
}

export interface AttributeSpec {
  read(deps: ServerDeps, socket: ServerSocket): State[AttributeName];
  write?: WriteSpec;
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };

function accept<T>(value: T): Checked<T> {
  return { ok: true, value };
}
function reject(reason: RejectReason): Checked<never> {
  return { ok: false, reason };
}
const BAD_VALUE = reject(RejectReason.INVALID_VALUE);

/** Closes over the attribute's own value type, so the table stays uniform for the write handler. */
function writable<T>(
  holdsAudioLock: boolean,
  check: (value: unknown, deps: ServerDeps) => Checked<T>,
  apply: (value: T, deps: ServerDeps) => Promise<StatePatch>,
): WriteSpec {
  return {
    holdsAudioLock,
    prepare(value, deps) {
      const checked = check(value, deps);
      return checked.ok ? { ok: true, apply: () => apply(checked.value, deps) } : checked;
    },
  };
}

/** A fader sends fractions: rounded to integers like track levels, not refused, as panels are installed by hand. */
function checkVolume(value: unknown): Checked<number> {
  const { min, max } = ATTRIBUTES.volume.range;
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  return valid ? accept(Math.round(value)) : BAD_VALUE;
}

/** Note(yoochan.kim): only while a run's music sounds; a run merely holding the gate leaves the deck free. */
function deckIsFlows(deps: ServerDeps): boolean {
  return deps.flowRunner.ownsDeck();
}

/** Who holds the deck instead of the panel; whoever it is puts it back itself. */
function deckTakenBy(deps: ServerDeps): Checked<never> | null {
  if (deckIsFlows(deps)) return reject(RejectReason.FLOW_ACTIVE);
  if (deps.levelMatcher.ownsDeck()) return reject(RejectReason.LEVEL_MATCHING);
  return null;
}

/** Note(yoochan.kim): a run holds the gate too, so "adminLock is true" never means a person may act mid-service. */
function gateIsFlows(deps: ServerDeps): boolean {
  return deps.flowRunner.ownsAdminLock();
}

/** Whether a *person* is holding the gate — the only case a session setting exists in. */
function personHoldsGate(deps: ServerDeps): boolean {
  return deps.adminSession.adminHold().kind === 'at';
}

function asMusicEnd(value: unknown, deps: ServerDeps): Checked<MusicEnd> {
  if (typeof value !== 'object' || value === null) return BAD_VALUE;
  const { kind, at } = value as Record<string, unknown>;
  if (kind === 'undecided' || kind === 'withHold') return accept({ kind });
  if (kind !== 'at' || !isWireInstant(at)) return BAD_VALUE;

  const when = new Date(at);
  const now = deps.clock.now();
  // Note(yoochan.kim): an end already gone by would fire the moment it landed.
  if (Number.isNaN(when.getTime()) || when <= now) return BAD_VALUE;
  // Note(yoochan.kim): one past the hour would make the gate wait beyond its limit.
  if (when.getTime() - now.getTime() > HOLD_LIMIT_MS) return BAD_VALUE;
  return accept({ kind: 'at', at });
}

/** Permission, access and range come from ATTRIBUTES and locking from the write handler; entries own the rest. */
export const ATTRIBUTE_IMPL: Record<AttributeName, AttributeSpec> = {
  playback: {
    read: (deps) => deps.player.getState(),
    write: writable(
      true,
      (value, deps) => {
        const taken = deckTakenBy(deps);
        if (taken) return taken;
        return isPlaybackState(value) ? accept(value) : BAD_VALUE;
      },
      async (playback, deps) => {
        if (playback === deps.player.getState()) return {};
        if (playback === PlaybackState.PLAYING) {
          // Note(yoochan.kim): app songs fade in even from the start: one begun at full level startles the room.
          const deck = deps.player.getDeck();
          const appSong = deck.source === 'song' || deps.trackLibrary.isDeckSong(deck.id);
          await deps.player.play({ onSounding: () => deps.notifier.state({ playback }), fadeFromStart: appSong });
          return {};
        }
        await deps.player.pause();
        return { playback };
      },
    ),
  },

  volume: {
    read: (deps) => deps.player.getVolume(),
    // Note(yoochan.kim): no lock per write, or audioLock would flap for every client on every drag tick.
    write: writable(
      false,
      (value, deps) => {
        const taken = deckTakenBy(deps);
        if (taken) return taken;
        // Note(yoochan.kim): an instant write only has to stay out of a running fade.
        if (deps.lockCoordinator.getLockState().audio) return reject(RejectReason.DEVICE_BUSY);
        return checkVolume(value);
      },
      async (volume, deps) => {
        deps.player.setVolume(volume);
        return { volume };
      },
    ),
  },

  mute: {
    read: (deps) => deps.player.getMute(),
    write: writable(
      false,
      (value, deps) => {
        const taken = deckTakenBy(deps);
        if (taken) return taken;
        if (deps.lockCoordinator.getLockState().audio) return reject(RejectReason.DEVICE_BUSY);
        return isMuteState(value) ? accept(value) : BAD_VALUE;
      },
      async (mute, deps) => {
        if (mute === deps.player.getMute()) return {};
        deps.player.setMute(mute);
        return { mute };
      },
    ),
  },

  song: {
    read: (deps) => deps.player.getCurrentSong(),
    write: writable(
      true,
      (value, deps) => {
        const taken = deckTakenBy(deps);
        if (taken) return taken;
        return deps.trackLibrary.isDeckSong(value) ? accept(value) : BAD_VALUE;
      },
      async (song, deps) => {
        if (song === deps.player.getCurrentSong() && deps.player.getDeck().source === 'song') return {};
        // Note(yoochan.kim): takes the deck back from any track an admin put on, which also restores looping.
        await deps.player.restoreSong();
        await deps.player.changeSong(song);
        // Note(yoochan.kim): a song change also pauses and moves the volume, so one patch carries them all.
        return {
          song,
          playback: PlaybackState.PAUSED,
          volume: deps.trackLibrary.volumeOf(song),
          deck: deps.player.getDeck(),
          loop: deps.player.getLoop(),
        };
      },
    ),
  },

  loop: {
    read: (deps) => deps.player.getLoop(),
    write: writable(
      false,
      (value, deps) => {
        if (typeof value !== 'boolean') return BAD_VALUE;
        // Note(yoochan.kim): the panel's songs must run without ending, so only a held gate may change it.
        if (!deps.lockCoordinator.getLockState().admin) return reject(RejectReason.ADMIN_UNLOCKED);
        // Note(yoochan.kim): a run's track set to repeat would never end, and neither would its timeline.
        const taken = deckTakenBy(deps);
        if (taken) return taken;
        return accept(value);
      },
      async (loop, deps) => {
        deps.player.setLoop(loop);
        deps.adminSession.sync();
        return { loop };
      },
    ),
  },

  tracks: {
    read: (deps) => deps.trackLibrary.list(),
  },

  trackFetch: {
    read: (deps) => deps.fetcher.status(),
  },

  levelMatch: {
    read: (deps) => deps.levelMatcher.current(),
  },

  schedule: {
    read: (deps) => deps.schedule.list(),
  },

  deck: {
    read: (deps) => deps.player.getDeck(),
  },

  unlockWhenDone: {
    read: (deps) => deps.adminSession.isArmed(),
    write: writable(
      false,
      (value, deps) => {
        if (typeof value !== 'boolean') return BAD_VALUE;
        // Note(yoochan.kim): a setting on a person's hold; a run's gate has no hold to arm.
        if (gateIsFlows(deps)) return reject(RejectReason.FLOW_ACTIVE);
        if (!personHoldsGate(deps)) return reject(RejectReason.ADMIN_UNLOCKED);
        return accept(value);
      },
      async (unlockWhenDone, deps) => {
        deps.adminSession.setUnlockWhenDone(unlockWhenDone);
        return { unlockWhenDone };
      },
    ),
  },

  musicEndsAt: {
    read: (deps) => deps.adminSession.musicEndsAt(),
    write: writable(
      false,
      (value, deps) => {
        // Note(yoochan.kim): like unlockWhenDone, it belongs to a person's hold.
        if (gateIsFlows(deps)) return reject(RejectReason.FLOW_ACTIVE);
        if (!personHoldsGate(deps)) return reject(RejectReason.ADMIN_UNLOCKED);
        const parsed = asMusicEnd(value, deps);
        return parsed.ok ? parsed : BAD_VALUE;
      },
      async (end, deps) => {
        deps.adminSession.setMusicEndsAt(end);
        return { musicEndsAt: deps.adminSession.musicEndsAt() };
      },
    ),
  },

  adminHold: {
    read: (deps) => deps.adminSession.adminHold(),
  },

  adminLock: {
    read: (deps) => deps.lockCoordinator.getLockState().admin,
    // Note(yoochan.kim): no audio lock: the gate decides who may start work and never touches the device.
    write: writable(
      false,
      (value, deps) => {
        if (typeof value !== 'boolean') return BAD_VALUE;
        // Note(yoochan.kim): toggled here, a run would describe a gate that is gone; stopping the run is the way out.
        if (deps.flowRunner.ownsAdminLock()) return reject(RejectReason.FLOW_ACTIVE);
        return accept(value);
      },
      async (adminLock, deps) => {
        // Note(yoochan.kim): put back before the gate opens: the panel must never open onto a deck it did not choose.
        const patch: StatePatch = {};
        if (!adminLock) {
          if (deps.player.getDeck().source === 'track') {
            await deps.player.restoreSong();
            patch.deck = deps.player.getDeck();
            patch.playback = deps.player.getState();
            patch.volume = deps.player.getVolume();
          }
          // Note(yoochan.kim): the gate's choices go back even with no track put on; the panel's songs loop again.
          deps.player.setLoop(true);
          deps.adminSession.reset();
          patch.loop = true;
          patch.unlockWhenDone = false;
        } else {
          // Note(yoochan.kim): the hour starts here; a flow names its own window and never reaches this write.
          deps.adminSession.engage();
        }
        // Note(yoochan.kim): the lock announces its own change, so adminLock stays out of this patch.
        deps.lockCoordinator.setAdminLock(adminLock);
        patch.musicEndsAt = deps.adminSession.musicEndsAt();
        patch.adminHold = deps.adminSession.adminHold();
        return patch;
      },
    ),
  },

  audioLock: {
    read: (deps) => deps.lockCoordinator.getLockState().audio,
  },

  isAdmin: {
    read: (deps, socket) => deps.adminSessionManager.isAdminSocket(socket),
  },

  flow: {
    // Note(yoochan.kim): Read-only: startFlow and stopFlow are what move it.
    read: (deps) => deps.flowRunner.status(),
  },

  clockOffsetSec: {
    read: (deps) => deps.clock.offset(),
    // Note(yoochan.kim): no audio lock: this moves the reference every instant is read against, not the device.
    write: writable(
      false,
      (value, deps) => {
        const { min, max } = ATTRIBUTES.clockOffsetSec.range;
        if (typeof value !== 'number' || !Number.isFinite(value)) return BAD_VALUE;
        if (value < min || value > max) return BAD_VALUE;
        // Note(yoochan.kim): a run holds the gate throughout, so this keeps the clock from moving under its music.
        if (deps.lockCoordinator.getLockState().admin) return reject(RejectReason.ADMIN_LOCKED);
        // Note(yoochan.kim): to the millisecond; whole seconds could leave it half a second off the wall clock.
        return accept(Math.round(value * 1000) / 1000);
      },
      async (clockOffsetSec, deps) => {
        deps.clock.setOffset(clockOffsetSec);
        return { clockOffsetSec };
      },
    ),
  },

  console: {
    read: (deps) => deps.mixerConsole.read(),
  },
};

const ALL_ATTRIBUTES = Object.keys(ATTRIBUTE_IMPL) as AttributeName[];

export const IMPLEMENTED_ATTRIBUTES: readonly string[] = ALL_ATTRIBUTES;

export function readState(deps: ServerDeps, socket: ServerSocket): StatePatch {
  const patch: Record<string, unknown> = {};
  for (const name of ALL_ATTRIBUTES) {
    patch[name] = ATTRIBUTE_IMPL[name].read(deps, socket);
  }
  // Note(yoochan.kim): Safe by construction: every key comes from the attribute table.
  return patch as StatePatch;
}
