import X32Console from './X32Console.js';
import MockConsole from './MockConsole.js';
import { DEVICE_CONFIG } from '../constants/deviceConfig.js';
import { log } from '../utils/logger.js';

/**
 * High-level console controller that manages audio mixing operations
 */
class ConsoleHandler {
  #console;

  /**
   * Creates a new ConsoleHandler instance
   */
  constructor() {
    this.#console = DEVICE_CONFIG.CONSOLE_MODE === 'MOCK' 
      ? new MockConsole() 
      : new X32Console();
  }

  /**
   * Enable pastor microphone
   * @returns {Promise<void>}
   */
  async enablePastorMic() {
    try {
      await this.#console.enablePastorMic();
    } catch (error) {
      log.error('consoleHandler', null, 'Error enabling pastor microphone', { error: error.message });
      throw error;
    }
  }

  /**
   * Enable auxiliary input
   * @returns {Promise<void>}
   */
  async enableAux() {
    try {
      await this.#console.enableAux();
    } catch (error) {
      log.error('consoleHandler', null, 'Error enabling auxiliary input', { error: error.message });
      throw error;
    }
  }
}

export default ConsoleHandler;