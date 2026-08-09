import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import { faderFromDb, dbFromFader } from './faderLevel.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleInput, ConsoleRead } from '../protocol.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

const INPUTS = CONSOLE_CONFIG.INPUTS;
const { MUTE_GROUP_ADDRESS, MUTE_GROUP_RELEASED, MATRIX, MAIN } = CONSOLE_CONFIG.INITIALIZE;
const { UNMUTE, MUTE } = CONSOLE_CONFIG.OSC_VALUES;

/** A mute group is either holding the room quiet or it is not. */
const MUTE_GROUP_ENGAGED = MUTE_GROUP_RELEASED === 0 ? 1 : 0;

/**
 * Somewhere for this desk to start.
 *
 * Not configuration and not a claim about the real desk, which is wherever the
 * last person left it and is never told these numbers. They are only chosen so
 * that initializing has something visible to undo: the masters somewhere a run
 * has to move them from, the group holding, the inputs down.
 */
const BOOT = { MATRIX_DB: 10, MAIN_DB: -20 };

/** How far back the view can look. Enough for several runs, bounded for a long one. */
const JOURNAL_LIMIT = 200;

/** Two touches on one fader this close together are one hand still moving it. */
const DRAG_MS = 900;

/**
 * Every address on this desk whose number is a level rather than a switch.
 *
 * Note(yoochan.kim): kept here so that what a value means is decided once, by
 * the side that owns the curve. A log saying `0.525` and a log saying `-9.0 dB`
 * are the same log, but only one of them can be checked against the desk.
 */
const FADER_ADDRESSES = new Set<string>([
  ...INPUTS.flatMap((input) => input.CHANNELS.map((channel) => channel.FADER_ADDRESS)),
  MATRIX.ADDRESS,
  MAIN.ADDRESS,
]);

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

/** Everything the mock desk currently is, in one object. */
export interface MockSnapshot {
  inputs: MockInputView[];
  muteGroup: { address: string; value: number; engaged: boolean };
  matrix: MockFader;
  main: MockFader;
  journal: MockMessage[];
}

/**
 * Mock console for development and testing.
 *
 * It answers the same OSC addresses the X32 does and keeps its state as those
 * addresses, rather than as a summary of them. That is the point: what this
 * holds is exactly what a real desk would have been sent, so a sequence checked
 * here is a sequence checked for real — including the ones the protocol never
 * reads back, like the mute group and the two masters.
 *
 * Being its own desk, it always knows its state and so never answers `unknown`.
 */
class MockConsole implements ConsoleDevice {
  private readonly wire = new Map<string, number>();
  private journal: MockMessage[] = [];
  private readonly listeners: (() => void)[] = [];

  constructor() {
    this.boot();
    log.info('mockConsole', null, 'Mock console initialized');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Records one value at one address. Announcing is the caller's, so a run announces once per step. */
  private write(address: string, value: number, from: MockMessage['from']): void {
    this.wire.set(address, value);
    const entry: MockMessage = {
      at: Date.now(),
      address,
      value,
      db: FADER_ADDRESSES.has(address) ? dbFromFader(value) : null,
      from,
    };

    // Note(yoochan.kim): a hand dragging a fader sends a value every few pixels,
    // and a hundred rows of one fader moving would bury the run this log exists
    // to show. One continuous move is one row, kept at where it has reached.
    // The server's own writes are never folded: each one is a step of a
    // sequence, and losing one would be losing the thing under inspection.
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
    this.write(MAIN.ADDRESS, faderFromDb(BOOT.MAIN_DB), 'desk');
    // Note(yoochan.kim): the log starts empty. Nothing was sent here — these
    // values are where the desk was found, not traffic anyone would recognise.
    this.journal = [];
  }

  /** Forgets the traffic so far, so the next gesture can be read on its own. */
  clearJournal(): void {
    this.journal = [];
    this.announce();
  }

  /**
   * A hand on the desk itself.
   *
   * Note(yoochan.kim): the one thing a mock can do that a summary could not —
   * put the desk somewhere the server did not, which is the situation the
   * panel's held press exists for. Unknown addresses are refused rather than
   * invented, so a typo in the view cannot grow the desk a channel.
   */
  set(address: string, value: number): boolean {
    if (!this.wire.has(address) || !Number.isFinite(value)) return false;
    this.write(address, value, 'desk');
    this.announce();
    return true;
  }

  async enable(inputId: string): Promise<void> {
    const input = INPUTS.find((candidate) => candidate.ID === inputId);
    if (!input) throw new Error(`No console input '${inputId}'`);

    log.info('mockConsole', null, 'Enabling console input', { input: input.ID });
    await this.delay(50);
    // Note(yoochan.kim): the same order X32Console sends in — every channel on,
    // then every channel's level — so the log here reads like the log there.
    for (const channel of input.CHANNELS) this.write(channel.ON_ADDRESS, UNMUTE, 'server');
    for (const channel of input.CHANNELS) this.write(channel.FADER_ADDRESS, faderFromDb(channel.FADER_DB), 'server');
    this.announce();
    log.info('mockConsole', null, 'Console input enabled', { input: input.ID });
  }

  async initialize(): Promise<void> {
    log.info('mockConsole', null, 'Initializing console');
    for (const input of INPUTS) await this.enable(input.ID);

    this.write(MUTE_GROUP_ADDRESS, MUTE_GROUP_RELEASED, 'server');
    this.write(MATRIX.ADDRESS, faderFromDb(MATRIX.DB), 'server');
    this.announce();

    // Note(yoochan.kim): the wait is copied from X32Console rather than skipped,
    // because the gap between the matrix and the main is the part of this
    // sequence most worth watching — see CONSOLE_CONFIG.INITIALIZE.
    await this.delay(MAIN.DELAY_MS);
    this.write(MAIN.ADDRESS, faderFromDb(MAIN.DB), 'server');
    this.announce();

    log.info('mockConsole', null, 'Console initialized', { matrixDb: MATRIX.DB, mainDb: MAIN.DB });
  }

  read(): ConsoleInput[] {
    return INPUTS.map((input) => {
      const first = input.CHANNELS[0]!;
      const state: ConsoleRead = {
        kind: 'read',
        on: this.wire.get(first.ON_ADDRESS) === UNMUTE,
        // Note(yoochan.kim): rounded the way X32Console rounds what it hears
        fader: Math.round((this.wire.get(first.FADER_ADDRESS) ?? 0) * 1000) / 1000,
      };
      return { id: input.ID, label: input.LABEL, state };
    });
  }

  /** The desk as the view draws it. */
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
