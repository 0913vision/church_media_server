/** How a run keeps time around its cues. Separate so a test can run one in milliseconds. */
export interface FlowTiming {
  /** How long before its second a cue is put on the deck, paused, so starting it is only an unpause */
  readonly CUE_PRELOAD_MS: number;
  /** How late a cue may still start. Past this its moment is gone and it is skipped */
  readonly CUE_GRACE_MS: number;
}

// Note(yoochan.kim): measured on the Pi on 2026-10-25 — a clip loaded on its second sounded
// 65–147ms late and wandered by up to 80ms; one loaded ahead and unpaused sounded
// 31ms late. A timer fires a millisecond or two after its time, which is on time.
export const FLOW_CONFIG = {
  TIMING: {
    CUE_PRELOAD_MS: 2000,
    CUE_GRACE_MS: 500,
  } satisfies FlowTiming,
} as const;
