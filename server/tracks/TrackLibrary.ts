import fs from 'node:fs';
import path from 'node:path';
import type { SongId } from '../constants/songs.ts';
import type { Song, Track, TrackVolume } from '../protocol.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** A library entry as stored here: the protocol's Track plus what stays server-side */
export interface LibraryEntry extends Track {
  /** Absolute path to the audio */
  file: string;
  /** The path exactly as the manifest states it, so a rewrite says what was read */
  declaredFile: string;
  /** The level this audio sits at when nobody says otherwise */
  volume: number;
  /** Whether a person may pick this one at the panel */
  userSelectable: boolean;
}

/**
 * Track library: loads a JSON manifest at boot
 * (`[{ id, title, file, durationSec, volume, userSelectable? }]`, file paths
 * relative to the manifest) and fails fast on any invalid entry, matching the
 * server's no-defaults policy.
 *
 * Every entry is a piece of audio a flow can schedule, and carries the volume
 * it sounds at unless a flow says otherwise. `userSelectable` marks the ones a
 * person may also pick at the panel: those, in manifest order, are the deck's
 * songs. So the deck's size, order, names, files and levels are all data.
 *
 * Note(yoochan.kim): the manifest is the server's file, not a checked-in one — it is
 * kept out of git and rewritten here when a level changes. A level is the one
 * thing about a track somebody adjusts by ear, and putting it anywhere else
 * would leave two answers to "how loud is this song" free to disagree.
 */
class TrackLibrary {
  private readonly tracks = new Map<string, LibraryEntry>();

  constructor(private readonly manifestPath: string) {
    const manifestDir = path.dirname(manifestPath);
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`Track manifest must be a JSON array: ${manifestPath}`);
    }

    for (const entry of parsed) {
      const { id, title, file, durationSec, volume, userSelectable } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 ||
          typeof title !== 'string' || title.length === 0 ||
          typeof file !== 'string' || file.length === 0 ||
          typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid track entry in manifest: ${JSON.stringify(entry)}`);
      }
      if (!isLevel(volume)) {
        throw new Error(`Track '${id}' needs an integer volume 0-100: ${JSON.stringify(volume)}`);
      }
      if (userSelectable !== undefined && typeof userSelectable !== 'boolean') {
        throw new Error(`Track '${id}' has a non-boolean userSelectable: ${JSON.stringify(userSelectable)}`);
      }
      if (this.tracks.has(id)) {
        throw new Error(`Duplicate track id in manifest: ${id}`);
      }
      const resolvedFile = path.resolve(manifestDir, file);
      if (!fs.existsSync(resolvedFile)) {
        throw new Error(`Track file not found: ${resolvedFile} (track ${id})`);
      }
      this.tracks.set(id, {
        id, title, file: resolvedFile, declaredFile: file, durationSec, volume,
        userSelectable: userSelectable === true,
      });
    }

    // Note(yoochan.kim): with nothing user-selectable the panel has no song to
    // offer and the deck no file to load, so that is a broken manifest
    if (this.songs().length === 0) {
      throw new Error(`Track manifest declares no userSelectable track: ${manifestPath}`);
    }
  }

  /** The songs a user picks between, named and ordered by the manifest */
  deckSongs(): Song[] {
    return this.songs().map(({ id, title }) => ({ id, title }));
  }

  /** The song the deck starts on when nothing was restored */
  defaultSong(): SongId {
    return this.songs()[0]!.id;
  }

  isDeckSong(id: unknown): id is SongId {
    return typeof id === 'string' && this.tracks.get(id)?.userSelectable === true;
  }

  /** The deck's audio files, one per song — the manifest owns these too */
  songFiles(): Record<SongId, string> {
    return Object.fromEntries(this.songs().map((entry) => [entry.id, entry.file]));
  }

  /**
   * The level a track sounds at when nobody says otherwise: what a song returns
   * to when it is chosen, and what a library track is put on at.
   */
  volumeOf(id: string): number {
    const entry = this.tracks.get(id);
    if (!entry) {
      throw new Error(`No such track: ${id}`);
    }
    return entry.volume;
  }

  /** Every track's level, in manifest order */
  volumes(): TrackVolume[] {
    return [...this.tracks.values()].map(({ id, volume }) => ({ id, volume }));
  }

  /** Sets the level a track sounds at, from now on. The caller checks the id exists. */
  setVolume(id: string, volume: number): void {
    const entry = this.tracks.get(id);
    if (!entry || !isLevel(volume)) {
      return;
    }
    entry.volume = volume;
    this.persist();
  }

  /**
   * The client-facing slice: file paths stay here, and so does the level —
   * somebody adjusts that while clients are connected, so it travels as state.
   */
  list(): Track[] {
    return [...this.tracks.values()].map(({ id, title, durationSec }) => ({ id, title, durationSec }));
  }

  get(id: string): LibraryEntry | undefined {
    return this.tracks.get(id);
  }

  private songs(): LibraryEntry[] {
    return [...this.tracks.values()].filter((entry) => entry.userSelectable);
  }

  /**
   * Writes the manifest back: temp file then rename, the way the state file is
   * written, so a crash mid-write cannot leave a manifest that refuses the next
   * boot. Best-effort like that one — a level that failed to save still sounds.
   */
  private persist(): void {
    const entries = [...this.tracks.values()].map((entry) => ({
      id: entry.id,
      title: entry.title,
      file: entry.declaredFile,
      durationSec: entry.durationSec,
      volume: entry.volume,
      ...(entry.userSelectable ? { userSelectable: true } : {}),
    }));
    try {
      const tmp = `${this.manifestPath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.manifestPath);
    } catch (error) {
      log.error('trackLibrary', null, 'Failed to write track manifest', { error: errorMessage(error) });
    }
  }
}

function isLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export default TrackLibrary;
