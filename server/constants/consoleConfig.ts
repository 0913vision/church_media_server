import { requireEnv, requireIntEnv } from '../utils/env.ts';

/** One console channel this server drives, by its OSC addresses */
export interface ConsoleChannel {
  ON_ADDRESS: string;
  FADER_ADDRESS: string;
  FADER_LEVEL: number;
}

/**
 * One input as the panel offers it: an id, what to call it on screen, and the
 * channels behind it. Switching the input on drives every channel; the reading
 * follows the first, which is the one that answers for the whole input.
 */
export interface ConsoleInputConfig {
  ID: string;
  LABEL: string;
  CHANNELS: readonly ConsoleChannel[];
}

// Note(yoochan.kim): X32 Console configuration constants
export const CONSOLE_CONFIG = {
  // Note(yoochan.kim): Network settings — the X32's address/port are deployment-specific and come
  // from required env (validated, fail-fast). Local bind stays a constant.
  NETWORK: {
    LOCAL_ADDRESS: "0.0.0.0",
    LOCAL_PORT: 0,
    REMOTE_ADDRESS: requireEnv('X32_REMOTE_ADDRESS'),
    REMOTE_PORT: requireIntEnv('X32_REMOTE_PORT')
  },

  // Note(yoochan.kim): OSC command values
  OSC_VALUES: {
    UNMUTE: 1,
    MUTE: 0
  },

  // Note(yoochan.kim): The inputs the panel offers, in the order to show them.
  // Names and wiring are facts about the building, so they live here and ride
  // out to clients — renaming one, or adding a third, needs no client release.
  INPUTS: [
    {
      ID: 'aux',
      LABEL: '노래',
      CHANNELS: [
        { ON_ADDRESS: "/auxin/05/mix/on", FADER_ADDRESS: "/auxin/05/mix/fader", FADER_LEVEL: 0.75 }
      ]
    },
    {
      ID: 'mic',
      LABEL: '목사님 마이크',
      CHANNELS: [
        { ON_ADDRESS: "/ch/01/mix/on", FADER_ADDRESS: "/ch/01/mix/fader", FADER_LEVEL: 0.687 },
        { ON_ADDRESS: "/ch/02/mix/on", FADER_ADDRESS: "/ch/02/mix/fader", FADER_LEVEL: 0.837 }
      ]
    }
  ] as const satisfies readonly ConsoleInputConfig[]
} as const;
