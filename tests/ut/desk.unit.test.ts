import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  auxin, bus, ch, dca, fxrtn, mainMono, mainSt, mtx, muteGroup,
  dcasOf, deskAddress, engage, fader, float, int, mainSend, monoSend, muteGroupsOf, off, on, release, sendLevel, sendOff, sendOn,
} from '../../server/console/desk.ts';
import { dbFromFader } from '../../server/console/faderLevel.ts';

// Note(yoochan.kim): every address here is the unofficial X32 OSC protocol's (v4.09),
// copied from its tables rather than from the code, so a slip in either shows.
describe('Strips, as the desk numbers them', () => {
  test('each kind of strip has its switch and fader where the desk keeps them', () => {
    assert.deepEqual(on(ch(1)), { address: '/ch/01/mix/on', value: int(1) });
    assert.deepEqual(off(ch(32)), { address: '/ch/32/mix/on', value: int(0) });
    assert.deepEqual(off(auxin(8)), { address: '/auxin/08/mix/on', value: int(0) });
    assert.deepEqual(fader(fxrtn(8), -10), { address: '/fxrtn/08/mix/fader', value: float(0.5) });
    assert.deepEqual(fader(bus(16), 0), { address: '/bus/16/mix/fader', value: float(0.75) });
    assert.deepEqual(off(mtx(6)), { address: '/mtx/06/mix/on', value: int(0) });
    assert.deepEqual(off(mainSt), { address: '/main/st/mix/on', value: int(0) });
    assert.deepEqual(fader(mainMono, 0), { address: '/main/m/mix/fader', value: float(0.75) });
  });

  test('a DCA has no /mix and no leading zero', () => {
    assert.deepEqual(on(dca(8)), { address: '/dca/8/on', value: int(1) });
    assert.deepEqual(fader(dca(1), -10), { address: '/dca/1/fader', value: float(0.5) });
  });

  test('a number the desk does not have is refused before anything is built', () => {
    for (const build of [() => ch(0), () => ch(33), () => ch(1.5), () => auxin(9), () => fxrtn(9),
      () => bus(17), () => mtx(7), () => dca(9), () => muteGroup(7)]) {
      assert.throws(build, RangeError);
    }
  });
});

