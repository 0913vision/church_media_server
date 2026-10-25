import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  FLOOR_DB, dbFromLevel, levelFromDb, mpvVolumeFromDb, dbFromCubicLevel, fadeInDb, fadeOutDb,
} from '../../server/hardware/loudness.ts';

const near = (actual: number, expected: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, want ${expected}`);
};

// Note(yoochan.kim): what a number on the panel sounds like in the room, so pinned
// rather than trusted. The anchors are the X32 fader's own marks, 100 at 0 dB.
describe('A level as people hear it', () => {
  test('reads like the desk\'s fader', () => {
    near(dbFromLevel(100), 0, '100');
    near(dbFromLevel(90), -3, '90');
    near(dbFromLevel(70), -9, '70');
    near(dbFromLevel(50), -20, '50');
    near(dbFromLevel(30), -34, '30');
    near(dbFromLevel(10), -58, '10');
    assert.equal(dbFromLevel(0), -Infinity);
  });

  test('runs from the fader\'s -60 dB mark down to silence at -80', () => {
    near(dbFromLevel(levelFromDb(-60)), -60, 'the -60 mark');
    near(dbFromLevel(levelFromDb(-60) / 2), -70, 'halfway down');
    assert.equal(levelFromDb(FLOOR_DB), 0);
    assert.equal(levelFromDb(-200), 0);
  });

  test('reading a level back says the same thing', () => {
    for (let level = 1; level <= 100; level += 1) {
      near(levelFromDb(dbFromLevel(level)), level, `level ${level}`);
    }
  });

  test('a level past reach still says how far off it is', () => {
    near(levelFromDb(6), 120, '+6 dB');
  });

  test('becomes mpv\'s cubic volume', () => {
    near(mpvVolumeFromDb(0), 100, 'the file\'s own level');
    near(mpvVolumeFromDb(-60), 10, '-60 dB');
    assert.equal(mpvVolumeFromDb(-Infinity), 0);
  });

  test('the levels stored before keep their loudness', () => {
    const moved = (old: number): number => Math.round(levelFromDb(dbFromCubicLevel(old)));
    assert.equal(moved(100), 100);
    assert.equal(moved(50), 53);
    assert.equal(moved(45), 49);
    assert.equal(moved(35), 38);
    assert.equal(moved(0), 0);
  });
});

describe('A fade as people hear it', () => {
  for (const startDb of [-40, -25]) {
    for (const durationMs of [1000, 2000, 10_000]) {
      test(`over ${durationMs}ms from ${startDb} dB: up through the silent bottom quickly, then the same dB every moment`, () => {
        const quick = Math.min(300, durationMs / 10);
        assert.equal(fadeInDb(0, durationMs, startDb), FLOOR_DB);
        near(fadeInDb(quick, durationMs, startDb), startDb, 'heard once the quick part is over');
        assert.equal(fadeInDb(durationMs, durationMs, startDb), 0);

        const pace = -startDb / (durationMs - quick);
        for (let t = quick; t < durationMs; t += 50) {
          near(fadeInDb(t + 50, durationMs, startDb) - fadeInDb(t, durationMs, startDb), Math.min(50, durationMs - t) * pace, `${t}ms`);
        }
      });
    }
  }

  test('a fade out is a fade in run backwards', () => {
    for (let t = 0; t <= 2000; t += 50) {
      near(fadeOutDb(t, 2000, -25), fadeInDb(2000 - t, 2000, -25), `${t}ms`);
    }
    assert.equal(fadeOutDb(0, 2000, -25), 0);
    assert.equal(fadeOutDb(2000, 2000, -25), FLOOR_DB);
  });
});
