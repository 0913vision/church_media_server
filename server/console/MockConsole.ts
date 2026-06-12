import { log } from '../utils/logger.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

/**
 * Mock console implementation for development/testing
 */
class MockConsole implements ConsoleDevice {
  constructor() {
    log.info('mockConsole', null, 'Mock console initialized');
  }

  /**
   * Creates a delay for consistent API behavior
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Mock pastor microphone enable operation
   */
  async enablePastorMic(): Promise<void> {
    log.info('mockConsole', null, 'Enabling pastor microphone');
    log.info('mockConsole', null, '→ Channel 01: mix/on = 1, fader = 0.687');
    log.info('mockConsole', null, '→ Channel 02: mix/on = 1, fader = 0.837');
    await this.delay(50);
    log.info('mockConsole', null, 'Pastor microphone enabled');
  }

  /**
   * Mock auxiliary input enable operation
   */
  async enableAux(): Promise<void> {
    log.info('mockConsole', null, 'Enabling auxiliary input');
    log.info('mockConsole', null, '→ AuxIn 05: mix/on = 1, fader = 0.75');
    await this.delay(50);
    log.info('mockConsole', null, 'Auxiliary input enabled');
  }
}

export default MockConsole;
