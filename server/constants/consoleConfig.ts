import { requireEnv, requireIntEnv } from '../utils/env.ts';

// X32 Console configuration constants
export const CONSOLE_CONFIG = {
  // Network settings — the X32's address/port are deployment-specific and come
  // from required env (validated, fail-fast). Local bind stays a constant.
  NETWORK: {
    LOCAL_ADDRESS: "0.0.0.0",
    LOCAL_PORT: 0,
    REMOTE_ADDRESS: requireEnv('X32_REMOTE_ADDRESS'),
    REMOTE_PORT: requireIntEnv('X32_REMOTE_PORT')
  },

  // OSC command values
  OSC_VALUES: {
    UNMUTE: 1,
    MUTE: 0
  },

  // Pastor microphone settings
  PASTOR_MIC: {
    CHANNELS: {
      CH1: {
        MUTE_ADDRESS: "/ch/01/mix/on",
        FADER_LEVEL_ADDRESS: "/ch/01/mix/fader",
        FADER_LEVEL: 0.687
      },
      CH2: {
        MUTE_ADDRESS: "/ch/02/mix/on",
        FADER_LEVEL_ADDRESS: "/ch/02/mix/fader",
        FADER_LEVEL: 0.837
      }
    }
  },

  // Auxiliary input settings
  AUX_INPUT: {
    MUTE_ADDRESS: "/auxin/05/mix/on",
    FADER_LEVEL_ADDRESS: "/auxin/05/mix/fader",
    FADER_LEVEL: 0.75
  }
} as const;
