import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import { faderFromDb, dbFromFader } from './faderLevel.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleInput, ConsoleRead } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';
import { deskAddress, float, int } from './desk.ts';
import type { DeskValue } from './desk.ts';

const INPUTS = CONSOLE_CONFIG.INPUTS;
const { MUTE_GROUP_ADDRESS, MUTE_GROUP_RELEASED, MATRIX, MAIN } = CONSOLE_CONFIG.INITIALIZE;
const { UNMUTE, MUTE } = CONSOLE_CONFIG.OSC_VALUES;

const MUTE_GROUP_ENGAGED = MUTE_GROUP_RELEASED === 0 ? 1 : 0;

/** Not the real desk's state, which is never told these: chosen so initializing has something visible to undo. */
const BOOT = { MATRIX_DB: 10, MAIN_DB: -20 };

/** How far back the view can look. Enough for several runs, bounded for a long one. */
const JOURNAL_LIMIT = 200;

/** Two touches on one fader this close together are one hand still moving it. */
const DRAG_MS = 900;

/** From desk.ts, like the server's changes; a level is logged in dB too, since only dB can be checked on the desk. */
const levelSteps = (address: string): number | null => {
  const held = deskAddress(address);
  return held?.kind === 'level' ? held.steps : null;
};

/** One value arriving at the desk, and who moved it. */
export interface MockMessage {
  at: number;
  address: string;
  value: number;
  /** What the value means, when it means decibels. A switch has no level. */
  db: number | null;
  from: 'server' | 'desk';
}

/** A fader as the view needs it: the wire's number and what it means. */
export interface MockFader {
  address: string;
  level: number;
  db: number;
}

export interface MockChannel {
  onAddress: string;
  on: boolean;
  fader: MockFader;
}

export interface MockInputView {
  id: string;
  label: string;
  channels: MockChannel[];
}

export interface MockSnapshot {
  inputs: MockInputView[];
  muteGroup: { address: string; value: number; engaged: boolean };
  matrix: MockFader;
  main: MockFader;
  journal: MockMessage[];
}

/** State kept as the X32's addresses, so a sequence checked here holds on a real desk, even parts never read back. */
class MockConsole implements ConsoleDevice {
  private readonly wire = new Map<string, number>();
  private journal: MockMessage[] = [];
  private readonly listeners: (() => void)[] = [];
  private readonly wireListeners: ((address: string, value: DeskValue) => void)[] = [];

