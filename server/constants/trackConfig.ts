export const TRACK_CONFIG = {
  /** Where every library track already sits (approved by the user), until somebody sets it by ear */
  NEW_TRACK_VOLUME: 53,
  /** The largest audio file the server takes in; the longest track here is 166MB (approved by the user) */
  MAX_BYTES: 300 * 1024 * 1024,
  /** How long an upload waits for addTrack before it is deleted */
  UPLOAD_TTL_MS: 10 * 60 * 1000,
  /** How long fetching one video may take before it is given up */
  FETCH_TIMEOUT_MS: 10 * 60 * 1000,
  /** The least time between two progress reports, so a fast download is not a flood of patches */
  FETCH_PROGRESS_INTERVAL_MS: 1000,
} as const;
