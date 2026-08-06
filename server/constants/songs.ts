/**
 * A deck song's id.
 *
 * Deliberately a bare string: which songs exist, what they are called, which
 * file each plays and how loud it sits are all the track manifest's to say, so
 * that adding one costs a line of JSON rather than a release of the server and
 * every client. Nothing here can be enumerated at compile time — ask the
 * TrackLibrary, which validates ids against the manifest it loaded.
 */
export type SongId = string;
