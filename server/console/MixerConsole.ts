import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { ConsoleInput } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

/** High-level console controller; the backend (X32 or Mock) is the composition root's pick. */
class MixerConsole {
  constructor(private readonly console: ConsoleDevice) {}

  async enable(inputId: string): Promise<void> {
    try {
      await this.console.enable(inputId);
    } catch (error) {
      log.error('mixerConsole', null, 'Error enabling console input', { input: inputId, error: errorMessage(error) });
      throw error;
    }
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
