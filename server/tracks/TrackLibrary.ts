import fs from 'node:fs';
import path from 'node:path';
import type { SongId } from '../constants/songs.ts';
import type { Song, Track } from '../protocol.ts';

/** A library entry as stored here: the protocol's Track plus what stays server-side */
export interface LibraryEntry extends Track {
  file: string;
  /** The level this audio sits at, whoever plays it */
  volume: number;
  /** Whether a person may pick this one at the panel */
  selectable: boolean;
}

/**
 * Track library: loads a JSON manifest at boot
 * (`[{ id, title, file, durationSec, volume, selectable? }]`, file paths
 * relative to the manifest) and fails fast on any invalid entry, matching the
 * server's no-defaults policy.
 *
 * Every entry is a piece of audio a flow can schedule, and carries the volume
 * it should sound at. `selectable` marks the ones a person may also pick at the
 * panel: those, in manifest order, are the deck's songs. So the deck's size,
 * order, names, files and levels are all data — adding a song is a line of JSON
 * and a restart, with no code and no client release.
 */
class TrackLibrary {
  private readonly tracks = new Map<string, LibraryEntry>();

  constructor(manifestPath: string) {
    const manifestDir = path.dirname(manifestPath);
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`Track manifest must be a JSON array: ${manifestPath}`);
    }

    for (const entry of parsed) {
      const { id, title, file, durationSec, volume, selectable } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 ||
          typeof title !== 'string' || title.length === 0 ||
          typeof file !== 'string' || file.length === 0 ||
          typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid track entry in manifest: ${JSON.stringify(entry)}`);
      }
      if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
        throw new Error(`Track '${id}' needs an integer volume 0-100: ${JSON.stringify(volume)}`);
      }
      if (selectable !== undefined && typeof selectable !== 'boolean') {
        throw new Error(`Track '${id}' has a non-boolean selectable: ${JSON.stringify(selectable)}`);
      }
      if (this.tracks.has(id)) {
        throw new Error(`Duplicate track id in manifest: ${id}`);
      }
      const resolvedFile = path.resolve(manifestDir, file);
      if (!fs.existsSync(resolvedFile)) {
        throw new Error(`Track file not found: ${resolvedFile} (track ${id})`);
      }
      this.tracks.set(id, {
        id, title, file: resolvedFile, durationSec, volume, selectable: selectable === true,
      });
    }

    // Note(yoochan.kim): with nothing selectable the panel has no song to offer
    // and the deck no file to load, so an empty deck is a broken manifest
    if (this.songs().length === 0) {
      throw new Error(`Track manifest declares no selectable track: ${manifestPath}`);
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
    return typeof id === 'string' && this.tracks.get(id)?.selectable === true;
  }

  /** The deck's audio files, one per song — the manifest owns these too */
  songFiles(): Record<SongId, string> {
    return Object.fromEntries(this.songs().map((entry) => [entry.id, entry.file]));
  }

  /** The volume each song returns to when selected */
  songVolumes(): Record<SongId, number> {
    return Object.fromEntries(this.songs().map((entry) => [entry.id, entry.volume]));
  }

  /** The client-facing slice: file paths and levels never leave the server. */
  list(): Track[] {
    return [...this.tracks.values()].map(({ id, title, durationSec }) => ({ id, title, durationSec }));
  }

  get(id: string): LibraryEntry | undefined {
    return this.tracks.get(id);
  }

  private songs(): LibraryEntry[] {
    return [...this.tracks.values()].filter((entry) => entry.selectable);
  }
}

export default TrackLibrary;
