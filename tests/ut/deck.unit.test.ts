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
  return { id, title: `${id} 곡`, file: AUDIO, durationSec: 100, volume: 40, ...extra };
}

describe('Deck songs come from the manifest', () => {
  test('every userSelectable entry becomes a song, in manifest order', () => {
    const lib = library([
      track('third', { userSelectable: true }),
      track('first', { userSelectable: true }),
      track('second', { userSelectable: true }),
    ]);

    assert.deepStrictEqual(lib.deckSongs(), [
      { id: 'third', title: 'third 곡' },
      { id: 'first', title: 'first 곡' },
      { id: 'second', title: 'second 곡' },
    ]);
    assert.strictEqual(lib.defaultSong(), 'third', 'the deck starts on the first one listed');
  });

  test('a single song is a complete manifest', () => {
    const lib = library([track('only', { volume: 60, userSelectable: true })]);

    assert.strictEqual(lib.deckSongs().length, 1);
    assert.deepStrictEqual(lib.songVolumes(), { only: 60 });
  });

  test('a track nobody can select is schedulable, and still has a level of its own', () => {
    const lib = library([
      track('song', { userSelectable: true }),
      { id: 'special', title: '특별 찬양', file: OTHER_AUDIO, durationSec: 200, volume: 55 },
    ]);

    assert.deepStrictEqual(lib.deckSongs().map((s) => s.id), ['song']);
    assert.strictEqual(lib.isDeckSong('special'), false);
    assert.strictEqual(lib.list().length, 2, 'a flow can still schedule it');
    assert.strictEqual(lib.get('special')?.volume, 55, 'a flow can read its level');
    assert.deepStrictEqual(Object.keys(lib.songFiles()), ['song'], 'the deck loads only its own');
  });

  test('a manifest nobody can select from does not boot', () => {
    assert.throws(() => library([track('schedule-only')]), /no userSelectable track/);
  });

  test('every track needs a usable volume, selectable or not', () => {
    assert.throws(() => library([{ id: 'x', title: 'x', file: AUDIO, durationSec: 100 }]), /volume/);
    assert.throws(() => library([track('loud', { volume: 140, userSelectable: true })]), /volume/);
  });
});
