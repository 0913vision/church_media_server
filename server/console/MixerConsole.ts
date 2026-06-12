import { log } from '../utils/logger.ts';
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
      log.error('mixerConsole', null, 'Error enabling pastor microphone', { error: error.message });
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
      log.error('mixerConsole', null, 'Error enabling auxiliary input', { error: error.message });
      throw error;
    }
  }
}

export default MixerConsole;
