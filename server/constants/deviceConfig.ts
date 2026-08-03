import { SongType } from './songs.ts';
import { requireEnv, requireEnvOneOf } from '../utils/env.ts';

/** Which mixing-console backend to drive */
export type ConsoleMode = 'X32' | 'MOCK';
const CONSOLE_MODES: readonly ConsoleMode[] = ['X32', 'MOCK'];

export const DEVICE_CONFIG = {
  // Note(yoochan.kim): libmpv shared-library path — platform-specific, so it comes from required
  // env (validated, fail-fast) rather than guessing from process.platform
  MPV_LIBRARY_PATH: requireEnv('MPV_LIBRARY_PATH'),

  // Note(yoochan.kim): Initial song times
  INITIAL_SONG_TIMES: {
    [SongType.CALM]: 0.0,
    [SongType.FERVENT]: 0.0
  } satisfies Record<SongType, number>,

  // Note(yoochan.kim): Console configuration (required env, validated against ConsoleMode)
  CONSOLE_MODE: requireEnvOneOf('CONSOLE_MODE', CONSOLE_MODES),

  // Note(yoochan.kim): MPV operation settings
  MAX_PROPERTY_SET_ATTEMPTS: 10,
  PROPERTY_SET_RETRY_DELAY_MS: 50,
  // Note(yoochan.kim): Seek verification: playback-time read-back may differ from the requested
  // position by a frame/block, so compare within a tolerance instead of exact
  PLAYBACK_TIME_TOLERANCE_SEC: 0.5,

  // Note(yoochan.kim): Play/pause volume fade: FADE_STEPS+1 steps, FADE_STEP_MS apart
  // (≈ (FADE_STEPS+1) * FADE_STEP_MS total), following a quarter sine/cosine
  // curve for an equal-power transition
  FADE_STEPS: 30,
  FADE_STEP_MS: 100
} as const;
