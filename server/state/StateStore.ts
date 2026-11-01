import type { PlayerConfig } from '../constants/playerConfig.ts';
import type { DeskJournalEntry } from '../console/DeskHolds.ts';

/** Play/pause is left out: the server always boots paused, so a reboot never starts sound in the room. */
export type PersistedState = Pick<PlayerConfig, 'serverVolume' | 'muted' | 'currentSong'>;

export type PersistedAll = PersistedState & {
  clockOffsetSec: number;
  deskJournal: readonly DeskJournalEntry[];
};

export interface StateStore {
  /** Null when the file is absent or invalid. */
  load(): PersistedAll | null;
  /** Best-effort: implementations must not throw. */
  save(state: PersistedAll): void;
}
