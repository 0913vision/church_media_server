// Note(yoochan.kim): approved 2026-09-25. 50 is where every track in the library
// already sits, and the longest file here (통성기도) is 166MB.
export const TRACK_CONFIG = {
  /** The level a track added while the server runs starts at, until somebody sets it by ear */
  NEW_TRACK_VOLUME: 50,
  /** The largest audio file the server takes in */
  MAX_BYTES: 300 * 1024 * 1024,
  /** How long an upload waits for addTrack before it is deleted */
  UPLOAD_TTL_MS: 10 * 60 * 1000,
} as const;
