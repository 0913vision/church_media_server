import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TrackLibrary from '../../server/tracks/TrackLibrary.ts';

// Note(yoochan.kim): how many songs the deck offers is the manifest's answer,
// not the code's — these build manifests on disk and read the answer back.

const AUDIO = path.resolve('./assets/audio/music_slow.mp3');
const OTHER_AUDIO = path.resolve('./assets/audio/music_fast.mp3');

let written = 0;

/** Writes a manifest to a temp file and loads a library from it. */
function library(entries: unknown[]): TrackLibrary {
  const file = path.join(os.tmpdir(), `cms-deck-${process.pid}-${written++}.json`);
  fs.writeFileSync(file, JSON.stringify(entries));
  try {
    return new TrackLibrary(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function track(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `${id} 곡`, file: AUDIO, durationSec: 100, ...extra };
}

describe('Deck songs come from the manifest', () => {
  test('every deck entry becomes a song, in manifest order', () => {
    const lib = library([
      track('third', { deck: { volume: 30 } }),
      track('first', { deck: { volume: 40 } }),
      track('second', { deck: { volume: 50 } }),
    ]);

    assert.deepStrictEqual(lib.deckSongs(), [
      { id: 'third', title: 'third 곡' },
      { id: 'first', title: 'first 곡' },
      { id: 'second', title: 'second 곡' },
    ]);
    assert.strictEqual(lib.defaultSong(), 'third', 'the deck starts on the first one listed');
  });

  test('a single deck song is a complete manifest', () => {
    const lib = library([track('only', { deck: { volume: 60 } })]);

    assert.strictEqual(lib.deckSongs().length, 1);
    assert.deepStrictEqual(lib.songVolumes(), { only: 60 });
  });

  test('a track without a deck is schedulable but not selectable', () => {
    const lib = library([
      track('song', { deck: { volume: 40 } }),
      { id: 'special', title: '특별 찬양', file: OTHER_AUDIO, durationSec: 200 },
    ]);

    assert.deepStrictEqual(lib.deckSongs().map((s) => s.id), ['song']);
    assert.strictEqual(lib.isDeckSong('special'), false);
    assert.strictEqual(lib.list().length, 2, 'a flow can still schedule it');
    assert.deepStrictEqual(Object.keys(lib.songFiles()), ['song'], 'the deck loads only its own');
  });

  test('a manifest with no deck song does not boot', () => {
    assert.throws(() => library([track('nothing-selectable')]), /no deck song/);
  });

  test('a deck song without a usable volume does not boot', () => {
    assert.throws(() => library([track('loud', { deck: {} })]), /volume/);
    assert.throws(() => library([track('loud', { deck: { volume: 140 } })]), /volume/);
  });
});
