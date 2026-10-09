import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';
import { sameValue } from './desk.ts';
import type { DeskChange, DeskValue } from './desk.ts';

/** What a hold has to put back: an address, and what it held before the hold first changed it. */
export interface DeskJournalEntry {
  readonly address: string;
  readonly original: DeskValue;
}

export interface HoldTiming {
  /** Reads of a change before it counts as not having landed */
  readonly CONFIRM_ATTEMPTS: number;
  /** The pause between those reads, for the desk to apply it */
  readonly CONFIRM_GAP_MS: number;
  /** How often a desk that did not take its old values back is tried again */
  readonly RESTORE_RETRY_MS: number;
}

/** The desk as the body of a hold sees it. */
export interface HeldDesk {
  /** One more change inside the hold. An address it has not touched yet is remembered first. */
  apply(change: DeskChange): Promise<void>;
  /** Someone else moved an address this hold changed — a hand on the desk, most likely. */
  onDeskChange(listener: (address: string, value: DeskValue) => void): void;
}

/** An address that is already spoken for. Nothing was sent. */
export class DeskHeldError extends Error {
  constructor(readonly address: string) {
    super(`${address} is held`);
    this.name = 'DeskHeldError';
  }
}

/** The body finished, but the desk did not take its old values back. That keeps being tried. */
export class DeskRestoreError extends Error {
  constructor(readonly addresses: readonly string[]) {
    super(`The desk is not put back yet: ${addresses.join(', ')}`);
    this.name = 'DeskRestoreError';
  }
}

interface Hold {
  /** Every address it owns, and what each held when first asked — changed or not */
  readonly originals: Map<string, DeskValue>;
  /** The addresses it changed, in the order it first changed them: what to put back, backwards */
  readonly entries: DeskJournalEntry[];
  /** What it last put on each address, so anything else arriving there is someone else's doing */
  readonly expected: Map<string, DeskValue>;
  readonly listeners: ((address: string, value: DeskValue) => void)[];
  /** open: the body runs. restoring / waiting: putting back, or waiting for the desk to answer again. */
  phase: 'open' | 'restoring' | 'waiting' | 'over';
  /** Whether the log has been told it is waiting, so a long wait is one line */
  told: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sets part of the desk aside for a while and puts it back, whatever ends the
 * while: the body returning, throwing, or the server stopping in between.
 *
 * Note(yoochan.kim): RAII written as a function — `holding(changes, body)` — so the
 * changes are values that can be mapped over a list of strips, and putting back
 * is not something a caller can forget. The unit is one address: two settings of
 * one strip are two things to put back, one address changed twice goes back to
 * what it held before the first, and putting back runs newest first so a level
 * is restored before the switch that opens it. What is to be put back is on disk
 * before the change reaches the desk, so a server that dies halfway puts the
 * desk back when it next starts.
 */
class DeskHolds {
  private readonly holds: Hold[] = [];
  /** One hold per address: two holds could not both put it back. */
  private readonly owners = new Map<string, Hold>();
  /** The server's own writes in progress, per address. They keep a hold out, but not each other. */
  private readonly writers = new Map<string, number>();
  private readonly checking = new Set<string>();
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private readonly desk: ConsoleDevice,
    private readonly timing: HoldTiming,
    private readonly journal: (entries: readonly DeskJournalEntry[]) => void,
    leftover: readonly DeskJournalEntry[],
  ) {
    desk.onWire((address, value) => this.heard(address, value));
    if (leftover.length === 0) return;

    const hold = this.open();
    for (const entry of leftover) {
      this.owners.set(entry.address, hold);
      hold.originals.set(entry.address, entry.original);
      hold.entries.push(entry);
    }
    log.warn('deskHolds', null, 'A hold never finished before the server stopped; putting the desk back', {
      addresses: leftover.map((entry) => entry.address).join(','),
    });
    void this.putBack(hold);
  }

  /**
   * Makes the changes, runs the body, and puts back everything changed however
   * the body ends. Every address in `changes` is read before anything is sent, so
   * a desk that cannot say what it holds is never touched.
   */
  async holding<T>(changes: readonly DeskChange[], body: (desk: HeldDesk) => Promise<T>): Promise<T> {
    const hold = this.open();
    try {
      await this.remember(hold, changes.map((change) => change.address));
    } catch (error) {
      this.close(hold);
      throw error;
    }
    log.info('deskHolds', null, 'Desk held', { addresses: [...hold.originals.keys()].join(',') });

    const desk: HeldDesk = {
      apply: (change) => this.apply(hold, change),
      onDeskChange: (listener) => { hold.listeners.push(listener); },
    };

    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      for (const change of changes) await this.apply(hold, change);
      outcome = { ok: true, value: await body(desk) };
    } catch (error) {
      outcome = { ok: false, error };
    }

