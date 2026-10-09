import type { PlayerConfig } from '../constants/playerConfig.ts';
import type { DeskJournalEntry } from '../console/DeskHolds.ts';

/**
 * The slice of player state that survives a process restart / reboot.
 * Playback state (play/pause) is intentionally NOT persisted — the server
 * always boots PAUSED so a reboot can never blast audio unexpectedly.
 */
export type PersistedState = Pick<PlayerConfig, 'serverVolume' | 'muted' | 'currentSong'>;

/**
 * Everything the file holds: the player's preferences, the church clock, and
 * whatever part of the desk a hold still has to put back.
 */
export type PersistedAll = PersistedState & {
  clockOffsetSec: number;
  deskJournal: readonly DeskJournalEntry[];
};

/** Persists the player's preferences across process restarts / reboots. */
export interface StateStore {
  /** Returns the saved state, or null if absent or invalid. */
  load(): PersistedAll | null;
  /** Persists the given state. Best-effort — implementations must not throw. */
  save(state: PersistedAll): void;
}
