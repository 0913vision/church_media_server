import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SongId } from '../constants/songs.ts';
import { TRACK_CONFIG } from '../constants/trackConfig.ts';
import { TrackRoleKind } from '../protocol.ts';
import type { Song, Track, TrackRole } from '../protocol.ts';
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

/** Whatever follows the base matches, since a fetcher writes intermediate files of its own. */
const STAGING = /^\.incoming-[0-9a-f]+\./;

/** Note(yoochan.kim): the manifest is the server's file, rewritten here, and the one place a track's level is kept. */
class TrackLibrary {
  private readonly tracks = new Map<string, LibraryEntry>();
  private readonly audioDir: string;

  /** @param audioDir - deleting a track removes its file only from here, as audio elsewhere is not the server's. */
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
      const { id, title, file, durationSec, volume, userSelectable, role } = entry as Record<string, unknown>;
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
      const trackRole = roleOf(id, role);
      if (trackRole.kind !== TrackRoleKind.MUSIC && userSelectable === true) {
        throw new Error(`Track '${id}' is a countdown's ${describe(trackRole)} and cannot be a deck song too`);
      }
      if (trackRole.kind !== TrackRoleKind.MUSIC && [...this.tracks.values()].some((each) => sameRole(each.role, trackRole))) {
        throw new Error(`Two tracks in the manifest are the countdown's ${describe(trackRole)}`);
      }
      if (this.tracks.has(id)) {
        throw new Error(`Duplicate track id in manifest: ${id}`);
      }
      if (this.titleTaken(title)) {
        throw new Error(`Duplicate track title in manifest: ${title}`);
      }
      const resolvedFile = path.resolve(manifestDir, file);
      if (!fs.existsSync(resolvedFile)) {
        throw new Error(`Track file not found: ${resolvedFile} (track ${id})`);
      }
      this.tracks.set(id, {
        id, title, file: resolvedFile, declaredFile: file, durationSec, volume,
        userSelectable: userSelectable === true,
        role: trackRole,
      });
    }

    // Note(yoochan.kim): with nothing user-selectable the panel has no song to offer and the deck no file to load.
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

  /** Whether a track is a countdown's audio, which only a flow's countdown plays. */
  isCountdownTrack(id: string): boolean {
    const role = this.tracks.get(id)?.role;
    return role !== undefined && role.kind !== TrackRoleKind.MUSIC;
  }

  countTrack(): LibraryEntry | undefined {
    return [...this.tracks.values()].find((entry) => entry.role.kind === TrackRoleKind.COUNT);
  }

  noticeTrack(beforeSec: number): LibraryEntry | undefined {
    return [...this.tracks.values()].find((entry) => sameRole(entry.role, { kind: TrackRoleKind.NOTICE, beforeSec }));
  }

  /** The deck's audio files, one per song — the manifest owns these too */
  songFiles(): Record<SongId, string> {
    return Object.fromEntries(this.songs().map((entry) => [entry.id, entry.file]));
  }

  /** What a song returns to when it is chosen, and what a library track is put on at. */
  volumeOf(id: string): number {
    const entry = this.tracks.get(id);
    if (!entry) {
      throw new Error(`No such track: ${id}`);
    }
    return entry.volume;
  }

  /** The caller checks the id exists. */
  setVolume(id: string, volume: number): void {
    const entry = this.tracks.get(id);
    if (!entry || !isLevel(volume)) {
      return;
    }
    entry.volume = volume;
    this.persist();
  }

  /** No extension: the caller adds its own, and everything under it is cleared at boot. */
  stagingBase(): string {
    return path.join(this.audioDir, `.incoming-${randomBytes(6).toString('hex')}`);
  }

  add(staged: string, title: string, durationSec: number): LibraryEntry {
    const id = this.freshId();
    const file = path.join(this.audioDir, `${id}.mp3`);
    fs.renameSync(staged, file);

    const entry: LibraryEntry = {
      id, title, file, durationSec,
      declaredFile: `./${path.relative(path.dirname(this.manifestPath), file)}`,
      volume: TRACK_CONFIG.NEW_TRACK_VOLUME,
      userSelectable: false,
      role: { kind: TrackRoleKind.MUSIC },
    };
    this.tracks.set(id, entry);
    this.persist();
    return entry;
  }

  /** A title is how a person picks a track out of a list, so two the same could not be told apart. */
  titleTaken(title: string, except?: string): boolean {
    return [...this.tracks.values()].some((entry) => entry.title === title && entry.id !== except);
  }

  /** The caller checks the id exists and is not a deck song. */
  rename(id: string, title: string): void {
    const entry = this.tracks.get(id);
    if (!entry) return;
    entry.title = title;
    this.persist();
  }

  /** The caller checks that nothing still needs it. */
  remove(id: string): void {
    const entry = this.tracks.get(id);
    if (!entry) return;
    this.tracks.delete(id);

    // Note(yoochan.kim): an unsaved manifest still names the file, and a boot refuses a track whose file is missing.
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
    return [...this.tracks.values()].map(({ id, title, durationSec, volume, role }) => ({ id, title, durationSec, volume, role }));
  }

  get(id: string): LibraryEntry | undefined {
    return this.tracks.get(id);
  }

  private songs(): LibraryEntry[] {
    return [...this.tracks.values()].filter((entry) => entry.userSelectable);
  }

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

  /** Says whether it was written, for a change that must not outrun the disk. */
  private persist(): boolean {
    const entries = [...this.tracks.values()].map((entry) => ({
      id: entry.id,
      title: entry.title,
      file: entry.declaredFile,
      durationSec: entry.durationSec,
      volume: entry.volume,
      ...(entry.userSelectable ? { userSelectable: true } : {}),
      ...(entry.role.kind !== TrackRoleKind.MUSIC ? { role: entry.role } : {}),
    }));
    try {
      // Note(yoochan.kim): temp file then rename, so a crash mid-write cannot leave a manifest the next boot refuses.
      const tmp = `${this.manifestPath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.manifestPath);
      return true;
    } catch (error) {
      // Note(yoochan.kim): best-effort, like the state file: a level that failed to save still sounds.
      log.error('trackLibrary', null, 'Failed to write track manifest', { error: errorMessage(error) });
      return false;
    }
  }
}

function isLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** A notice's seconds before zero, as a notice track carries them. */
export function isBeforeSec(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** A manifest role in the wire's shape; none is music. */
function roleOf(id: string, value: unknown): TrackRole {
  if (value === undefined) return { kind: TrackRoleKind.MUSIC };
  const role = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (role.kind === TrackRoleKind.MUSIC || role.kind === TrackRoleKind.COUNT) return { kind: role.kind };
  if (role.kind === TrackRoleKind.NOTICE && isBeforeSec(role.beforeSec)) {
    return { kind: TrackRoleKind.NOTICE, beforeSec: role.beforeSec };
  }
  throw new Error(`Track '${id}' has an unknown role: ${JSON.stringify(value)}`);
}

function sameRole(a: TrackRole, b: TrackRole): boolean {
  return a.kind === b.kind && (a.kind !== TrackRoleKind.NOTICE || a.beforeSec === (b as { beforeSec: number }).beforeSec);
}

function describe(role: TrackRole): string {
  return role.kind === TrackRoleKind.NOTICE ? `notice ${role.beforeSec}s before zero` : role.kind;
}

export default TrackLibrary;
