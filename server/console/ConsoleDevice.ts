import type { ConsoleInput, LevelMeter } from '../protocol.ts';
import type { DeskValue } from './desk.ts';

/** Contract every mixing-console backend fulfills (X32 over OSC, or Mock). */
export interface ConsoleDevice {
  /** Asks the desk what one address holds now. Rejects when it does not answer, or has no such address. */
  query(address: string): Promise<DeskValue>;
  /** Puts one value on one address. Whether it landed is for query to say. */
  send(address: string, value: DeskValue): Promise<void>;
  /** Every value the desk reports, for any address and whoever moved it — answers to questions included. */
  onWire(listener: (address: string, value: DeskValue) => void): void;
  /** One meter pair (CONSOLE_CONFIG.METERS) as linear readings, 1 = full scale; call the result to stop. */
  watchMeters(meter: LevelMeter['kind'], listener: (levels: readonly number[]) => void): () => void;
  /** Switches one input on, by an id from read(). Unknown ids are the caller's bug. */
  enable(inputId: string): Promise<void>;
  /** Service-start state (inputs on, mute group released, masters levelled), paced so the main fader comes last. */
  initialize(): Promise<void>;
  /** Every input this server drives, as the desk last answered. Starts unknown; never guesses. */
  read(): ConsoleInput[];
  onChange(listener: () => void): void;
}
