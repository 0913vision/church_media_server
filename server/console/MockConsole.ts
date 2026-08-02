import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleState } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

/** Mock console for development/testing. Being its own desk, it always knows its state. */
class MockConsole implements ConsoleDevice {
  private state: ConsoleState = {
    mic: { kind: 'read', on: false, fader: 0 },
    aux: { kind: 'read', on: false, fader: 0 },
  };
  private readonly listeners: (() => void)[] = [];

  constructor() {
    log.info('mockConsole', null, 'Mock console initialized');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async enablePastorMic(): Promise<void> {
    log.info('mockConsole', null, 'Enabling pastor microphone');
    await this.delay(50);
    this.state = { ...this.state, mic: { kind: 'read', on: true, fader: CONSOLE_CONFIG.PASTOR_MIC.CHANNELS.CH1.FADER_LEVEL } };
    this.announce();
    log.info('mockConsole', null, 'Pastor microphone enabled');
  }

  async enableAux(): Promise<void> {
    log.info('mockConsole', null, 'Enabling auxiliary input');
    await this.delay(50);
    this.state = { ...this.state, aux: { kind: 'read', on: true, fader: CONSOLE_CONFIG.AUX_INPUT.FADER_LEVEL } };
    this.announce();
    log.info('mockConsole', null, 'Auxiliary input enabled');
  }

  read(): ConsoleState {
    return this.state;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

export default MockConsole;
