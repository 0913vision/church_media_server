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

// Note(yoochan.kim): the ids were once 'slow' and 'fast', which named a tempo;
// what separates them is the kind of prayer they carry. Titles are not here:
// the track manifest owns every display name, and a deck song is the manifest
// entry whose id equals the song id.

/** Runtime guard for untrusted client payloads */
export function isSongType(value: unknown): value is SongType {
  return typeof value === 'string' && (Object.values(SongType) as string[]).includes(value);
}