describe('Sends, where the desk routes them', () => {
  test('channels, aux inputs and FX returns feed the mix buses', () => {
    assert.deepEqual(sendOn(ch(3), bus(5)), { address: '/ch/03/mix/05/on', value: int(1) });
    assert.deepEqual(sendOff(auxin(5), bus(16)), { address: '/auxin/05/mix/16/on', value: int(0) });
    assert.deepEqual(sendOff(fxrtn(1), bus(1)), { address: '/fxrtn/01/mix/01/on', value: int(0) });
  });

  test('buses and the masters feed the matrices', () => {
    assert.deepEqual(sendOn(bus(1), mtx(2)), { address: '/bus/01/mix/02/on', value: int(1) });
    assert.deepEqual(sendLevel(mainSt, mtx(6), -10), { address: '/main/st/mix/06/level', value: float(0.5) });
    assert.deepEqual(sendOff(mainMono, mtx(1)), { address: '/main/m/mix/01/on', value: int(0) });
  });

  test('a send the desk does not have is refused', () => {
    assert.throws(() => sendOn(ch(1), mtx(1)), RangeError);
    assert.throws(() => sendOn(bus(1), bus(2)), RangeError);
    assert.throws(() => sendOn(mtx(1), mtx(2)), RangeError);
    assert.throws(() => sendOn(dca(1), bus(1)), RangeError);
  });

  test('a send level is on one of the 161 steps a send has, read as the desk\'s own table reads', () => {
    const at = (db: number): number => sendLevel(auxin(5), bus(3), db).value.value;
    // Pairs from the protocol's 161-step level table.
    assert.equal(at(-87), 1 / 160);
    assert.equal(at(-20), 0.375);
    assert.equal(at(-8.5), 0.5375);
    assert.equal(at(3), 0.825);
    assert.equal(at(-90), 0);
    // Between two steps it takes the nearer: +0.7 dB is 0.7675 on a fader, 123/160 on a send.
    assert.equal(at(0.7), 123 / 160);
    for (let tenths = -900; tenths <= 100; tenths += 1) {
      const steps = at(tenths / 10) * 160;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${tenths / 10} dB is off the steps`);
    }
    assert.equal(dbFromFader(at(-25.5)), -25.5);
  });
});

describe('A strip\'s main send and groups', () => {
  test('the main LR and mono sends switch where the desk keeps them', () => {
    assert.deepEqual(mainSend(auxin(5), false), { address: '/auxin/05/mix/st', value: int(0) });
    assert.deepEqual(monoSend(bus(8), false), { address: '/bus/08/mix/mono', value: int(0) });
    assert.deepEqual(mainSend(ch(1), true), { address: '/ch/01/mix/st', value: int(1) });
    assert.deepEqual(monoSend(fxrtn(2), true), { address: '/fxrtn/02/mix/mono', value: int(1) });
  });

  test('group membership is one bitmap, group 1 in the lowest bit, as the desk reads it back', () => {
    // As read on the room's desk on 2026-10-30: aux 5 in DCA 7 ("%01000000") and mute group 1 ("%000001").
    assert.deepEqual(dcasOf(auxin(5), [7]), { address: '/auxin/05/grp/dca', value: int(0b1000000) });
    assert.deepEqual(muteGroupsOf(auxin(5), [1]), { address: '/auxin/05/grp/mute', value: int(0b000001) });
    assert.deepEqual(muteGroupsOf(auxin(6), [1, 3, 6]), { address: '/auxin/06/grp/mute', value: int(0b100101) });
    assert.deepEqual(muteGroupsOf(auxin(6), []), { address: '/auxin/06/grp/mute', value: int(0) });
  });

  test('a strip without them, or a group the desk does not have, is refused', () => {
    assert.throws(() => mainSend(mtx(1), false), RangeError);
    assert.throws(() => mainSend(mainSt, false), RangeError);
    assert.throws(() => dcasOf(dca(1), []), RangeError);
    assert.throws(() => muteGroupsOf(auxin(5), [7]), RangeError);
    assert.throws(() => dcasOf(auxin(5), [0]), RangeError);
  });

  test('the desk has these addresses', () => {
    assert.deepEqual(deskAddress('/auxin/05/mix/st'), { kind: 'switch' });
    assert.deepEqual(deskAddress('/bus/08/mix/mono'), { kind: 'switch' });
    assert.deepEqual(deskAddress('/auxin/05/grp/mute'), { kind: 'groups', count: 6 });
    assert.deepEqual(deskAddress('/ch/32/grp/dca'), { kind: 'groups', count: 8 });
    assert.equal(deskAddress('/mtx/01/mix/st'), null);
    assert.equal(deskAddress('/main/st/grp/dca'), null);
  });
});

describe('Mute groups', () => {
  test('engaged is 1 and released is 0, as the desk keeps them', () => {
    assert.deepEqual(engage(muteGroup(1)), { address: '/config/mute/1', value: int(1) });
    assert.deepEqual(release(muteGroup(6)), { address: '/config/mute/6', value: int(0) });
  });
});

describe('What the desk has', () => {
  test('every address this server already drives is one, a switch or a level with its steps', () => {
    for (const address of ['/auxin/05/mix/on', '/ch/01/mix/on', '/ch/02/mix/on', '/config/mute/1', '/mtx/01/mix/on', '/main/st/mix/on']) {
      assert.deepEqual(deskAddress(address), { kind: 'switch' }, address);
    }
    for (const address of ['/auxin/05/mix/fader', '/ch/02/mix/fader', '/mtx/01/mix/fader', '/main/st/mix/fader', '/dca/3/fader']) {
      assert.deepEqual(deskAddress(address), { kind: 'level', steps: 1024 }, address);
    }
    assert.deepEqual(deskAddress('/auxin/05/mix/03/level'), { kind: 'level', steps: 161 });
    assert.deepEqual(deskAddress('/main/m/mix/06/on'), { kind: 'switch' });
  });

  test('a typo, a strip past the count or a send the desk does not route is not', () => {
    for (const address of ['/ch/33/mix/on', '/ch/1/mix/on', '/dca/01/on', '/dca/1/mix/on', '/mtx/01/mix/01/on',
      '/ch/01/mix/17/on', '/bus/01/mix/07/level', '/config/mute/7', '/ch/01/mix/fader/', '']) {
      assert.equal(deskAddress(address), null, address);
    }
  });
});