    const restored = await this.putBack(hold);
    if (!outcome.ok) throw outcome.error;
    if (!restored) throw new DeskRestoreError(hold.entries.map((entry) => entry.address));
    return outcome.value;
  }

  /** Runs one of the server's own writes. Refused while a hold has any address it touches. */
  async writing<T>(addresses: readonly string[], write: () => Promise<T>): Promise<T> {
    const held = addresses.find((address) => this.owners.has(address));
    if (held !== undefined) throw new DeskHeldError(held);

    for (const address of addresses) this.writers.set(address, (this.writers.get(address) ?? 0) + 1);
    try {
      return await write();
    } finally {
      for (const address of addresses) {
        const left = (this.writers.get(address) ?? 1) - 1;
        if (left > 0) this.writers.set(address, left);
        else this.writers.delete(address);
      }
    }
  }

  dispose(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private open(): Hold {
    const hold: Hold = {
      originals: new Map(),
      entries: [],
      expected: new Map(),
      listeners: [],
      phase: 'open',
      told: false,
    };
    this.holds.push(hold);
    return hold;
  }

  private close(hold: Hold): void {
    hold.phase = 'over';
    for (const [address, owner] of this.owners) if (owner === hold) this.owners.delete(address);
    this.holds.splice(this.holds.indexOf(hold), 1);
  }

  /** Owns the addresses, then asks the desk what each holds. All are owned before any is asked. */
  private async remember(hold: Hold, addresses: readonly string[]): Promise<void> {
    const fresh = [...new Set(addresses)].filter((address) => !hold.originals.has(address));
    const taken = fresh.find((address) => {
      const owner = this.owners.get(address);
      return (owner !== undefined && owner !== hold) || this.writers.has(address);
    });
    if (taken !== undefined) throw new DeskHeldError(taken);

    for (const address of fresh) this.owners.set(address, hold);
    for (const address of fresh) hold.originals.set(address, await this.desk.query(address));
  }

  private async apply(hold: Hold, change: DeskChange): Promise<void> {
    if (hold.phase !== 'open') throw new Error('This hold is over; the desk is being put back');
    await this.remember(hold, [change.address]);
    if (!hold.entries.some((entry) => entry.address === change.address)) {
      hold.entries.push({ address: change.address, original: hold.originals.get(change.address)! });
      this.writeJournal();
    }
    hold.expected.set(change.address, change.value);
    await this.desk.send(change.address, change.value);
    await this.confirm(change.address, change.value);
  }

  /** Reads the address back until it holds the value. Throws when it never does. */
  private async confirm(address: string, value: DeskValue): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const now = await this.desk.query(address);
      if (sameValue(now, value)) return;
      if (attempt >= this.timing.CONFIRM_ATTEMPTS) throw new Error(`${address} reads ${now.value}, not ${value.value}`);
      await delay(this.timing.CONFIRM_GAP_MS);
    }
  }

  /** Puts back what the hold changed, newest first. False when the desk did not take it yet. */
  private async putBack(hold: Hold): Promise<boolean> {
    hold.phase = 'restoring';
    hold.expected.clear();
    const putting = hold.entries.map((entry) => entry.address).reverse();

    while (hold.entries.length > 0) {
      const entry = hold.entries[hold.entries.length - 1]!;
      try {
        await this.desk.send(entry.address, entry.original);
        await this.confirm(entry.address, entry.original);
      } catch (error) {
        hold.phase = 'waiting';
        if (!hold.told) {
          hold.told = true;
          log.error('deskHolds', null, 'The desk did not take its old value back; trying again until it does', {
            address: entry.address,
            error: errorMessage(error),
          });
        }
        this.scheduleRetry();
        return false;
      }
      hold.entries.pop();
      this.writeJournal();
    }

    if (putting.length > 0) log.info('deskHolds', null, 'Desk put back', { addresses: putting.join(',') });
    this.close(hold);
    return true;
  }

  private scheduleRetry(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      for (const hold of this.holds.filter((candidate) => candidate.phase === 'waiting')) void this.putBack(hold);
    }, this.timing.RESTORE_RETRY_MS);
  }

  private heard(address: string, value: DeskValue): void {
    const hold = this.owners.get(address);
    const expected = hold?.expected.get(address);
    if (!hold || !expected || sameValue(expected, value) || this.checking.has(address)) return;

    // Note(yoochan.kim): an answer to a question asked before the hold's own change
    // can still be on its way, so a different value is asked about once more
    // before it counts as somebody's hand.
    this.checking.add(address);
    this.desk.query(address)
      .then((now) => {
        const still = hold.expected.get(address);
        if (hold.phase !== 'open' || !still || sameValue(still, now)) return;
        log.warn('deskHolds', null, 'A held address was moved on the desk', { address, value: now.value });
        for (const listener of hold.listeners) listener(address, now);
      })
      .catch(() => {})
      .finally(() => this.checking.delete(address));
  }

  private writeJournal(): void {
    this.journal(this.holds.flatMap((hold) => hold.entries));
  }
}

export default DeskHolds;
