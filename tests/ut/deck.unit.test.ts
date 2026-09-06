import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Note(yoochan.kim): TrackLibrary writes the manifest, so it imports the logger, which
// validates LOG_LEVEL at module load. Set it first and load the class dynamically.
type TrackLibraryCtor = typeof import('../../server/tracks/TrackLibrary.ts').default;
type Library = InstanceType<TrackLibraryCtor>;
let TrackLibrary: TrackLibraryCtor;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  TrackLibrary = (await import('../../server/tracks/TrackLibrary.ts')).default;
});

// Note(yoochan.kim): how many songs the deck offers is the manifest's answer,
// not the code's — these build manifests on disk and read the answer back.

const AUDIO = path.resolve('./assets/audio/music_slow.mp3');
const OTHER_AUDIO = path.resolve('./assets/audio/music_fast.mp3');

let written = 0;

/** Writes a manifest to a temp file and loads a library from it. */
function library(entries: unknown[]): Library {
  const file = path.join(os.tmpdir(), `cms-deck-${process.pid}-${written++}.json`);
  fs.writeFileSync(file, JSON.stringify(entries));
  try {
    return new TrackLibrary(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Writes a manifest and keeps it, so what the library writes back can be read. */
function onDisk(entries: unknown[]): { file: string; lib: Library } {
  const file = path.join(os.tmpdir(), `cms-deck-${process.pid}-${written++}.json`);
  fs.writeFileSync(file, JSON.stringify(entries));
  return { file, lib: new TrackLibrary(file) };
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
    assert.deepStrictEqual(lib.volumes(), [{ id: 'only', volume: 60 }]);
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

  test('a level someone changed is in the manifest the next boot reads', () => {
    const { file, lib } = onDisk([
      track('song', { userSelectable: true }),
      { id: 'special', title: '특별 찬양', file: OTHER_AUDIO, durationSec: 200, volume: 55 },
    ]);

    try {
      lib.setVolume('special', 70);
      assert.strictEqual(lib.volumeOf('special'), 70);

      // Note(yoochan.kim): read back from disk rather than from the object that wrote it.
      // What the write is for is the boot after this one.
      assert.strictEqual(new TrackLibrary(file).volumeOf('special'), 70);

      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
      assert.deepStrictEqual(saved.map((entry) => entry.volume), [40, 70], 'only the one asked for moved');
      assert.strictEqual(saved[0]!.userSelectable, true, 'the panel still offers what it offered');
      assert.strictEqual(saved[1]!.userSelectable, undefined);
      assert.strictEqual(saved[1]!.file, OTHER_AUDIO, 'the file is written as it was read');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('a level out of range leaves the manifest alone', () => {
    const { file, lib } = onDisk([track('song', { userSelectable: true })]);

    try {
      lib.setVolume('song', 140);
      lib.setVolume('nobody', 60);
      assert.strictEqual(lib.volumeOf('song'), 40);
      assert.strictEqual(new TrackLibrary(file).volumeOf('song'), 40);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
