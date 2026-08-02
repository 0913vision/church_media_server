import { ATTRIBUTES, PlaybackState, RejectReason, isMuteState, isPlaybackState } from '../protocol.ts';
import { isSongType } from '../constants/songs.ts';
import type { AttributeName, State, StatePatch } from '../protocol.ts';
import { DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';

/**
 * The outcome of checking a value: either work to run, or a refusal with its
 * reason. Tagged rather than "a thunk, or nothing", so the caller has to look
 * at which it is — and so an attribute can say *why* it said no.
 */
export type WritePlan = { ok: true; apply: () => Promise<StatePatch> } | { ok: false; reason: RejectReason };

/**
 * How a writable attribute is applied. The value arrives untrusted, so parsing
 * and applying are kept together behind `prepare`: it narrows the value once
 * and hands back the work to run. That keeps each attribute's own type private
 * to its entry while the table stays uniform for the write handler.
 */
export interface WriteSpec {
  /** Whether the change must hold the audio resource lock while it runs */
  holdsAudioLock: boolean;
  prepare(value: unknown, deps: ServerDeps): WritePlan;
}

export interface AttributeSpec {
  read(deps: ServerDeps, socket: ServerSocket): State[AttributeName];
  /** Absent for read-only attributes */
  write?: WriteSpec;
}

/** A checked value, or a refusal — the parse half of a write */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };

function accept<T>(value: T): Checked<T> {
  return { ok: true, value };
}
function reject(reason: RejectReason): Checked<never> {
  return { ok: false, reason };
}
/** The usual refusal: the value itself does not check out */
const BAD_VALUE = reject(RejectReason.INVALID_VALUE);

/**
 * Builds a write entry, closing over the attribute's own value type so the
 * table below can stay uniform in the value position.
 */
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

function checkVolume(value: unknown): Checked<number> {
  const { min, max } = ATTRIBUTES.volume.range;
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  return valid ? accept(value) : BAD_VALUE;
}

/**
 * The device's attribute table: one entry per attribute in the protocol, so an
 * attribute cannot be declared without being implemented. Each entry owns its
 * validation and its side effects; the permission, access and range rules come
 * from the generated ATTRIBUTES metadata, and locking is applied by the write
 * handler.
 */
export const ATTRIBUTE_IMPL: Record<AttributeName, AttributeSpec> = {
  playback: {
    read: (deps) => deps.player.getState(),
    write: writable(
      true,
      (value) => (isPlaybackState(value) ? accept(value) : BAD_VALUE),
      async (playback, deps) => {
        if (playback === deps.player.getState()) return {};
        if (playback === PlaybackState.PLAYING) {
          await deps.player.play();
        } else {
          await deps.player.pause();
        }
        return { playback };
      },
    ),
  },

  volume: {
    read: (deps) => deps.player.getVolume(),
    write: writable(true, checkVolume, async (volume, deps) => {
      deps.player.setVolume(volume);
      return { volume };
    }),
  },

  mute: {
    read: (deps) => deps.player.getMute(),
    write: writable(
      true,
      (value) => (isMuteState(value) ? accept(value) : BAD_VALUE),
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
      (value) => (isSongType(value) ? accept(value) : BAD_VALUE),
      async (song, deps) => {
        if (song === deps.player.getCurrentSong()) return {};
        // Note(yoochan.kim): Switching songs also pauses the deck and moves the volume to that
        // song's default, so all three are reported together.
        await deps.player.changeSong(song);
        return { song, playback: PlaybackState.PAUSED, volume: DEFAULT_SONG_VOLUMES[song] };
      },
    ),
  },

  adminLock: {
    read: (deps) => deps.lockCoordinator.getLockState().admin,
    // Note(yoochan.kim): No audio lock: the gate decides who may start work, it does not touch
    // the device. The lock announces its own transitions, so the patch is empty.
    write: writable(
      false,
      (value, deps) => {
        if (typeof value !== 'boolean') return BAD_VALUE;
        // Note(yoochan.kim): A running flow owns the lock it engaged. Letting it be toggled from
        // outside would leave the flow describing a gate that is not there;
        // stopping the flow is the way out.
        if (deps.flowRunner.ownsAdminLock()) return reject(RejectReason.FLOW_ACTIVE);
        return accept(value);
      },
      async (adminLock, deps) => {
        deps.lockCoordinator.setAdminLock(adminLock);
        return {};
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
    // Note(yoochan.kim): No audio lock: this moves the reference every instant is read against,
    // not the device.
    write: writable(
      false,
      (value, deps) => {
        const { min, max } = ATTRIBUTES.clockOffsetSec.range;
        if (typeof value !== 'number' || !Number.isFinite(value)) return BAD_VALUE;
        if (value < min || value > max) return BAD_VALUE;
        // Note(yoochan.kim): A flow holds the gate for its whole run, so refusing while the gate
        // is held is what makes it impossible to move the clock out from under
        // music that is already playing. The music timeline is derived from
        // instants; shifting the reference would drag the next track with it.
        if (deps.lockCoordinator.getLockState().admin) return reject(RejectReason.ADMIN_LOCKED);
        return accept(Math.round(value));
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

/** Attribute names this server implements, for the ready payload */
export const IMPLEMENTED_ATTRIBUTES: readonly string[] = ALL_ATTRIBUTES;

/** Reads every attribute into a full state patch. */
export function readState(deps: ServerDeps, socket: ServerSocket): StatePatch {
  const patch: Record<string, unknown> = {};
  for (const name of ALL_ATTRIBUTES) {
    patch[name] = ATTRIBUTE_IMPL[name].read(deps, socket);
  }
  // Note(yoochan.kim): Safe by construction: every key comes from the attribute table.
  return patch as StatePatch;
}
