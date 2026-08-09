import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { faderFromDb, dbFromFader } from '../../server/console/faderLevel.ts';

// Note(yoochan.kim): these numbers end up on a mixing desk in a room with
// people in it, so they are pinned rather than trusted. The anchors are the
// corners of the X32's own fader curve.
describe('Decibels as the desk wants them', () => {
  test('the curve meets its corners', () => {
    assert.equal(faderFromDb(10), 1);
    assert.equal(faderFromDb(0), 0.75);
    assert.equal(faderFromDb(-10), 0.5);
    assert.equal(faderFromDb(-30), 0.25);
    assert.equal(faderFromDb(-60), 0.0625);
    assert.equal(faderFromDb(-90), 0);
  });

  test('the levels this deployment actually sends', () => {
    assert.equal(faderFromDb(-9), 0.525);
    assert.equal(faderFromDb(0.7), 0.7675);
  });

  test('past either end it stops rather than running off', () => {
    assert.equal(faderFromDb(20), 1);
    assert.equal(faderFromDb(-120), 0);
  });

  test('reading a level back says the same thing', () => {
    for (const db of [10, 0.7, 0, -9, -10, -30, -60]) {
      assert.equal(dbFromFader(faderFromDb(db)), db, `${db} dB survives the round trip`);
    }
  });
});
