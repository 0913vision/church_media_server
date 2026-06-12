import { log } from '../utils/logger.js';

/**
 * Mock console implementation for development/testing
 */
class MockConsole {
  constructor() {
    log.info('mockConsole', null, 'Mock console initialized');
  }

  /**
   * Creates a delay for consistent API behavior
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   * @private
   */
  #delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Mock pastor microphone enable operation
   * @returns {Promise<void>}
   */
  async enablePastorMic() {
    log.info('mockConsole', null, 'Enabling pastor microphone');
    log.info('mockConsole', null, '→ Channel 01: mix/on = 1, fader = 0.687');
    log.info('mockConsole', null, '→ Channel 02: mix/on = 1, fader = 0.837');
    await this.#delay(50);
    log.info('mockConsole', null, 'Pastor microphone enabled');
  }

  /**
   * Mock auxiliary input enable operation
   * @returns {Promise<void>}
   */
  async enableAux() {
    log.info('mockConsole', null, 'Enabling auxiliary input');
    log.info('mockConsole', null, '→ AuxIn 05: mix/on = 1, fader = 0.75');
    await this.#delay(50);
    log.info('mockConsole', null, 'Auxiliary input enabled');
  }
}

export default MockConsole;