  constructor() {
    this.boot();
    log.info('mockConsole', null, 'Mock console initialized');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Records one value at one address. Announcing is the caller's, so a run announces once per step. */
  private write(address: string, value: number, from: MockMessage['from']): void {
    // Note(yoochan.kim): the log keeps what was sent; the desk keeps where it landed.
    const steps = levelSteps(address);
    this.wire.set(address, steps === null ? value : Math.round(value * (steps - 1)) / (steps - 1));
    const entry: MockMessage = {
      at: Date.now(),
      address,
      value,
      db: steps === null ? null : dbFromFader(value),
      from,
    };

    // Note(yoochan.kim): a drag folds to one row so it cannot bury the run; server writes never fold, each is a step.
    const last = this.journal[this.journal.length - 1];
    if (from === 'desk' && last?.from === 'desk' && last.address === address && entry.at - last.at < DRAG_MS) {
      this.journal[this.journal.length - 1] = { ...entry, at: last.at };
      return;
    }

    this.journal.push(entry);
    if (this.journal.length > JOURNAL_LIMIT) this.journal = this.journal.slice(-JOURNAL_LIMIT);
  }

  /** Gives every address a value, so nothing about this desk is undefined. */
  private boot(): void {
    for (const input of INPUTS) {
      for (const channel of input.CHANNELS) {
        this.write(channel.ON_ADDRESS, MUTE, 'desk');
        this.write(channel.FADER_ADDRESS, faderFromDb(channel.FADER_DB), 'desk');
      }
    }
    this.write(MUTE_GROUP_ADDRESS, MUTE_GROUP_ENGAGED, 'desk');
    this.write(MATRIX.ADDRESS, faderFromDb(BOOT.MATRIX_DB), 'desk');
    this.write(MATRIX.ON_ADDRESS, MUTE, 'desk');
    this.write(MAIN.ADDRESS, faderFromDb(BOOT.MAIN_DB), 'desk');
    this.write(MAIN.ON_ADDRESS, MUTE, 'desk');
    // Note(yoochan.kim): these are where the desk was found, not traffic anyone sent, so the log starts empty.
    this.journal = [];
  }

  /** Forgets the traffic so far, so the next gesture can be read on its own. */
  clearJournal(): void {
    this.journal = [];
    this.announce();
  }

  /** A hand on the desk; unknown addresses are refused so a typo in the view cannot grow the desk a channel. */
  set(address: string, value: number): boolean {
    if (deskAddress(address) === null || !Number.isFinite(value)) return false;
    this.write(address, value, 'desk');
    this.announce();
    // Note(yoochan.kim): a real desk pushes a hand's move to every subscriber
    for (const listener of this.wireListeners) listener(address, this.typed(address, this.wire.get(address)!));
    return true;
  }

  async query(address: string): Promise<DeskValue> {
    if (deskAddress(address) === null) throw new Error(`No ${address} on this desk`);
    return this.typed(address, this.wire.get(address) ?? 0);
  }

  async send(address: string, value: DeskValue): Promise<void> {
    if (deskAddress(address) === null) throw new Error(`No ${address} on this desk`);
    this.write(address, value.value, 'server');
    this.announce();
  }

  onWire(listener: (address: string, value: DeskValue) => void): void {
    this.wireListeners.push(listener);
  }

  // Note(yoochan.kim): no audio behind this desk, so no meter frame, and whatever waits for one never plays here.
  watchMeters(): () => void {
    return () => {};
  }

  /** A value as the X32 would type it: a level is a float, a switch an int. */
  private typed(address: string, value: number): DeskValue {
    return levelSteps(address) === null ? int(value) : float(value);
  }

  async enable(inputId: string): Promise<void> {
    const input = INPUTS.find((candidate) => candidate.ID === inputId);
    if (!input) throw new Error(`No console input '${inputId}'`);

    log.info('mockConsole', null, 'Enabling console input', { input: input.ID });
    await this.delay(50);
    // Note(yoochan.kim): the same order X32Console sends in, so the log here reads like the log there.
    for (const channel of input.CHANNELS) this.write(channel.ON_ADDRESS, UNMUTE, 'server');
    for (const channel of input.CHANNELS) this.write(channel.FADER_ADDRESS, faderFromDb(channel.FADER_DB), 'server');
    this.announce();
    log.info('mockConsole', null, 'Console input enabled', { input: input.ID });
  }

  async initialize(): Promise<void> {
    log.info('mockConsole', null, 'Initializing console');
    for (const input of INPUTS) await this.enable(input.ID);

    this.write(MUTE_GROUP_ADDRESS, MUTE_GROUP_RELEASED, 'server');
    // Note(yoochan.kim): level first, then open — the same order X32Console sends in.
    this.write(MATRIX.ADDRESS, faderFromDb(MATRIX.DB), 'server');
    this.write(MATRIX.ON_ADDRESS, UNMUTE, 'server');
    this.announce();

    // Note(yoochan.kim): copied from X32Console, not skipped: the matrix-to-main gap is the part most worth watching.
    await this.delay(MAIN.DELAY_MS);
    this.write(MAIN.ADDRESS, faderFromDb(MAIN.DB), 'server');
    this.write(MAIN.ON_ADDRESS, UNMUTE, 'server');
    this.announce();

    log.info('mockConsole', null, 'Console initialized', { matrixDb: MATRIX.DB, mainDb: MAIN.DB });
  }

  read(): ConsoleInput[] {
    return INPUTS.map((input) => {
      const first = input.CHANNELS[0]!;
      // Note(yoochan.kim): rounded the way X32Console rounds what it hears
      const level = Math.round((this.wire.get(first.FADER_ADDRESS) ?? 0) * 1000) / 1000;
      const state: ConsoleRead = {
        kind: 'read',
        on: this.wire.get(first.ON_ADDRESS) === UNMUTE,
        db: dbFromFader(level),
      };
      return { id: input.ID, label: input.LABEL, nominalDb: first.FADER_DB, state };
    });
  }

  snapshot(): MockSnapshot {
    return {
      inputs: INPUTS.map((input) => ({
        id: input.ID,
        label: input.LABEL,
        channels: input.CHANNELS.map((channel) => ({
          onAddress: channel.ON_ADDRESS,
          on: this.wire.get(channel.ON_ADDRESS) === UNMUTE,
          fader: this.fader(channel.FADER_ADDRESS),
        })),
      })),
      muteGroup: {
        address: MUTE_GROUP_ADDRESS,
        value: this.wire.get(MUTE_GROUP_ADDRESS) ?? MUTE_GROUP_ENGAGED,
        engaged: this.wire.get(MUTE_GROUP_ADDRESS) !== MUTE_GROUP_RELEASED,
      },
      matrix: this.fader(MATRIX.ADDRESS),
      main: this.fader(MAIN.ADDRESS),
      journal: this.journal,
    };
  }

  private fader(address: string): MockFader {
    const level = this.wire.get(address) ?? 0;
    return { address, level, db: dbFromFader(level) };
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

export default MockConsole;
