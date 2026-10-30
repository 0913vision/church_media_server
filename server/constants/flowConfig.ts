/** How a run keeps time around its cues. Separate so a test can run one in milliseconds. */
export interface FlowTiming {
  /**
   * Lead kept in a countdown's block for putting a notice on the deck, paused, so that
   * starting it is only an unpause. It goes on as soon as the step before is done.
   */
  readonly CUE_PRELOAD_MS: number;
  /** How late a cue may still start. Past this its moment is gone and it is skipped */
  readonly CUE_GRACE_MS: number;
  /** For a countdown with a desk: how long before the preload the desk starts being set */
  readonly CUE_DESK_LEAD_MS: number;
  /**
   * Room at the front of a countdown's block before the desk is set: to fade out a
   * person's song, and to absorb a late arrival. Reached later than this, the block
   * is skipped whole.
   */
  readonly CUE_LEAD_SLACK_MS: number;
}

// Note(yoochan.kim): measured on the Pi on 2026-10-25 — a clip loaded on its second sounded
// 65–147ms late and wandered by up to 80ms; one loaded ahead and unpaused sounded
// 31ms late. A timer fires a millisecond or two after its time, which is on time.
// Setting the desk for the band's countdown is about fifty addresses, each read
// first and read back after; five seconds leaves room for a slow network. Three
// more in front take a person's song fading out (2.5s): a block opens ten seconds
// before its first notice (user, 2026-10-30).
export const FLOW_CONFIG = {
  TIMING: {
    CUE_PRELOAD_MS: 2000,
    CUE_GRACE_MS: 500,
    CUE_DESK_LEAD_MS: 5000,
    CUE_LEAD_SLACK_MS: 3000,
  } satisfies FlowTiming,
} as const;
