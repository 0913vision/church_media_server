import { requireEnv, requireIntEnv } from '../utils/env.ts';

/**
 * One console channel this server drives, by its OSC addresses.
 *
 * The level is in decibels because that is what the desk shows and what anyone
 * would check it against; the 0-to-1 number the wire wants is worked out from
 * it (see console/faderLevel.ts).
 */
export interface ConsoleChannel {
  ON_ADDRESS: string;
  FADER_ADDRESS: string;
  FADER_DB: number;
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
      LABEL: '음악 재생기',
      CHANNELS: [
        { ON_ADDRESS: "/auxin/05/mix/on", FADER_ADDRESS: "/auxin/05/mix/fader", FADER_DB: 0.0 }
      ]
    },
    {
      ID: 'mic',
      LABEL: '목사님 마이크',
      CHANNELS: [
        { ON_ADDRESS: "/ch/01/mix/on", FADER_ADDRESS: "/ch/01/mix/fader", FADER_DB: -2.5 },
        { ON_ADDRESS: "/ch/02/mix/on", FADER_ADDRESS: "/ch/02/mix/fader", FADER_DB: 3.5 }
      ]
    }
  ] as const satisfies readonly ConsoleInputConfig[],

  /**
   * The desk as a service starts from: every input up, mute group 1 released,
   * and the two masters unmuted at the levels the room is mixed for. Each master
   * has its level set before it is unmuted, so the moment it opens it is already
   * where it belongs.
   *
   * The main fader waits, and the wait is the point. The matrix normally sits
   * near +10 dB and the main near -20 dB; bringing the main up while the matrix
   * is still high would put the room through a moment of everything at once.
   * So the matrix comes down, it is given time to land, and only then does the
   * main come up.
   *
   * Levels are written in decibels because that is what the desk shows and what
   * anyone would check them against. The 0-to-1 number the wire wants is worked
   * out from these (see console/faderLevel.ts).
   */
  INITIALIZE: {
    MUTE_GROUP_ADDRESS: "/config/mute/1",
    MUTE_GROUP_RELEASED: 0,
    MATRIX: { ADDRESS: "/mtx/01/mix/fader", ON_ADDRESS: "/mtx/01/mix/on", DB: -9.0 },
    MAIN: { ADDRESS: "/main/st/mix/fader", ON_ADDRESS: "/main/st/mix/on", DB: 0.7, DELAY_MS: 500 }
  }
} as const;
