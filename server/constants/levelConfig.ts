import { auxin } from '../console/desk.ts';

/** How a level measurement keeps time. Separate so a test can run one in milliseconds. */
export interface LevelTiming {
  /** How often a running measurement looks at the gate, the deck and the meter */
  readonly TICK_MS: number;
  /** How often levelMatch is sent while it runs */
  readonly PROGRESS_INTERVAL_MS: number;
  /** How long the desk has to start sending meters before anything is played */
  readonly METER_WAIT_MS: number;
  /** How long the meters may stop before the desk counts as gone */
  readonly METER_SILENCE_MS: number;
  /** How long past a whole track's length to wait for the player to say it ended */
  readonly END_SLACK_SEC: number;
  /** The stretch levelDb is averaged over, for a screen */
  readonly RECENT_SEC: number;
}

// Note(yoochan.kim): measuring a track's level on the desk (level/LevelMatcher.ts)
export const LEVEL_CONFIG = {
  // Note(yoochan.kim): the strip the music player comes in on. Aux 5 is linked to
  // aux 6 on the desk, so switching 5 off switches the pair — and holding 6 as
  // well would read the desk following the link as somebody's hand.
  STRIP: auxin(5),
  TARGET_DB: { MIN: -60, MAX: 0 },
  VOLUME: { MIN: 1, MAX: 100 },
  TIMING: {
    TICK_MS: 250,
    PROGRESS_INTERVAL_MS: 1000,
    METER_WAIT_MS: 3000,
    METER_SILENCE_MS: 3000,
    END_SLACK_SEC: 3,
    RECENT_SEC: 3,
  } satisfies LevelTiming,
} as const;
