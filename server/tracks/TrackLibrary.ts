import fs from 'node:fs';
import path from 'node:path';
import type { SongId } from '../constants/songs.ts';
import type { Song, Track } from '../protocol.ts';

/** A library entry as stored here: the protocol's Track plus its file path */
export interface LibraryEntry extends Track {
  file: string;
  /** Present when this track is also one of the deck's songs */
  deck?: { volume: number };
}

/**
 * Track library: loads a JSON manifest at boot
 * (`[{ id, title, file, durationSec, deck? }]`, file paths relative to the
 * manifest) and fails fast on any invalid entry, matching the server's
 * no-defaults policy.
 *
 * It owns both catalogues. Every track can be scheduled by a flow; the ones
 * carrying a `deck` are additionally the songs a user picks between, in
 * manifest order and at the volume declared there. So adding a song is a line
 * of JSON and a restart — no code, and no release of any client.
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
      const { id, title, file, durationSec, deck } = entry as Record<string, unknown>;
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
      this.tracks.set(id, { id, title, file: resolvedFile, durationSec, ...parseDeck(deck, id) });
    }

    // Note(yoochan.kim): with no deck song the panel has nothing to play and
    // the deck no file to load, so an empty deck is a broken manifest
    if (this.deckSongs().length === 0) {
      throw new Error(`Track manifest declares no deck song: ${manifestPath}`);
    }
  }

  /** The songs a user picks between, named and ordered by the manifest */
  deckSongs(): Song[] {
    return this.deckEntries().map(({ id, title }) => ({ id, title }));
  }

  /** The song the deck starts on when nothing was restored */
  defaultSong(): SongId {
    return this.deckEntries()[0]!.id;
  }

  isDeckSong(id: unknown): id is SongId {
    return typeof id === 'string' && this.tracks.get(id)?.deck !== undefined;
  }

  /** The deck's audio files, one per song — the manifest owns these too */
  songFiles(): Record<SongId, string> {
    return Object.fromEntries(this.deckEntries().map((entry) => [entry.id, entry.file]));
  }

  /** The volume each song returns to when selected */
  songVolumes(): Record<SongId, number> {
    return Object.fromEntries(this.deckEntries().map((entry) => [entry.id, entry.deck!.volume]));
  }

  /** The client-facing slice: file paths never leave the server. */
  list(): Track[] {
    return [...this.tracks.values()].map(({ id, title, durationSec }) => ({ id, title, durationSec }));
  }

  get(id: string): LibraryEntry | undefined {
    return this.tracks.get(id);
  }

  private deckEntries(): LibraryEntry[] {
    return [...this.tracks.values()].filter((entry) => entry.deck !== undefined);
  }
}

function parseDeck(deck: unknown, id: string): { deck?: { volume: number } } {
  if (deck === undefined) return {};
  const volume = (deck as Record<string, unknown>)?.volume;
  if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new Error(`Deck song '${id}' needs an integer volume 0-100: ${JSON.stringify(deck)}`);
  }
  return { deck: { volume } };
}

export default TrackLibrary;
