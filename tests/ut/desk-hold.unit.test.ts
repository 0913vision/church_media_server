import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ConsoleDevice } from '../../server/console/ConsoleDevice.ts';
import type { DeskValue } from '../../server/console/desk.ts';
import type { DeskJournalEntry, HoldTiming } from '../../server/console/DeskHolds.ts';

// Note(yoochan.kim): console config and logger read required env on load, hence env first and dynamic imports.
process.env.X32_REMOTE_ADDRESS ??= '127.0.0.1';
process.env.X32_REMOTE_PORT ??= '10023';
process.env.LOG_LEVEL ??= 'warn';

const { default: DeskHolds, DeskHeldError, DeskRestoreError } = await import('../../server/console/DeskHolds.ts');
const { default: MixerConsole } = await import('../../server/console/MixerConsole.ts');
const { default: MockConsole } = await import('../../server/console/MockConsole.ts');
const { auxin, bus, ch, fader, float, int, off, sameValue, sendLevel, sendOff } = await import('../../server/console/desk.ts');
const { faderFromDb } = await import('../../server/console/faderLevel.ts');

const TIMING: HoldTiming = { CONFIRM_ATTEMPTS: 3, CONFIRM_GAP_MS: 5, RESTORE_RETRY_MS: 20 };

const AUX_ON = '/auxin/05/mix/on';
const AUX_FADER = '/auxin/05/mix/fader';
const CH1_ON = '/ch/01/mix/on';

const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A desk that only remembers, and can go unplugged, lose a message, be touched by hand or answer late. */
class FakeDesk implements ConsoleDevice {
  readonly values = new Map<string, DeskValue>();
  readonly sent: string[] = [];
  readonly silent = new Set<string>();
  /** Addresses whose next message never arrives, as a UDP datagram can be lost. */
  readonly lose = new Set<string>();
  unplugged = false;
  onSend: ((address: string) => void) | null = null;
  private readonly wire: ((address: string, value: DeskValue) => void)[] = [];

  constructor(initial: Record<string, DeskValue>) {
    for (const [address, value] of Object.entries(initial)) this.values.set(address, value);
  }

  async query(address: string): Promise<DeskValue> {
    const value = this.values.get(address);
    if (this.unplugged || this.silent.has(address) || !value) throw new Error(`no answer for ${address}`);
    for (const listener of this.wire) listener(address, value);
    return value;
  }

  async send(address: string, value: DeskValue): Promise<void> {
    this.onSend?.(address);
    if (this.unplugged || this.lose.delete(address)) return;
    this.sent.push(`${address}=${value.value}`);
    this.values.set(address, value);
  }

  onWire(listener: (address: string, value: DeskValue) => void): void {
    this.wire.push(listener);
  }

  /** Someone at the desk moves it. */
  hand(address: string, value: DeskValue): void {
    this.values.set(address, value);
    for (const listener of this.wire) listener(address, value);
  }

  /** An answer to an earlier question turns up now, the desk itself unchanged. */
  late(address: string, value: DeskValue): void {
    for (const listener of this.wire) listener(address, value);
  }

  async enable(): Promise<void> {}
  async initialize(): Promise<void> {}
  read(): [] { return []; }
  onChange(): void {}
  watchMeters(): () => void { return () => {}; }
}

const UNTOUCHED = { [AUX_ON]: int(1), [AUX_FADER]: float(0.75), [CH1_ON]: int(1) };

function rig(leftover: readonly DeskJournalEntry[] = [], initial: Record<string, DeskValue> = UNTOUCHED) {
  const desk = new FakeDesk(initial);
  const journals: (readonly DeskJournalEntry[])[] = [];
  const holds = new DeskHolds(desk, TIMING, (entries) => journals.push(entries), leftover);
  const journal = (): readonly DeskJournalEntry[] => journals[journals.length - 1] ?? leftover;
  return { desk, holds, journal };
}

