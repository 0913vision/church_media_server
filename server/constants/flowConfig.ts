/** How a run keeps time around its cues. Separate so a test can run one in milliseconds. */
export interface FlowTiming {
  /** Lead for loading a notice paused, so starting it is only an unpause. */
  readonly CUE_PRELOAD_MS: number;
  /** How late a cue may still start. Past this its moment is gone and it is skipped */
  readonly CUE_GRACE_MS: number;
  /** For a countdown with a desk: how long before the preload the desk starts being set */
  readonly CUE_DESK_LEAD_MS: number;
  /** Room to fade out a person's song and absorb lateness before the desk is set; later than this skips the block. */
  readonly CUE_LEAD_SLACK_MS: number;
}

export const FLOW_CONFIG = {
  TIMING: {
    // Note(yoochan.kim): on the Pi a notice loaded on its second sounded 65–147ms late, one loaded ahead 31ms.
    CUE_PRELOAD_MS: 2000,
    CUE_GRACE_MS: 500,
    // Note(yoochan.kim): ~50 desk addresses, each read first and read back after; 5s leaves room for a slow network.
    CUE_DESK_LEAD_MS: 5000,
    // Note(yoochan.kim): covers a person's song fading out (2.5s), so a block opens 10s before its first notice.
    CUE_LEAD_SLACK_MS: 3000,
  } satisfies FlowTiming,
} as const;
