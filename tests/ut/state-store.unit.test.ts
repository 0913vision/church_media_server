import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeskUser, MuteState } from '../../server/protocol.ts';
import type { DeskNote } from '../../server/protocol.ts';
import { formatInstant } from '../../server/utils/instant.ts';

// Note(yoochan.kim): the logger reads its level as it loads, so it is set before the store comes in.
process.env.LOG_LEVEL ??= 'error';
const { default: FileStateStore } = await import('../../server/state/FileStateStore.ts');

const at = formatInstant(new Date());
const NOTE: DeskNote = { id: 'n1', at, by: DeskUser.COUNTDOWN, moved: [{ strip: 'Aux 5', setting: 'Mute', at }] };
const PREFERENCES = { serverVolume: 47, muted: MuteState.UNMUTED, currentSong: 'prayer' };

function scratchFile(contents?: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-state-')), 'state.json');
  if (contents !== undefined) fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe('Desk notes in the state file', () => {
  test('a note written down is read back after a restart', () => {
    const file = scratchFile();
    new FileStateStore(file).save({ ...PREFERENCES, clockOffsetSec: -8.363, deskJournal: [], deskNotes: [NOTE] });
    assert.deepEqual(new FileStateStore(file).load()?.deskNotes, [NOTE]);
  });

  test('a file from before notes existed has none', () => {
    const loaded = new FileStateStore(scratchFile({ ...PREFERENCES, clockOffsetSec: 0, deskJournal: [] })).load();
    assert.deepEqual(loaded?.deskNotes, []);
  });

  test('a damaged list is dropped without costing the rest of the file', () => {
    const broken = [{ ...NOTE, by: 'someone' }];
    const loaded = new FileStateStore(scratchFile({ ...PREFERENCES, clockOffsetSec: 1.5, deskJournal: [], deskNotes: broken })).load();
    assert.deepEqual(loaded?.deskNotes, []);
    assert.equal(loaded?.serverVolume, 47);
    assert.equal(loaded?.clockOffsetSec, 1.5);
  });
});
