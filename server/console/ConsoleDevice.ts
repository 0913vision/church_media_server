import type { ConsoleInput } from '../protocol.ts';
import type { DeskValue } from './desk.ts';

/** Contract every mixing-console backend fulfills (X32 over OSC, or Mock). */
export interface ConsoleDevice {
  /** Asks the desk what one address holds now. Rejects when it does not answer, or has no such address. */
  query(address: string): Promise<DeskValue>;
  /** Puts one value on one address. Whether it landed is for query to say. */
  send(address: string, value: DeskValue): Promise<void>;
  /** Every value the desk reports, for any address and whoever moved it — answers to questions included. */
  onWire(listener: (address: string, value: DeskValue) => void): void;
  /** Switches one input on, by an id from read(). Unknown ids are the caller's bug. */
  enable(inputId: string): Promise<void>;
  /**
   * Puts the desk into the state a service starts from: every input on, the
   * mute group released, and the masters at their levels. Ordered and paced —
   * see CONSOLE_CONFIG.INITIALIZE for why the main fader comes last.
   */
  initialize(): Promise<void>;
  /** Every input this server drives, as the desk last answered. Starts unknown; never guesses. */
  read(): ConsoleInput[];
  onChange(listener: () => void): void;
}
