import osc from 'osc';
import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import type { ConsoleInputConfig } from '../constants/consoleConfig.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleInput, ConsoleRead } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

const { UDPPort } = osc;

// Note(yoochan.kim): /xremote makes the desk push changes the moment they
// happen, but it expires after 10s and never sends current state — so it is
// renewed on an interval, and the poll stays for initial values and liveness:
// answers older than STALE_MS stop counting as answers.
const POLL_MS = 2000;
const STALE_MS = 7000;
const XREMOTE_RENEW_MS = 5000;

const INPUTS = CONSOLE_CONFIG.INPUTS;
// Note(yoochan.kim): the reading follows each input's first channel; the rest
// are driven together but do not answer for it.
const POLLED: readonly string[] = INPUTS.flatMap((input) => [
  input.CHANNELS[0]!.ON_ADDRESS,
  input.CHANNELS[0]!.FADER_ADDRESS,
]);

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
      this.subscribe();
      setInterval(() => this.subscribe(), XREMOTE_RENEW_MS);
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

  private subscribe(): void {
    this.client.send({ address: '/xremote' });
  }

  private poll(): void {
    for (const address of POLLED) this.client.send({ address });
    this.announceIfChanged();
  }

  read(): ConsoleInput[] {
    return INPUTS.map((input) => ({
      id: input.ID,
      label: input.LABEL,
      state: this.readInput(input),
    }));
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private freshValue(address: string): number | undefined {
    const heard = this.heard.get(address);
    return heard && Date.now() - heard.at <= STALE_MS ? heard.value : undefined;
  }

  private readInput(input: ConsoleInputConfig): ConsoleRead {
    const first = input.CHANNELS[0]!;
    const on = this.freshValue(first.ON_ADDRESS);
    const fader = this.freshValue(first.FADER_ADDRESS);
    if (on === undefined || fader === undefined) return { kind: 'unknown' };
    // Note(yoochan.kim): rounded so float noise is not a state change
    return { kind: 'read', on: on === CONSOLE_CONFIG.OSC_VALUES.UNMUTE, fader: Math.round(fader * 1000) / 1000 };
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

  async enable(inputId: string): Promise<void> {
    const input = INPUTS.find((candidate) => candidate.ID === inputId);
    if (!input) throw new Error(`No console input '${inputId}'`);

    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;
    for (const channel of input.CHANNELS) await this.sendOscCommand(channel.ON_ADDRESS, UNMUTE);
    for (const channel of input.CHANNELS) await this.sendOscCommand(channel.FADER_ADDRESS, channel.FADER_LEVEL);
  }
}

export default X32Console;
