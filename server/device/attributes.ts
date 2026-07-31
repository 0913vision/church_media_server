import { ATTRIBUTES, PlaybackState, isMuteState, isPlaybackState, isSongType } from '../protocol.ts';
import type { AttributeName, State, StatePatch } from '../protocol.ts';
import { DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';

/**
 * The outcome of checking a value: either work to run, or a refusal. Tagged
 * rather than "a thunk, or nothing", so the caller has to look at which it is.
 */
export type WritePlan = { ok: true; apply: () => Promise<StatePatch> } | { ok: false };

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

/**
 * Builds a write entry, closing over the attribute's own value type so the
 * table above it can stay untyped in the value position.
 */
/** A checked value, or a refusal — the parse half of a write */
type Checked<T> = { ok: true; value: T } | { ok: false };

function accept<T>(value: T): Checked<T> {
  return { ok: true, value };
}
const REJECT: Checked<never> = { ok: false };

function writable<T>(
  holdsAudioLock: boolean,
  check: (value: unknown) => Checked<T>,
  apply: (value: T, deps: ServerDeps) => Promise<StatePatch>,
): WriteSpec {
  return {
    holdsAudioLock,
    prepare(value, deps) {
      const checked = check(value);
      return checked.ok ? { ok: true, apply: () => apply(checked.value, deps) } : { ok: false };
    },
  };
}

function checkVolume(value: unknown): Checked<number> {
  const { min, max } = ATTRIBUTES.volume.range;
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  return valid ? accept(value) : REJECT;
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
      (value) => (isPlaybackState(value) ? accept(value) : REJECT),
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
      (value) => (isMuteState(value) ? accept(value) : REJECT),
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
      (value) => (isSongType(value) ? accept(value) : REJECT),
      async (song, deps) => {
        if (song === deps.player.getCurrentSong()) return {};
        // Switching songs also pauses the deck and moves the volume to that
        // song's default, so all three are reported together.
        await deps.player.changeSong(song);
        return { song, playback: PlaybackState.PAUSED, volume: DEFAULT_SONG_VOLUMES[song] };
      },
    ),
  },

  adminLock: {
    read: (deps) => deps.lockCoordinator.getLockState().admin,
    // No audio lock: the gate decides who may start work, it does not touch
    // the device. The lock announces its own transitions, so the patch is empty.
    write: writable(
      false,
      (value) => (typeof value === 'boolean' ? accept(value) : REJECT),
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
    // Note(yoochan.kim): the flow engine lands next; until then the slot is
    // always idle, which is a value rather than an absence.
    read: () => ({ phase: 'idle' }),
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
  // Safe by construction: every key comes from the attribute table.
  return patch as StatePatch;
}
