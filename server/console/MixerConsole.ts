import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import type { ConsoleInput } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';
import type { DeskChange } from './desk.ts';
import { DeskHeldError } from './DeskHolds.ts';
import type DeskHolds from './DeskHolds.ts';
import type { HeldDesk } from './DeskHolds.ts';

const { MUTE_GROUP_ADDRESS, MATRIX, MAIN } = CONSOLE_CONFIG.INITIALIZE;

/** Every address switching this input on writes. */
function inputAddresses(inputId: string): string[] {
  const input = CONSOLE_CONFIG.INPUTS.find((candidate) => candidate.ID === inputId);
  return (input?.CHANNELS ?? []).flatMap((channel) => [channel.ON_ADDRESS, channel.FADER_ADDRESS]);
}

/** Every address initializing the desk writes. */
const INITIALIZE_ADDRESSES = [
  ...CONSOLE_CONFIG.INPUTS.flatMap((input) => inputAddresses(input.ID)),
  MUTE_GROUP_ADDRESS,
  MATRIX.ADDRESS,
  MATRIX.ON_ADDRESS,
  MAIN.ADDRESS,
  MAIN.ON_ADDRESS,
];

/** High-level console controller; the backend (X32 or Mock) is the composition root's pick. */
class MixerConsole {
  constructor(
    private readonly console: ConsoleDevice,
    private readonly holds: DeskHolds,
  ) {}

  /** Refused with DeskHeldError while a hold has any address the input drives. */
  async enable(inputId: string): Promise<void> {
    try {
      await this.holds.writing(inputAddresses(inputId), () => this.console.enable(inputId));
    } catch (error) {
      if (!(error instanceof DeskHeldError)) {
        log.error('mixerConsole', null, 'Error enabling console input', { input: inputId, error: errorMessage(error) });
      }
      throw error;
    }
  }

  /** Refused with DeskHeldError while a hold has any address it would write — nothing is sent. */
  async initialize(): Promise<void> {
    try {
      await this.holds.writing(INITIALIZE_ADDRESSES, () => this.console.initialize());
    } catch (error) {
      if (!(error instanceof DeskHeldError)) {
        log.error('mixerConsole', null, 'Error initializing console', { error: errorMessage(error) });
      }
      throw error;
    }
  }

  /** Sets part of the desk aside for the body and puts it back afterwards — see DeskHolds. */
  holding<T>(changes: readonly DeskChange[], body: (desk: HeldDesk) => Promise<T>): Promise<T> {
    return this.holds.holding(changes, body);
  }

  /** The music player's input meters until the returned function is called — see ConsoleDevice. */
  watchMeters(listener: (levels: readonly number[]) => void): () => void {
    return this.console.watchMeters(listener);
  }

  /** Whether this id is one of the inputs the desk offers */
  has(inputId: unknown): inputId is string {
    return typeof inputId === 'string' && this.read().some((input) => input.id === inputId);
  }

  read(): ConsoleInput[] {
    return this.console.read();
  }

  onChange(listener: () => void): void {
    this.console.onChange(listener);
  }
}

export default MixerConsole;
