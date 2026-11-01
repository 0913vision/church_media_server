import fs from 'node:fs';
import path from 'node:path';
import { isMuteState } from '../protocol.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { StateStore, PersistedState, PersistedAll } from './StateStore.ts';
import type { DeskJournalEntry } from '../console/DeskHolds.ts';

class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedAll | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Note(yoochan.kim): a missing file is the normal first boot.
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!this.isValid(parsed)) {
        log.warn('stateStore', null, 'Persisted state invalid, ignoring', { filePath: this.filePath });
        return null;
      }
      const offset = (parsed as Record<string, unknown>).clockOffsetSec;
      return {
        serverVolume: parsed.serverVolume,
        muted: parsed.muted,
        currentSong: parsed.currentSong,
        // Note(yoochan.kim): a file written before the clock existed declares no correction, which is what 0 means.
        clockOffsetSec: typeof offset === 'number' && Number.isFinite(offset) ? offset : 0,
        deskJournal: this.deskJournal((parsed as Record<string, unknown>).deskJournal),
      };
    } catch (error) {
      log.error('stateStore', null, 'Failed to read persisted state', { error: errorMessage(error) });
      return null;
    }
  }

  save(state: PersistedAll): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Note(yoochan.kim): temp file then rename, so a crash mid-write cannot corrupt the file.
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // Note(yoochan.kim): Persistence is best-effort: a write failure must never break playback.
      log.error('stateStore', null, 'Failed to persist state', { error: errorMessage(error) });
    }
  }

  /** A damaged journal is reported and dropped rather than costing the preferences beside it. */
  private deskJournal(value: unknown): DeskJournalEntry[] {
    if (value === undefined) return [];
    const isEntry = (entry: unknown): entry is DeskJournalEntry => {
      const e = entry as Record<string, unknown> | null;
      const original = e?.original as Record<string, unknown> | undefined;
      return typeof e?.address === 'string'
        && e.address.startsWith('/')
        && (original?.type === 'i' || original?.type === 'f')
        && typeof original.value === 'number'
        && Number.isFinite(original.value);
    };
    if (Array.isArray(value) && value.every(isEntry)) return value;
    log.error('stateStore', null, 'Desk journal unreadable; the desk may not be where it was', { filePath: this.filePath });
    return [];
  }

  private isValid(value: unknown): value is PersistedState {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v.serverVolume === 'number'
      && Number.isFinite(v.serverVolume)
      && v.serverVolume >= 0 && v.serverVolume <= 100
      && isMuteState(v.muted)
      // Note(yoochan.kim): checked against the manifest at boot, so a rewritten manifest cannot void the whole file.
      && typeof v.currentSong === 'string';
  }
}

export default FileStateStore;
