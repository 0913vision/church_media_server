import { requireEnv, requireEnvOneOf } from '../utils/env.ts';

/** Which mixing-console backend to drive */
export type ConsoleMode = 'X32' | 'MOCK';
const CONSOLE_MODES: readonly ConsoleMode[] = ['X32', 'MOCK'];

export const DEVICE_CONFIG = {
  // Note(yoochan.kim): libmpv shared-library path — platform-specific, so it comes from required
  // env (validated, fail-fast) rather than guessing from process.platform
  MPV_LIBRARY_PATH: requireEnv('MPV_LIBRARY_PATH'),

  // Note(yoochan.kim): Console configuration (required env, validated against ConsoleMode)
  CONSOLE_MODE: requireEnvOneOf('CONSOLE_MODE', CONSOLE_MODES),

  // Note(yoochan.kim): MPV operation settings
  MAX_PROPERTY_SET_ATTEMPTS: 10,
  PROPERTY_SET_RETRY_DELAY_MS: 50,
  // Note(yoochan.kim): Seek verification: playback-time read-back may differ from the requested
  // position by a frame/block, so compare within a tolerance instead of exact
  PLAYBACK_TIME_TOLERANCE_SEC: 0.5,

  // Note(yoochan.kim): how much of a track has to be missing before starting it counts as
  // joining part-way through. A timer fires a millisecond or two late, which is
  // inaudible — but measured against zero it is an offset, and the fade over it
  // is three seconds long.
  SEEK_AUDIBLE_SEC: 0.5,

  // Note(yoochan.kim): Play/pause fade: how long one takes unless a caller says otherwise
  // (any length works — the curve is in loudness.ts), and how often the level moves
  // during it. At 50ms an even 3s rise moves 0.7 dB a step, too little to hear as stairs.
  FADE_MS: 3100,
  FADE_STEP_MS: 50
} as const;
