import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SongId } from '../constants/songs.ts';
import { TRACK_CONFIG } from '../constants/trackConfig.ts';
import type { Song, Track } from '../protocol.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** A library entry as stored here: the protocol's Track plus what stays server-side */
export interface LibraryEntry extends Track {
  /** Absolute path to the audio */
  file: string;
  /** The path exactly as the manifest states it, so a rewrite says what was read */
  declaredFile: string;
  /** Whether a person may pick this one at the panel */
  userSelectable: boolean;
}

/**
 * How a file still arriving in the audio folder is named, so a boot can tell it
 * apart — whatever comes after the base, since a fetcher writes its own steps.
 */
const STAGING = /^\.incoming-[0-9a-f]+\./;

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
 * kept out of git and rewritten here when a track is renamed or deleted or its
 * level changes. A level is the one
 * thing about a track somebody adjusts by ear, and putting it anywhere else
 * would leave two answers to "how loud is this song" free to disagree.
 */
class TrackLibrary {
  private readonly tracks = new Map<string, LibraryEntry>();
  private readonly audioDir: string;

  /**
   * @param audioDir - Where the server keeps audio it owns. Deleting a track
   *   deletes its file only from here: a manifest may name audio anywhere, and
   *   what the server did not put there is not the server's to remove.
   */
  constructor(private readonly manifestPath: string, audioDir: string) {
    this.audioDir = path.resolve(audioDir);
    if (!fs.statSync(this.audioDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Track audio directory not found: ${this.audioDir}`);
    }
    // Note(yoochan.kim): a file still arriving when the server stopped never became a track
    for (const name of fs.readdirSync(this.audioDir)) {
      if (STAGING.test(name)) fs.rmSync(path.join(this.audioDir, name), { force: true });
    }

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
   * A fresh name in the audio folder for a file on its way in, without an
   * extension: the caller adds its own, and everything under it is cleared at boot.
   */
  stagingBase(): string {
    return path.join(this.audioDir, `.incoming-${randomBytes(6).toString('hex')}`);
  }

  /**
   * Makes a new track of a file waiting at a staging path: the file moves into
   * the audio folder under the track's id, and the manifest is written, so the
   * next boot has it too. Starts at the level every new track starts at.
   */
  add(staged: string, title: string, durationSec: number): LibraryEntry {
    const id = this.freshId();
    const file = path.join(this.audioDir, `${id}.mp3`);
    fs.renameSync(staged, file);

    const entry: LibraryEntry = {
      id, title, file, durationSec,
      declaredFile: `./${path.relative(path.dirname(this.manifestPath), file)}`,
      volume: TRACK_CONFIG.NEW_TRACK_VOLUME,
      userSelectable: false,
    };
    this.tracks.set(id, entry);
    this.persist();
    return entry;
  }

  /** Renames a track. The caller checks the id exists and is not a deck song. */
  rename(id: string, title: string): void {
    const entry = this.tracks.get(id);
    if (!entry) return;
    entry.title = title;
    this.persist();
  }

  /**
   * Takes a track out of the library, then deletes its audio. The caller checks
   * that nothing still needs it.
   */
  remove(id: string): void {
    const entry = this.tracks.get(id);
    if (!entry) return;
    this.tracks.delete(id);

    // Note(yoochan.kim): a manifest that failed to save still names the file, and the
    // next boot refuses a track whose file is gone
    if (!this.persist()) return;
    if (!this.owns(entry.file)) return;
    try {
      fs.unlinkSync(entry.file);
    } catch (error) {
      log.warn('trackLibrary', null, 'Failed to delete track audio', { file: entry.file, error: errorMessage(error) });
    }
  }

  /** The client-facing slice: everything but where the audio lives. */
  list(): Track[] {
    return [...this.tracks.values()].map(({ id, title, durationSec, volume }) => ({ id, title, durationSec, volume }));
  }

  get(id: string): LibraryEntry | undefined {
    return this.tracks.get(id);
  }

  private songs(): LibraryEntry[] {
    return [...this.tracks.values()].filter((entry) => entry.userSelectable);
  }

  /** An id nothing uses yet, which also names its file. */
  private freshId(): string {
    for (;;) {
      const id = `track-${randomBytes(4).toString('hex')}`;
      if (!this.tracks.has(id) && !fs.existsSync(path.join(this.audioDir, `${id}.mp3`))) return id;
    }
  }

  /** Whether a file is the server's to delete: in its audio directory, and named by no other track. */
  private owns(file: string): boolean {
    const inside = path.relative(this.audioDir, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return false;
    return ![...this.tracks.values()].some((entry) => entry.file === file);
  }

  /**
   * Writes the manifest back: temp file then rename, the way the state file is
   * written, so a crash mid-write cannot leave a manifest that refuses the next
   * boot. Best-effort like that one — a level that failed to save still sounds.
   * Says whether it was written, for a change that must not outrun the disk.
   */
  private persist(): boolean {
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
      return true;
    } catch (error) {
      log.error('trackLibrary', null, 'Failed to write track manifest', { error: errorMessage(error) });
      return false;
    }
  }
}

function isLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export default TrackLibrary;
