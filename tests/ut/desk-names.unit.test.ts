import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

// Note(yoochan.kim): the console config reads required env on load, hence env first and a dynamic import.
process.env.X32_REMOTE_ADDRESS ??= '127.0.0.1';
process.env.X32_REMOTE_PORT ??= '10023';
process.env.LOG_LEVEL ??= 'warn';
const { deskSetting, stripRank, stripsOf } =await import('../../server/console/deskNames.ts');
const { CONSOLE_CONFIG } = await import('../../server/constants/consoleConfig.ts');

describe('Desk settings named as the X32 names them', () => {
  test('every address the countdown and the level measurement touch', () => {
    const named = (address: string): string => { const { strip, setting } = deskSetting(address); return `${strip} | ${setting}`; };
    assert.equal(named('/auxin/05/mix/on'), 'Aux 5 | Mute');
    assert.equal(named('/auxin/06/mix/fader'), 'Aux 6 | Fader');
    assert.equal(named('/auxin/05/mix/st'), 'Aux 5 | Main LR');
    assert.equal(named('/auxin/05/mix/mono'), 'Aux 5 | Mono');
    assert.equal(named('/auxin/05/mix/03/on'), 'Aux 5 | Bus 3 Send');
    assert.equal(named('/auxin/05/mix/03/level'), 'Aux 5 | Bus 3 Send Level');
    assert.equal(named('/auxin/05/grp/mute'), 'Aux 5 | Mute Group');
    assert.equal(named('/auxin/05/grp/dca'), 'Aux 5 | DCA');
    assert.equal(named('/bus/08/mix/02/on'), 'AuxMix | Matrix 2 Send', 'bus 8 by the room\'s name, its sends to matrices');
    assert.equal(named('/bus/08/mix/on'), 'AuxMix | Mute');
    assert.equal(named('/main/st/mix/on'), 'Main LR | Mute');
    assert.equal(named('/main/st/mix/01/on'), 'Main LR | Matrix 1 Send');
  });

  test('the rest of what the desk words can build', () => {
    const named = (address: string): string => { const { strip, setting } = deskSetting(address); return `${strip} | ${setting}`; };
    assert.equal(named('/ch/07/mix/fader'), 'Ch 7 | Fader');
    assert.equal(named('/fxrtn/02/mix/on'), 'FX Return 2 | Mute');
    assert.equal(named('/bus/03/mix/fader'), 'Bus 3 | Fader');
    assert.equal(named('/mtx/01/mix/fader'), 'Matrix 1 | Fader');
    assert.equal(named('/main/m/mix/on'), 'Mono | Mute');
    assert.equal(named('/dca/7/on'), 'DCA 7 | Mute');
    assert.equal(named('/dca/7/fader'), 'DCA 7 | Fader');
    assert.equal(named('/config/mute/1'), 'Mute Group 1 | ');
  });

  test('strips ranked as the desk lays them out, inputs first and outputs last', () => {
    const addresses = ['/config/mute/2', '/dca/7/on', '/main/m/mix/on', '/main/st/mix/on', '/mtx/01/mix/on', '/bus/08/mix/01/on', '/fxrtn/02/mix/on', '/auxin/06/mix/on', '/auxin/05/mix/st', '/ch/07/mix/on'];
    const ranked = [...addresses].sort((a, b) => stripRank(a) - stripRank(b)).map((address) => deskSetting(address).strip);
    assert.deepEqual(ranked, ['Ch 7', 'Aux 5', 'Aux 6', 'FX Return 2', 'AuxMix', 'Matrix 1', 'Main LR', 'Mono', 'DCA 7', 'Mute Group 2']);
  });

  test('the strips each input on the X32 tab drives, so it can be marked while one is held', () => {
    const strips = Object.fromEntries(CONSOLE_CONFIG.INPUTS.map((input) => [input.ID, stripsOf(input)]));
    assert.deepEqual(strips, { aux: ['Aux 5'], mic: ['Ch 1', 'Ch 2'] });
  });
});
