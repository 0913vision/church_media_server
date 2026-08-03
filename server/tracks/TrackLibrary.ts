import fs from 'node:fs';
import path from 'node:path';
import { SongType } from '../constants/songs.ts';
import type { Song, Track } from '../protocol.ts';

/** A library entry as stored here: the protocol's Track plus its file path */
export interface LibraryEntry extends Track {
  file: string;
}

/**
 * Track library for scheduled flows: loads a JSON manifest
 * (`[{ id, title, file, durationSec }]`, file paths relative to the manifest)
 * at boot and fails fast on any invalid entry, matching the server's
 * no-defaults policy. The two-song system is untouched — this is an
 * additional catalog for admin-driven sequences.
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
      const { id, title, file, durationSec } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 ||
          typeof title !== 'string' || title.length === 0 ||
          typeof file !== 'string' || file.length === 0 ||
          typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid track entry in manifest: ${JSON.stringify(entry)}`);
      }
      if (this.tracks.has(id)) {
        throw new Error(`Duplicate track id in manifest: ${id}`);
      }
      const resolvedFile = path.resolve(manifestDir, file);
      if (!fs.existsSync(resolvedFile)) {
        throw new Error(`Track file not found: ${resolvedFile} (track ${id})`);
      }
      this.tracks.set(id, { id, title, file: resolvedFile, durationSec });
    }

    // Note(yoochan.kim): the manifest owns every display name. A deck song is
    // the entry whose id equals the song id, so a manifest without one cannot
    // name the deck and must not boot.
    for (const song of Object.values(SongType)) {
      if (!this.tracks.has(song)) {
        throw new Error(`Track manifest has no entry for deck song '${song}': ${manifestPath}`);
      }
    }
  }

  /** The two-song catalogue for ready, named by the manifest */
  songCatalogue(): Song[] {
    return Object.values(SongType).map((id) => ({ id, title: this.tracks.get(id)!.title }));
  }

  /** The client-facing slice: file paths never leave the server. */
  list(): Track[] {
    return [...this.tracks.values()].map(({ id, title, durationSec }) => ({ id, title, durationSec }));
  }

  get(id: string): LibraryEntry | undefined {
    return this.tracks.get(id);
  }
}

export default TrackLibrary;
