import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { ConsoleState } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

/** High-level console controller; the backend (X32 or Mock) is the composition root's pick. */
class MixerConsole {
  constructor(private readonly console: ConsoleDevice) {}

  async enablePastorMic(): Promise<void> {
    try {
      await this.console.enablePastorMic();
    } catch (error) {
      log.error('mixerConsole', null, 'Error enabling pastor microphone', { error: errorMessage(error) });
      throw error;
    }
  }

  async enableAux(): Promise<void> {
    try {
      await this.console.enableAux();
    } catch (error) {
      log.error('mixerConsole', null, 'Error enabling auxiliary input', { error: errorMessage(error) });
      throw error;
    }
  }

  read(): ConsoleState {
    return this.console.read();
  }

  onChange(listener: () => void): void {
    this.console.onChange(listener);
  }
}

export default MixerConsole;
