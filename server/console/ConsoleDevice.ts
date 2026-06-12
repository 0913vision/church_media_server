/**
 * Contract every mixing-console backend fulfills.
 * Implemented by X32Console (real hardware over OSC) and MockConsole (logs).
 */
export interface ConsoleDevice {
  enablePastorMic(): Promise<void>;
  enableAux(): Promise<void>;
}
