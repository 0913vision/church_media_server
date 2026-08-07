import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleInput, ConsoleRead } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

const INPUTS = CONSOLE_CONFIG.INPUTS;

/** Mock console for development/testing. Being its own desk, it always knows its state. */
class MockConsole implements ConsoleDevice {
  private readonly states = new Map<string, ConsoleRead>(
    INPUTS.map((input) => [input.ID, { kind: 'read', on: false, fader: 0 }]),
  );
  private readonly listeners: (() => void)[] = [];

  constructor() {
    log.info('mockConsole', null, 'Mock console initialized');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async enable(inputId: string): Promise<void> {
    const input = INPUTS.find((candidate) => candidate.ID === inputId);
    if (!input) throw new Error(`No console input '${inputId}'`);

    log.info('mockConsole', null, 'Enabling console input', { input: input.ID });
    await this.delay(50);
    this.states.set(input.ID, { kind: 'read', on: true, fader: input.CHANNELS[0]!.FADER_LEVEL });
    this.announce();
    log.info('mockConsole', null, 'Console input enabled', { input: input.ID });
  }

  read(): ConsoleInput[] {
    return INPUTS.map((input) => ({
      id: input.ID,
      label: input.LABEL,
      state: this.states.get(input.ID)!,
    }));
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

export default MockConsole;
