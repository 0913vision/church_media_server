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
  // is seconds long.
  SEEK_AUDIBLE_SEC: 0.5,

  // Note(yoochan.kim): Play/pause fades: how long each takes unless a caller says otherwise,
  // where a fade in starts to be heard and a fade out stops being heard, and how
  // often the level moves (the curve is in loudness.ts). 2s up from -25 dB was
  // chosen by ear on a Mac on 2026-10-26, and 2.5s down on 2026-10-30, longer
  // than the rise — all to be heard again through the room's speakers, so expect
  // them to move. At 50ms a 2s rise from -25 dB moves 0.7 dB a step, too little to
  // hear as stairs.
  FADE_IN_MS: 2000,
  FADE_OUT_MS: 2500,
  FADE_EDGE_DB: -25,
  FADE_STEP_MS: 50
} as const;
