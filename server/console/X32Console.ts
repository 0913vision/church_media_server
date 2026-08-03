import osc from 'osc';
import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleRead, ConsoleState } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

const { UDPPort } = osc;

// Note(yoochan.kim): the desk answers a bare address with its current value;
// answers older than STALE_MS stop counting as answers.
const POLL_MS = 2000;
const STALE_MS = 7000;

const MIC1 = CONSOLE_CONFIG.PASTOR_MIC.CHANNELS.CH1;
const MIC2 = CONSOLE_CONFIG.PASTOR_MIC.CHANNELS.CH2;
const AUX = CONSOLE_CONFIG.AUX_INPUT;
const POLLED: readonly string[] = [
  MIC1.MUTE_ADDRESS, MIC1.FADER_LEVEL_ADDRESS,
  MIC2.MUTE_ADDRESS, MIC2.FADER_LEVEL_ADDRESS,
  AUX.MUTE_ADDRESS, AUX.FADER_LEVEL_ADDRESS,
];

interface Input {
  MUTE_ADDRESS: string;
  FADER_LEVEL_ADDRESS: string;
}

/** X32 console over OSC. */
class X32Console implements ConsoleDevice {
  private readonly client: InstanceType<typeof UDPPort>;
  private readonly heard = new Map<string, { value: number; at: number }>();
  private readonly listeners: (() => void)[] = [];
  private lastAnnounced = '';
  private lastNetworkError = '';

  constructor() {
    this.client = new UDPPort({
      localAddress: CONSOLE_CONFIG.NETWORK.LOCAL_ADDRESS,
      localPort: CONSOLE_CONFIG.NETWORK.LOCAL_PORT,
      remoteAddress: CONSOLE_CONFIG.NETWORK.REMOTE_ADDRESS,
      remotePort: CONSOLE_CONFIG.NETWORK.REMOTE_PORT
    });

    this.initialize();
  }

  private initialize(): void {
    this.client.open();
    this.client.on("ready", () => {
      log.info('x32Console', null, 'X32 console client is ready');
      this.lastAnnounced = JSON.stringify(this.read());
      setInterval(() => this.poll(), POLL_MS);
    });
    // Note(yoochan.kim): without this handler one EHOSTUNREACH from the poll
    // kills the whole server; an absent desk is already just unknown.
    this.client.on("error", (error) => {
      if (error.message === this.lastNetworkError) return;
      this.lastNetworkError = error.message;
      log.warn('x32Console', null, 'Console unreachable', { error: error.message });
    });
    this.client.on("message", (message) => {
      const value = message.args[0];
      if (typeof value !== 'number' || !POLLED.includes(message.address)) return;
      this.heard.set(message.address, { value, at: Date.now() });
      this.announceIfChanged();
    });
  }

  private poll(): void {
    for (const address of POLLED) this.client.send({ address });
    this.announceIfChanged();
  }

  read(): ConsoleState {
    return { mic: this.readPair(MIC1, MIC2), aux: this.readSingle(AUX) };
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private freshValue(address: string): number | undefined {
    const heard = this.heard.get(address);
    return heard && Date.now() - heard.at <= STALE_MS ? heard.value : undefined;
  }

  private readSingle(input: Input): ConsoleRead {
    const on = this.freshValue(input.MUTE_ADDRESS);
    const fader = this.freshValue(input.FADER_LEVEL_ADDRESS);
    if (on === undefined || fader === undefined) return { kind: 'unknown' };
    // Note(yoochan.kim): rounded so float noise is not a state change
    return { kind: 'read', on: on === CONSOLE_CONFIG.OSC_VALUES.UNMUTE, fader: Math.round(fader * 1000) / 1000 };
  }

  /** The pastor's pair is one voice: on only when both are, fader as CH1 speaks it */
  private readPair(first: Input, second: Input): ConsoleRead {
    const a = this.readSingle(first);
    const b = this.readSingle(second);
    if (a.kind !== 'read' || b.kind !== 'read') return { kind: 'unknown' };
    return { kind: 'read', on: a.on && b.on, fader: a.fader };
  }

  private announceIfChanged(): void {
    const now = JSON.stringify(this.read());
    if (now === this.lastAnnounced) return;
    this.lastAnnounced = now;
    for (const listener of this.listeners) listener();
  }

  // Note(yoochan.kim): every value this project sends (mute, fader) is a number
  private sendOscCommand(address: string, args: number): Promise<void> {
    return new Promise((resolve) => {
      this.client.send({
        address: address,
        args: args
      });
      resolve();
    });
  }

  async enablePastorMic(): Promise<void> {
    const { CH1, CH2 } = CONSOLE_CONFIG.PASTOR_MIC.CHANNELS;
    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;

    await this.sendOscCommand(CH1.MUTE_ADDRESS, UNMUTE);
    await this.sendOscCommand(CH2.MUTE_ADDRESS, UNMUTE);
    await this.sendOscCommand(CH1.FADER_LEVEL_ADDRESS, CH1.FADER_LEVEL);
    await this.sendOscCommand(CH2.FADER_LEVEL_ADDRESS, CH2.FADER_LEVEL);
  }

  async enableAux(): Promise<void> {
    const { MUTE_ADDRESS, FADER_LEVEL_ADDRESS, FADER_LEVEL } = CONSOLE_CONFIG.AUX_INPUT;
    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;

    await this.sendOscCommand(MUTE_ADDRESS, UNMUTE);
    await this.sendOscCommand(FADER_LEVEL_ADDRESS, FADER_LEVEL);
  }
}

export default X32Console;
