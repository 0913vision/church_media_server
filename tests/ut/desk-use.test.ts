import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD, TEST_PORT, SCRATCH_TRACK_ID } from './test-helpers.ts';
import { DeskUser, LevelFailure, MuteState, PlaybackState, RejectReason } from '../../server/protocol.ts';
import type { StatePatch } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

const AUX5_MAIN = '/auxin/05/mix/st';

/** A hand on the mock desk, as someone at the X32 would move it. */
async function hand(address: string, value: number): Promise<void> {
  const res = await fetch(`http://localhost:${TEST_PORT}/mock/set`, { method: 'POST', body: JSON.stringify({ address, value }) });
  assert.equal(res.status, 204);
}

async function admin(name: string): Promise<SocketTestHelper> {
  const helper = new SocketTestHelper();
  await helper.open(name);
  const authed = helper.waitForState((patch) => patch.isAdmin !== undefined);
  helper.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  await authed;
  return helper;
}

// Note(yoochan.kim): the level measurement is the one hold the mock desk can show over the wire; it has no meters, so nothing plays.
describe('The desk in use, over the wire', () => {
  test('is an attribute every client reads, with a command to set a note aside', async () => {
    const helper = new SocketTestHelper();
    try {
      const { ready, state } = await helper.open('desk-use-probe');
      assert.ok(ready.attributes.includes('deskUse'));
      assert.ok(ready.commands.includes('dismissDeskNote'));
      assert.deepEqual(state.deskUse?.holds, [], 'nothing held while nothing runs');
      assert.ok(Array.isArray(state.deskUse?.notes));
    } finally {
      helper.disconnect();
    }
  });

  test('a hand on a held strip is shown while held, kept as a note once put back, and set aside only by an admin', async () => {
    const person = await admin('desk-use-admin');
    const viewer = new SocketTestHelper();
    let wasMuted = false;
    try {
      await viewer.open('desk-use-viewer');
      const before = await person.read();
      assert.notEqual(before.playback, PlaybackState.PLAYING, 'nothing may be playing for this test');
      wasMuted = before.mute === MuteState.MUTED;
      if (wasMuted) {
        person.write('mute', MuteState.UNMUTED);
        await person.waitForState((patch) => patch.mute !== undefined);
      }
      const notesBefore = before.deskUse!.notes.length;
      person.write('adminLock', true);
      await person.waitForState((patch) => patch.adminLock === true);

      const held = viewer.waitForState((patch) => (patch.deskUse?.holds.length ?? 0) > 0);
      person.invoke('matchTrackLevel', { track: SCRATCH_TRACK_ID, meter: { kind: 'output' }, targetDb: -30, span: { kind: 'whole' } });
      const [holding] = (await held).deskUse!.holds;
      assert.equal(holding?.phase, 'holding');
      assert.equal(holding.by, DeskUser.LEVEL_MATCH);
      assert.deepEqual(holding.strips, ['Aux 5', 'Aux 6'], 'named as the desk names them');
      assert.deepEqual(holding.moved, []);
      const player = before.console!.find((input) => input.id === 'aux')!;
      assert.ok(player.strips.some((strip) => holding.strips.includes(strip)), 'the music player\'s row can be marked as held');

      const moved = viewer.waitForState((patch) => (patch.deskUse?.holds[0]?.moved.length ?? 0) > 0);
      const ended = person.waitForState((patch) => patch.levelMatch?.phase === 'failed');
      const noted = viewer.waitForState((patch) => patch.deskUse?.notes.length === notesBefore + 1);
      await hand(AUX5_MAIN, 1);
      const shown = (await moved).deskUse!.holds[0]!.moved;
      assert.deepEqual(shown.map(({ strip, setting }) => ({ strip, setting })), [{ strip: 'Aux 5', setting: 'Main LR' }]);

      const failed = (await ended).levelMatch;
      assert.ok(failed?.phase === 'failed');
      assert.equal(failed.why, LevelFailure.DESK_MOVED);
      const after: StatePatch = (await noted);
      assert.deepEqual(after.deskUse!.holds, [], 'held no longer');
      const note = after.deskUse!.notes.at(-1)!;
      assert.equal(note.by, DeskUser.LEVEL_MATCH);
      assert.deepEqual(note.moved.map(({ strip, setting }) => ({ strip, setting })), [{ strip: 'Aux 5', setting: 'Main LR' }]);

      viewer.invoke('dismissDeskNote', { id: note.id });
      assert.equal(await viewer.waitForRejected('dismissDeskNote'), RejectReason.NOT_ADMIN);
      person.invoke('dismissDeskNote', { id: 'no-such-note' });
      assert.equal(await person.waitForRejected('dismissDeskNote'), RejectReason.INVALID_VALUE);

      const gone = viewer.waitForState((patch) => patch.deskUse?.notes.length === notesBefore);
      person.invoke('dismissDeskNote', { id: note.id });
      assert.ok(!(await gone).deskUse!.notes.some((kept) => kept.id === note.id), 'every screen told it is gone');
      person.invoke('dismissDeskNote', { id: note.id });
      assert.equal(await person.waitForRejected('dismissDeskNote'), RejectReason.INVALID_VALUE, 'once only');
    } finally {
      person.write('adminLock', false);
      if (wasMuted) person.write('mute', MuteState.MUTED);
      await new Promise((resolve) => setTimeout(resolve, 100));
      person.disconnect();
      viewer.disconnect();
    }
  });
});
