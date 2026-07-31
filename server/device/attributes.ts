import { ATTRIBUTES, PlaybackState, isMuteState, isPlaybackState, isSongType } from '../protocol.ts';
import type { AttributeName, State, StatePatch } from '../protocol.ts';
import { DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.ts';
import type { ServerSocket } from '../constants/socketConfig.ts';
import type { ServerDeps } from '../deps.ts';

/**
 * How a writable attribute is applied. The value arrives untrusted, so parsing
 * and applying are kept together behind `prepare`: it narrows the value once
 * and hands back the work to run, or null when the value does not check out.
 * That keeps each attribute's own type private to its entry while the table
 * stays uniform for the write handler.
 */
export interface WriteSpec {
  /** Whether the change must hold the audio resource lock while it runs */
  holdsAudioLock: boolean;
  prepare(value: unknown, deps: ServerDeps): (() => Promise<StatePatch>) | null;
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
function writable<T>(
  holdsAudioLock: boolean,
  parse: (value: unknown) => T | null,
  apply: (value: T, deps: ServerDeps) => Promise<StatePatch>,
): WriteSpec {
  return {
    holdsAudioLock,
    prepare(value, deps) {
      const parsed = parse(value);
      // Compared against null explicitly: `false` is a legitimate value.
      return parsed === null ? null : () => apply(parsed, deps);
    },
  };
}

function parseVolume(value: unknown): number | null {
  const { min, max } = ATTRIBUTES.volume.range;
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  return valid ? value : null;
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
      (value) => (isPlaybackState(value) ? value : null),
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
    write: writable(true, parseVolume, async (volume, deps) => {
      deps.player.setVolume(volume);
      return { volume };
    }),
  },

  mute: {
    read: (deps) => deps.player.getMute(),
    write: writable(
      true,
      (value) => (isMuteState(value) ? value : null),
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
      (value) => (isSongType(value) ? value : null),
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
      (value) => (typeof value === 'boolean' ? value : null),
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
    // Note(yoochan.kim): the flow engine lands next; until then the server
    // simply reports that nothing is running.
    read: () => null,
  },
};

const ALL_ATTRIBUTES = Object.keys(ATTRIBUTE_IMPL) as AttributeName[];

/** Attribute names this server implements, for the ready payload */
export const IMPLEMENTED_ATTRIBUTES: readonly string[] = ALL_ATTRIBUTES;

/**
 * Reads attributes into a state patch. Unknown names are ignored rather than
 * refused: a read is a question, and answering the parts it understood is more
 * useful than answering none of it.
 */
export function readState(deps: ServerDeps, socket: ServerSocket, fields?: readonly string[]): StatePatch {
  const wanted = fields?.length ? ALL_ATTRIBUTES.filter((name) => fields.includes(name)) : ALL_ATTRIBUTES;
  const patch: Record<string, unknown> = {};
  for (const name of wanted) {
    patch[name] = ATTRIBUTE_IMPL[name].read(deps, socket);
  }
  // Safe by construction: every key comes from the attribute table.
  return patch as StatePatch;
}
