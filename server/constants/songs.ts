import type { Song } from '../protocol.ts';

/**
 * The two-song system users control directly. This is a server-side domain
 * type, not a wire type: the protocol carries a song id and lets the server
 * name what those ids are, so renaming a song — or one day adding a third —
 * costs a config change here rather than a release of every client.
 */
export enum SongType {
  /** Accompanies quiet, personal prayer */
  CALM = 'calm',
  /** Accompanies 통성기도 — praying aloud together */
  FERVENT = 'fervent'
}

/**
 * Display names the server hands to clients in `ready`.
 *
 * Note(yoochan.kim): these were once 'slow' and 'fast', which named a tempo.
 * What actually separates them is the kind of prayer they carry, so the ids
 * say that instead.
 */
export const SONG_TITLES: Record<SongType, string> = {
  [SongType.CALM]: '잔잔한 음악',
  [SongType.FERVENT]: '통성기도 음악'
};

/** The song catalogue as clients see it */
export const SONG_CATALOGUE: Song[] = Object.values(SongType).map((id) => ({ id, title: SONG_TITLES[id] }));

/** Runtime guard for untrusted client payloads */
export function isSongType(value: unknown): value is SongType {
  return typeof value === 'string' && (Object.values(SongType) as string[]).includes(value);
}
