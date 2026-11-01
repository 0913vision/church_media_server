import { requireEnv, requireEnvOneOf } from '../utils/env.ts';

/** Which mixing-console backend to drive */
export type ConsoleMode = 'X32' | 'MOCK';
const CONSOLE_MODES: readonly ConsoleMode[] = ['X32', 'MOCK'];

export const DEVICE_CONFIG = {
  // Note(yoochan.kim): platform-specific, so required env rather than a guess from process.platform.
  MPV_LIBRARY_PATH: requireEnv('MPV_LIBRARY_PATH'),

  CONSOLE_MODE: requireEnvOneOf('CONSOLE_MODE', CONSOLE_MODES),

  // Note(yoochan.kim): MPV operation settings
  MAX_PROPERTY_SET_ATTEMPTS: 10,
  PROPERTY_SET_RETRY_DELAY_MS: 50,
  // Note(yoochan.kim): a seek reads back up to a frame or block off, so it is compared within a tolerance.
  PLAYBACK_TIME_TOLERANCE_SEC: 0.5,

  // Note(yoochan.kim): below this it is a fresh start: a timer's ms of lateness is inaudible, a fade over it is not.
  SEEK_AUDIBLE_SEC: 0.5,

  // Note(yoochan.kim): picked by ear on a Mac, still to be heard through the room's speakers; curve in loudness.ts.
  FADE_IN_MS: 2000,
  // Note(yoochan.kim): longer than the rise, also picked by ear and also to be heard again in the room.
  FADE_OUT_MS: 2500,
  // Note(yoochan.kim): where a fade in starts to be heard and a fade out stops being heard.
  FADE_EDGE_DB: -25,
  // Note(yoochan.kim): a 2s rise from -25 dB moves 0.7 dB a step at this rate, too little to hear as stairs.
  FADE_STEP_MS: 50
} as const;