describe('Holding part of the desk', () => {
  test('makes the changes, and puts every one back newest first once the body returns', async () => {
    const { desk, holds, journal } = rig();

    const result = await holds.holding([off(auxin(5)), fader(auxin(5), -10)], async () => {
      assert.equal(desk.values.get(AUX_ON)!.value, 0);
      assert.equal(desk.values.get(AUX_FADER)!.value, 0.5);
      return 'measured';
    });

    assert.equal(result, 'measured');
    assert.deepEqual(desk.sent, [`${AUX_ON}=0`, `${AUX_FADER}=0.5`, `${AUX_FADER}=0.75`, `${AUX_ON}=1`]);
    assert.deepEqual(journal(), []);
    holds.dispose();
  });

  test('a change lost on the way is sent again, going and coming back, and the hold goes on', async () => {
    const { desk, holds, journal } = rig();
    const tries: string[] = [];
    desk.onSend = (address) => tries.push(address);
    desk.lose.add(AUX_ON);
    const lines: string[] = [];
    const print = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };

    let result: string;
    try {
      result = await holds.holding([off(auxin(5))], async () => {
        assert.equal(desk.values.get(AUX_ON)!.value, 0, 'there, the second time');
        desk.lose.add(AUX_ON);
        return 'measured';
      });
      await settle(20);
    } finally {
      console.log = print;
    }

    // Note(yoochan.kim): the old value a lost change leaves is logged as sent again, never blamed on a hand.
    assert.equal(lines.filter((line) => line.includes('Desk change not there yet, sent again')).length, 2, lines.join('\n'));
    assert.ok(lines.some((line) => line.includes(`address=${AUX_ON},wanted=0,read=1`)), 'going: wanted off, read on');
    assert.ok(!lines.some((line) => line.includes('moved on the desk')), `no hand blamed:\n${lines.join('\n')}`);
    assert.equal(result, 'measured', 'one lost message did not end the hold');
    assert.deepEqual(tries, [AUX_ON, AUX_ON, AUX_ON, AUX_ON], 'sent twice each way');
    assert.deepEqual(desk.values.get(AUX_ON), int(1), 'back as it was');
    assert.deepEqual(journal(), []);
    holds.dispose();
  });

  test('puts it back when the body throws, and the body\'s error is the one that surfaces', async () => {
    const { desk, holds } = rig();

    await assert.rejects(
      holds.holding([off(auxin(5))], async () => { throw new Error('measurement failed'); }),
      /measurement failed/,
    );
    assert.equal(desk.values.get(AUX_ON)!.value, 1);
    holds.dispose();
  });

  test('an address changed again goes back to what it held before the first change, in one step', async () => {
    const { desk, holds } = rig();

    await holds.holding([fader(auxin(5), -20)], async (held) => {
      await held.apply(fader(auxin(5), 5));
      await held.apply(fader(auxin(5), -5));
    });

    assert.equal(desk.values.get(AUX_FADER)!.value, 0.75);
    assert.equal(desk.sent.filter((line) => line === `${AUX_FADER}=0.75`).length, 1);
    holds.dispose();
  });

  test('an address first touched midway is remembered before it changes, and put back first', async () => {
    const { desk, holds } = rig();

    await holds.holding([off(auxin(5)), fader(auxin(5), -10)], async (held) => {
      await held.apply(off(ch(1)));
    });

    assert.deepEqual(desk.sent.slice(3), [`${CH1_ON}=1`, `${AUX_FADER}=0.75`, `${AUX_ON}=1`]);
    holds.dispose();
  });

  test('a desk that cannot say what one address holds is not touched at all', async () => {
    const { desk, holds } = rig();
    desk.silent.add(AUX_FADER);

    await assert.rejects(holds.holding([off(auxin(5)), fader(auxin(5), -10)], async () => {}), /no answer/);
    assert.deepEqual(desk.sent, []);

    // Note(yoochan.kim): nothing was left spoken for: once it answers, the same hold goes ahead.
    desk.silent.clear();
    await holds.holding([off(auxin(5)), fader(auxin(5), -10)], async () => {});
    holds.dispose();
  });

  test('an address has one holder at a time, while another setting of the same strip is free', async () => {
    const { holds } = rig();

    await holds.holding([off(auxin(5))], async () => {
      await assert.rejects(holds.holding([off(auxin(5))], async () => {}), DeskHeldError);
      await holds.holding([fader(auxin(5), -10)], async () => {});
    });
    holds.dispose();
  });

  test('a hand on the desk is reported; the hold\'s own changes and a late answer are not', async () => {
    const { desk, holds } = rig();
    const moved: string[] = [];

    await holds.holding([off(auxin(5))], async (held) => {
      held.onDeskChange((address, value) => moved.push(`${address}=${value.value}`));

      desk.late(AUX_ON, int(1));
      await settle();
      assert.deepEqual(moved, [], 'an answer from before the change is not a hand');

      desk.hand(AUX_ON, int(1));
      await settle();
      assert.deepEqual(moved, [`${AUX_ON}=1`]);
    });
    holds.dispose();
  });

  test('what is to be put back is written down before the change reaches the desk', async () => {
    const { desk, holds, journal } = rig();
    const writtenAtSend: (readonly DeskJournalEntry[])[] = [];
    desk.onSend = () => writtenAtSend.push(journal());

    await holds.holding([off(auxin(5))], async () => {});

    assert.deepEqual(writtenAtSend[0], [{ address: AUX_ON, original: int(1) }]);
    assert.deepEqual(journal(), []);
    holds.dispose();
  });

  test('the desk as it was, every address, is written down before the first change is sent', async () => {
    const { desk, holds, journal } = rig();
    const writtenAtSend: (readonly DeskJournalEntry[])[] = [];
    desk.onSend = () => writtenAtSend.push(journal());

    await holds.holding([off(auxin(5)), fader(auxin(5), -10), off(ch(1))], async () => {});

    assert.deepEqual(writtenAtSend[0], [
      { address: AUX_ON, original: int(1) },
      { address: AUX_FADER, original: float(0.75) },
      { address: CH1_ON, original: int(1) },
    ]);
    assert.deepEqual(journal(), []);
    holds.dispose();
  });

  test('a desk that went away is put back when it answers again, and stays held until then', async () => {
    const { desk, holds, journal } = rig();

    await assert.rejects(
      holds.holding([off(auxin(5))], async () => { desk.unplugged = true; }),
      DeskRestoreError,
    );
    assert.deepEqual(journal(), [{ address: AUX_ON, original: int(1) }]);
    await assert.rejects(holds.writing([AUX_ON], async () => {}), DeskHeldError);

    desk.unplugged = false;
    await settle(TIMING.RESTORE_RETRY_MS * 3);
    assert.equal(desk.values.get(AUX_ON)!.value, 1);
    assert.deepEqual(journal(), []);
    await holds.writing([AUX_ON], async () => {});
    holds.dispose();
  });

  test('a hold the server stopped in the middle of is put back when it starts again, newest first', async () => {
    const leftover = [
      { address: AUX_ON, original: int(1) },
      { address: AUX_FADER, original: float(0.75) },
    ];
    const { desk, holds, journal } = rig(leftover, { ...UNTOUCHED, [AUX_ON]: int(0), [AUX_FADER]: float(0.5) });

    await settle(TIMING.RESTORE_RETRY_MS);
    assert.deepEqual(desk.sent, [`${AUX_FADER}=0.75`, `${AUX_ON}=1`]);
    assert.deepEqual(journal(), []);
    holds.dispose();
  });

  test('the server\'s own writes keep out of a hold, but never out of each other', async () => {
    const { holds } = rig();

    await holds.holding([off(auxin(5))], async () => {
      await assert.rejects(holds.writing([AUX_ON], async () => {}), DeskHeldError);
    });

    let release!: () => void;
    const slow = holds.writing([AUX_ON], () => new Promise<void>((resolve) => { release = resolve; }));
    await holds.writing([AUX_ON], async () => {});
    await assert.rejects(holds.holding([off(auxin(5))], async () => {}), DeskHeldError);
    release();
    await slow;
    holds.dispose();
  });
});

