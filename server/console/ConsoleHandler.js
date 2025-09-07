import X32Console from '@/console/X32Console';
import MockConsole from '@/console/MockConsole';
import { DEVICE_CONFIG } from '@/constants/deviceConfig';

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
      console.error('Error enabling pastor microphone:', error);
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
      console.error('Error enabling auxiliary input:', error);
      throw error;
    }
  }
}

export default ConsoleHandler;