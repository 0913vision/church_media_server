import type { PlayerConfig } from '../constants/playerConfig.ts';

/**
 * The slice of player state that survives a process restart / reboot.
 * Playback state (play/pause) is intentionally NOT persisted — the server
 * always boots PAUSED so a reboot can never blast audio unexpectedly.
 */
export type PersistedState = Pick<PlayerConfig, 'serverVolume' | 'muted' | 'currentSong'>;

/** Persists the player's preferences across process restarts / reboots. */
export interface StateStore {
  /** Returns the saved state, or null if absent or invalid. */
  load(): PersistedState | null;
  /** Persists the given state. Best-effort — implementations must not throw. */
  save(state: PersistedState): void;
}
