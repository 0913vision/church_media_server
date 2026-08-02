import type { ConsoleState } from '../protocol.ts';

/** Contract every mixing-console backend fulfills (X32 over OSC, or Mock). */
export interface ConsoleDevice {
  enablePastorMic(): Promise<void>;
  enableAux(): Promise<void>;
  /** What the desk last answered. Starts unknown; never guesses. */
  read(): ConsoleState;
  onChange(listener: () => void): void;
}
