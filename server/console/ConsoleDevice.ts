import type { ConsoleInput } from '../protocol.ts';

/** Contract every mixing-console backend fulfills (X32 over OSC, or Mock). */
export interface ConsoleDevice {
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
