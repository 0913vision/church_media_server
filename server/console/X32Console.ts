import osc from 'osc';
import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import type { ConsoleInputConfig } from '../constants/consoleConfig.ts';
import { faderFromDb, dbFromFader } from './faderLevel.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleInput, ConsoleRead } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';
import type { DeskValue } from './desk.ts';

const { UDPPort } = osc;

// Note(yoochan.kim): /xremote makes the desk push changes the moment they
// happen, but it expires after 10s and never sends current state — so it is
// renewed on an interval, and the poll stays for initial values and liveness:
// answers older than STALE_MS stop counting as answers.
const POLL_MS = 2000;
const STALE_MS = 7000;
const XREMOTE_RENEW_MS = 5000;
// Note(yoochan.kim): when this server is the one changing something
const ECHO_POLL_MS = [120, 400];
// Note(yoochan.kim): a question is UDP over Wi-Fi, so one lost packet is asked
// again rather than taken as a desk that has gone.
const QUERY_WAIT_MS = 250;
const QUERY_ASKS = 3;

const INPUTS = CONSOLE_CONFIG.INPUTS;
const METER = CONSOLE_CONFIG.METER;
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
  private readonly wireListeners: ((address: string, value: DeskValue) => void)[] = [];
  private readonly waiting = new Map<string, ((value: DeskValue) => void)[]>();
  private readonly meterListeners = new Set<(levels: readonly number[]) => void>();
  private meterRenew: NodeJS.Timeout | null = null;
  private lastAnnounced = '';
  private lastNetworkError = '';

  constructor() {
    this.client = new UDPPort({
      localAddress: CONSOLE_CONFIG.NETWORK.LOCAL_ADDRESS,
      localPort: CONSOLE_CONFIG.NETWORK.LOCAL_PORT,
      remoteAddress: CONSOLE_CONFIG.NETWORK.REMOTE_ADDRESS,
      remotePort: CONSOLE_CONFIG.NETWORK.REMOTE_PORT,
      metadata: true
    });

    this.openPort();
  }

  private openPort(): void {
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
      const arg = message.args[0];
      const value = arg?.value;
      if (arg?.type === 'b' && value instanceof Uint8Array && message.address === METER.REQUEST) {
        this.hearMeters(value);
        return;
      }
      if (typeof value !== 'number') return;
      if (arg?.type === 'i' || arg?.type === 'f') this.hear(message.address, { type: arg.type, value });
      if (!POLLED.includes(message.address)) return;
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
      nominalDb: input.CHANNELS[0]!.FADER_DB,
      state: this.readInput(input),
    }));
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  query(address: string): Promise<DeskValue> {
    return new Promise((resolve, reject) => {
      let asks = 0;
      let timer: NodeJS.Timeout;
      const answered = (value: DeskValue): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const ask = (): void => {
        if (asks === QUERY_ASKS) {
          const rest = (this.waiting.get(address) ?? []).filter((waiter) => waiter !== answered);
          if (rest.length > 0) this.waiting.set(address, rest);
          else this.waiting.delete(address);
          reject(new Error(`The desk did not answer for ${address}`));
          return;
        }
        asks += 1;
        this.client.send({ address });
        timer = setTimeout(ask, QUERY_WAIT_MS);
      };
      this.waiting.set(address, [...(this.waiting.get(address) ?? []), answered]);
      ask();
    });
  }

  async send(address: string, value: DeskValue): Promise<void> {
    this.client.send({ address, args: [{ type: value.type, value: value.value }] });
  }

  onWire(listener: (address: string, value: DeskValue) => void): void {
    this.wireListeners.push(listener);
  }

  watchMeters(listener: (levels: readonly number[]) => void): () => void {
    this.meterListeners.add(listener);
    if (!this.meterRenew) {
      this.askForMeters();
      this.meterRenew = setInterval(() => this.askForMeters(), METER.RENEW_MS);
    }
    return () => {
      this.meterListeners.delete(listener);
      if (this.meterListeners.size > 0 || !this.meterRenew) return;
      clearInterval(this.meterRenew);
      this.meterRenew = null;
    };
  }

  private askForMeters(): void {
    this.client.send({ address: '/meters', args: [{ type: 's', value: METER.REQUEST }] });
  }

  // Note(yoochan.kim): a meter frame is a blob of little-endian numbers — a count,
  // then that many floats — unlike the rest of OSC, which is big-endian.
  private hearMeters(blob: Uint8Array): void {
    const data = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    if (data.byteLength < 4) return;
    const count = data.getInt32(0, true);
    const levels: number[] = [];
    for (const index of METER.CHANNELS) {
      if (index >= count || 4 + (index + 1) * 4 > data.byteLength) return;
      levels.push(data.getFloat32(4 + index * 4, true));
    }
    for (const listener of this.meterListeners) listener(levels);
  }

  private hear(address: string, value: DeskValue): void {
    const waiters = this.waiting.get(address);
    if (waiters) {
      this.waiting.delete(address);
      for (const waiter of waiters) waiter(value);
    }
    for (const listener of this.wireListeners) listener(address, value);
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
    const level = Math.round(fader * 1000) / 1000;
    return { kind: 'read', on: on === CONSOLE_CONFIG.OSC_VALUES.UNMUTE, db: dbFromFader(level) };
  }

  private announceIfChanged(): void {
    const now = JSON.stringify(this.read());
    if (now === this.lastAnnounced) return;
    this.lastAnnounced = now;
    for (const listener of this.listeners) listener();
  }

  // Note(yoochan.kim): every value this project sends (mute, fader) is a number,
  // and these go as floats — what osc.js chose for a bare number before the port
  // carried types, kept so the desk keeps receiving exactly what it always has.
  private sendOscCommand(address: string, args: number): Promise<void> {
    return new Promise((resolve) => {
      this.client.send({
        address: address,
        args: [{ type: 'f', value: args }]
      });
      resolve();
    });
  }

  async enable(inputId: string): Promise<void> {
    const input = INPUTS.find((candidate) => candidate.ID === inputId);
    if (!input) throw new Error(`No console input '${inputId}'`);

    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;
    for (const channel of input.CHANNELS) await this.sendOscCommand(channel.ON_ADDRESS, UNMUTE);
    for (const channel of input.CHANNELS) await this.sendOscCommand(channel.FADER_ADDRESS, faderFromDb(channel.FADER_DB));

    this.echoPoll();
  }

  async initialize(): Promise<void> {
    const { MUTE_GROUP_ADDRESS, MUTE_GROUP_RELEASED, MATRIX, MAIN } = CONSOLE_CONFIG.INITIALIZE;

    const { UNMUTE: OPEN } = CONSOLE_CONFIG.OSC_VALUES;
    for (const input of INPUTS) await this.enable(input.ID);
    await this.sendOscCommand(MUTE_GROUP_ADDRESS, MUTE_GROUP_RELEASED);
    // Note(yoochan.kim): level first, then open. A master unmuted while it still
    // holds an old level is a room hearing that level.
    await this.sendOscCommand(MATRIX.ADDRESS, faderFromDb(MATRIX.DB));
    await this.sendOscCommand(MATRIX.ON_ADDRESS, OPEN);

    // Note(yoochan.kim): the main comes last and late, on purpose — see
    // CONSOLE_CONFIG.INITIALIZE. Raising it before the matrix has come down
    // would let the room hear everything at once.
    await new Promise((resolve) => setTimeout(resolve, MAIN.DELAY_MS));
    await this.sendOscCommand(MAIN.ADDRESS, faderFromDb(MAIN.DB));
    await this.sendOscCommand(MAIN.ON_ADDRESS, OPEN);

    log.info('x32Console', null, 'Console initialized', {
      matrixDb: MATRIX.DB,
      mainDb: MAIN.DB,
    });
    this.echoPoll();
  }

  // Note(yoochan.kim): the desk pushes a change to everyone except whoever made
  // it, so our own writes would otherwise go unnoticed until the next poll — the
  // panel would sit there looking as if the press had missed. Ask twice: once
  // now, once after the desk has had a moment to apply it.
  private echoPoll(): void {
    this.poll();
    for (const delayMs of ECHO_POLL_MS) setTimeout(() => this.poll(), delayMs);
  }
}

export default X32Console;
