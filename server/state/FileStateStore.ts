import fs from 'node:fs';
import path from 'node:path';
import { isMuteState, isSongType } from '../constants/playerStates.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { StateStore, PersistedState } from './StateStore.ts';

/**
 * File-backed StateStore: a small JSON document written atomically
 * (temp file + rename) so a crash mid-write can never corrupt it. A missing
 * or invalid file is treated as "no saved state" (normal first boot).
 */
class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedState | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return null; // missing file — the normal first-boot case
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!this.isValid(parsed)) {
        log.warn('stateStore', null, 'Persisted state invalid, ignoring', { filePath: this.filePath });
        return null;
      }
      return { serverVolume: parsed.serverVolume, muted: parsed.muted, currentSong: parsed.currentSong };
    } catch (error) {
      log.error('stateStore', null, 'Failed to read persisted state', { error: errorMessage(error) });
      return null;
    }
  }

  save(state: PersistedState): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // Persistence is best-effort: a write failure must never break playback.
      log.error('stateStore', null, 'Failed to persist state', { error: errorMessage(error) });
    }
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
      && isSongType(v.currentSong);
  }
}

export default FileStateStore;
