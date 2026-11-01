import { requireEnv, requireIntEnv } from '../utils/env.ts';
import { auxin, bus, dcasOf, fader, mainSend, monoSend, mtx, muteGroupsOf, on, sendOff, sendOn } from '../console/desk.ts';
import type { DeskChange } from '../console/desk.ts';

/** The music player's input, a linked pair, and AuxMix, the bus the band hears on their P16s. */
const MUSIC_PLAYER = [auxin(5), auxin(6)] as const;
const AUX_MIX = bus(8);
const upTo = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

export interface ConsoleChannel {
  ON_ADDRESS: string;
  FADER_ADDRESS: string;
  /** In decibels, as the desk shows it; faderLevel.ts works out the wire's 0..1 number. */
  FADER_DB: number;
}

export interface ConsoleInputConfig {
  ID: string;
  LABEL: string;
  /** Switching on drives every channel; the reading follows the first, which answers for the whole input. */
  CHANNELS: readonly ConsoleChannel[];
}

export const CONSOLE_CONFIG = {
  // Note(yoochan.kim): the X32's address and port are per deployment, so required env; the local bind stays fixed.
  NETWORK: {
    LOCAL_ADDRESS: "0.0.0.0",
    LOCAL_PORT: 0,
    REMOTE_ADDRESS: requireEnv('X32_REMOTE_ADDRESS'),
    REMOTE_PORT: requireIntEnv('X32_REMOTE_PORT')
  },

  OSC_VALUES: {
    UNMUTE: 1,
    MUTE: 0
  },

  // Note(yoochan.kim): facts about the building, in display order, sent to clients so a change needs no app release.
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

  /** Service start: inputs up, mute group 1 released, masters unmuted at the room's levels, each levelled first. */
  INITIALIZE: {
    MUTE_GROUP_ADDRESS: "/config/mute/1",
    MUTE_GROUP_RELEASED: 0,
    // Note(yoochan.kim): in dB, as the desk shows them and anyone would check them against.
    MATRIX: { ADDRESS: "/mtx/01/mix/fader", ON_ADDRESS: "/mtx/01/mix/on", DB: -9.0 },
    // Note(yoochan.kim): waits for the matrix (often near +10 dB) to land; raised first, the room hears all at once.
    MAIN: { ADDRESS: "/main/st/mix/fader", ON_ADDRESS: "/main/st/mix/on", DB: 0.7, DELAY_MS: 500 }
  },

  HOLD: {
    // Note(yoochan.kim): counts once read back; the first miss is the desk still applying it, later misses resend.
    CONFIRM_ATTEMPTS: 5,
    CONFIRM_GAP_MS: 50,
    // Note(yoochan.kim): a put-back is retried until it lands, as the desk may be off until the next service.
    RESTORE_RETRY_MS: 5000
  },

  /** Band-only countdown: closed from the output end, opened from the source with AuxMix last, put back in reverse. */
  BAND_ONLY: {
    // Note(yoochan.kim): off whatever they were, so a send raised since can't carry it; output 8 (AuxMix) has no wire.
    BLOCK: [
      ...upTo(6).map((n) => sendOff(AUX_MIX, mtx(n))),
      mainSend(AUX_MIX, false),
      monoSend(AUX_MIX, false),
      ...MUSIC_PLAYER.flatMap((strip) => [mainSend(strip, false), monoSend(strip, false)]),
      ...MUSIC_PLAYER.flatMap((strip) => upTo(16).filter((n) => bus(n) !== AUX_MIX).map((n) => sendOff(strip, bus(n)))),
    ] satisfies DeskChange[],
    OPEN: [
      // Note(yoochan.kim): out of every mute group and DCA: one engaged or pulled down would silence the band's count.
      ...MUSIC_PLAYER.flatMap((strip) => [muteGroupsOf(strip, []), dcasOf(strip, []), on(strip)]),
      ...MUSIC_PLAYER.flatMap((strip) => [fader(strip, 0), sendOn(strip, AUX_MIX)]),
      // Note(yoochan.kim): P16 15 takes AuxMix before its fader but after its mute (PRE+M), so AuxMix must be on.
      on(AUX_MIX),
    ] satisfies DeskChange[],
  },

  METER: {
    REQUEST: "/meters/0",
    // Note(yoochan.kim): aux in 5/6; /meters/0 is 32 channels, then the 8 aux ins. Not yet checked on the desk.
    CHANNELS: [36, 37],
    // Note(yoochan.kim): a request brings frames for 10s, so it is renewed before that runs out.
    RENEW_MS: 5000
  }
} as const;