describe('Holding the mock desk', () => {
  test('the music player\'s input is set aside and comes back, and the panel cannot switch it on meanwhile', async () => {
    const desk = new MockConsole();
    await desk.initialize();
    desk.clearJournal();
    const holds = new DeskHolds(desk, TIMING, () => {}, []);
    const mixer = new MixerConsole(desk, holds);
    const aux = (): boolean => {
      const input = mixer.read().find((candidate) => candidate.id === 'aux')!;
      return input.state.kind === 'read' && input.state.on;
    };

    await mixer.holding([off(auxin(5))], async () => {
      assert.equal(aux(), false);
      await assert.rejects(mixer.enable('aux'), DeskHeldError);
      await assert.rejects(mixer.initialize(), DeskHeldError);
      await mixer.enable('mic');
    });

    assert.equal(aux(), true);
    const sent = desk.snapshot().journal
      .filter((message) => message.address === AUX_ON)
      .map((message) => `${message.from}:${message.value}`);
    assert.deepEqual(sent, ['server:0', 'server:1']);
    holds.dispose();
  });

  test('a send is set aside and comes back, at a level between the steps a send has', async () => {
    const desk = new MockConsole();
    const holds = new DeskHolds(desk, TIMING, () => {}, []);
    const mixer = new MixerConsole(desk, holds);
    const SEND_ON = '/auxin/05/mix/03/on';
    const SEND_LEVEL = '/auxin/05/mix/03/level';
    desk.set(SEND_ON, 1);
    desk.set(SEND_LEVEL, 0.5);

    // Note(yoochan.kim): the desk rounds onto its steps, so a fader's number sent to a send never counts as landed.
    await desk.send(SEND_LEVEL, float(faderFromDb(0.7)));
    assert.equal(sameValue(await desk.query(SEND_LEVEL), float(faderFromDb(0.7))), false);
    desk.set(SEND_LEVEL, 0.5);

    await mixer.holding([sendOff(auxin(5), bus(3)), sendLevel(auxin(5), bus(3), 0.7)], async () => {
      assert.deepEqual(await desk.query(SEND_ON), int(0));
      assert.deepEqual(await desk.query(SEND_LEVEL), float(123 / 160));
    });

    assert.deepEqual(await desk.query(SEND_ON), int(1));
    assert.deepEqual(await desk.query(SEND_LEVEL), float(0.5));
    holds.dispose();
  });
});
