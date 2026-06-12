import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

/**
 * High-level console controller that manages audio mixing operations.
 * Which backend drives it (X32 or Mock) is decided by the composition root.
 */
class MixerConsole {
  /**
   * @param console - Console backend (injected by the composition root)
   */
  constructor(private readonly console: ConsoleDevice) {}

  /**
   * Enable pastor microphone
   */
  async enablePastorMic(): Promise<void> {
    try {
      await this.console.enablePastorMic();
    } catch (error) {
      log.error('mixerConsole', null, 'Error enabling pastor microphone', { error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Enable auxiliary input
   */
  async enableAux(): Promise<void> {
    try {
      await this.console.enableAux();
    } catch (error) {
      log.error('mixerConsole', null, 'Error enabling auxiliary input', { error: errorMessage(error) });
      throw error;
    }
  }
}

export default MixerConsole;
