import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

// Note(yoochan.kim): the console config reads required env the moment it loads,
// even for a desk that is a fiction — so the environment is declared before the
// module is brought in, and the import has to be the dynamic kind to stay below
// this line rather than being hoisted above it.
process.env.X32_REMOTE_ADDRESS ??= '127.0.0.1';
process.env.X32_REMOTE_PORT ??= '10023';
process.env.LOG_LEVEL ??= 'warn';

const { default: MockConsole } = await import('../../server/console/MockConsole.ts');
const { CONSOLE_CONFIG } = await import('../../server/constants/consoleConfig.ts');

const { MUTE_GROUP_ADDRESS, MATRIX, MAIN } = CONSOLE_CONFIG.INITIALIZE;
const FIRST_CHANNEL = CONSOLE_CONFIG.INPUTS[1]!.CHANNELS[0]!;

// Note(yoochan.kim): the mock is the only place the whole desk can be looked at.
// The protocol reads back two addresses; the rest of what a run sends — the mute
// group, the two masters, the order and the pause between them — is visible
// nowhere else without a room full of people hearing it.
describe('Mock desk', () => {
  test('a run reaches the desk in order, with the main held back until the matrix has landed', async () => {
    const desk = new MockConsole();

    await desk.initialize();
    const journal = desk.snapshot().journal;
    const addresses = journal.map((message) => message.address);

    for (const input of CONSOLE_CONFIG.INPUTS) {
      for (const channel of input.CHANNELS) {
        assert.ok(addresses.includes(channel.ON_ADDRESS), `${channel.ON_ADDRESS} was never sent`);
      }
    }
    assert.ok(addresses.indexOf(MUTE_GROUP_ADDRESS) < addresses.indexOf(MATRIX.ADDRESS));
    // A master is levelled before it is opened, and the main is opened last of all.
    assert.ok(addresses.indexOf(MATRIX.ADDRESS) < addresses.indexOf(MATRIX.ON_ADDRESS));
    assert.ok(addresses.indexOf(MAIN.ADDRESS) < addresses.indexOf(MAIN.ON_ADDRESS));
    assert.equal(addresses[addresses.length - 1], MAIN.ON_ADDRESS);

    const matrix = journal.find((message) => message.address === MATRIX.ADDRESS)!;
    const main = journal.find((message) => message.address === MAIN.ADDRESS)!;
    assert.ok(
      main.at - matrix.at >= MAIN.DELAY_MS,
      `the main followed the matrix after ${main.at - matrix.at}ms, sooner than the ${MAIN.DELAY_MS}ms it must wait`,
    );
    assert.equal(matrix.db, MATRIX.DB);
    assert.equal(main.db, MAIN.DB);
  });

  test('a hand on the desk changes the reading, and the panel is told', async () => {
    const desk = new MockConsole();
    await desk.initialize();

    let announced = 0;
    desk.onChange(() => { announced += 1; });

    const before = desk.read().find((input) => input.state.kind === 'read' && input.state.on)!;
    assert.equal(desk.set(FIRST_CHANNEL.FADER_ADDRESS, 0.31), true);

    assert.equal(announced, 1);
    const after = desk.read().find((input) => input.id === CONSOLE_CONFIG.INPUTS[1]!.ID)!;
    assert.equal(after.state.kind, 'read');
    assert.equal(after.state.kind === 'read' && after.state.db, -25.2);
    assert.notEqual(before.state.kind === 'read' && before.state.db, -25.2);

    // The panel's held press is what puts it back — the point of the whole gesture.
    await desk.enable(CONSOLE_CONFIG.INPUTS[1]!.ID);
    const restored = desk.read().find((input) => input.id === CONSOLE_CONFIG.INPUTS[1]!.ID)!;
    assert.equal(restored.state.kind === 'read' && restored.state.db, after.nominalDb);
  });

  test('one continuous move is one line, and the run it interrupts keeps all of its own', async () => {
    const desk = new MockConsole();

    for (let level = 60; level > 30; level -= 1) desk.set(FIRST_CHANNEL.FADER_ADDRESS, level / 100);
    assert.equal(desk.snapshot().journal.length, 1);
    assert.equal(desk.snapshot().journal[0]!.value, 0.31);

    const beforeRun = desk.snapshot().journal.length;
    await desk.initialize();
    const sent = desk.snapshot().journal.length - beforeRun;
    const channels = CONSOLE_CONFIG.INPUTS.reduce((count, input) => count + input.CHANNELS.length, 0);
    // every channel on and levelled, the mute group, then each master levelled and opened
    assert.equal(sent, channels * 2 + 5, 'every step of a run is its own line');
  });

  test('an address this desk does not have is refused rather than invented', () => {
    const desk = new MockConsole();
    assert.equal(desk.set('/ch/99/mix/fader', 0.5), false);
    assert.equal(desk.set(FIRST_CHANNEL.FADER_ADDRESS, Number.NaN), false);
  });
});
