import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD, SCRATCH_TRACK_ID } from './test-helpers.ts';
import { LevelFailure, MuteState, PlaybackState, RejectReason } from '../../server/protocol.ts';
import type { StatePatch } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

const auxIs = (patch: StatePatch, on: boolean): boolean =>
  patch.console?.some((input) => input.id === 'aux' && input.state.kind === 'read' && input.state.on === on) === true;

// Note(yoochan.kim): the mock desk has no meters, so only the wait shows here; level.unit.test.ts does the measuring.
describe('Level measurement over the wire', () => {
  test('keeps the deck and holds the music player\'s strip while it runs, and on a desk without meters plays nothing', async () => {
    const admin = new SocketTestHelper();
    let wasMuted = false;
    try {
      await admin.open('level-probe');
      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;

      const before = await admin.read();
      assert.notEqual(before.playback, PlaybackState.PLAYING, 'nothing may be playing for this test');
      wasMuted = before.mute === MuteState.MUTED;
      if (wasMuted) {
        admin.write('mute', MuteState.UNMUTED);
        await admin.waitForState((patch) => patch.mute !== undefined);
      }
      const auxOn = admin.waitForState((patch) => auxIs(patch, true));
      admin.invoke('enableConsoleInput', { input: 'aux' });
      await auxOn;
      admin.write('adminLock', true);
      await admin.waitForState((patch) => patch.adminLock === true);

      const measuring = admin.waitForState((patch) => patch.levelMatch?.phase === 'measuring');
      const output = { kind: 'output' };
      admin.invoke('matchTrackLevel', { track: SCRATCH_TRACK_ID, meter: output, targetDb: -30, span: { kind: 'whole' } });
      await measuring;

      admin.write('playback', PlaybackState.PLAYING);
      assert.equal(await admin.waitForRejected('playback'), RejectReason.LEVEL_MATCHING);
      admin.invoke('enableConsoleInput', { input: 'aux' });
      assert.equal(await admin.waitForRejected('enableConsoleInput'), RejectReason.CONSOLE_HELD);
      admin.invoke('matchTrackLevel', { track: SCRATCH_TRACK_ID, meter: output, targetDb: -30, span: { kind: 'whole' } });
      assert.equal(await admin.waitForRejected('matchTrackLevel'), RejectReason.LEVEL_MATCHING);

      const ended = await admin.waitForState((patch) => patch.levelMatch?.phase === 'failed', 10000);
      assert.ok(ended.levelMatch?.phase === 'failed');
      assert.equal(ended.levelMatch.why, LevelFailure.DESK_SILENT);
      assert.equal(ended.levelMatch.elapsedSec, 0, 'nothing played');
      const after = await admin.read();
      assert.equal(after.playback, PlaybackState.PAUSED);
      assert.ok(auxIs(after, true), 'the music player\'s strip is as it was');
    } finally {
      admin.write('adminLock', false);
      if (wasMuted) admin.write('mute', MuteState.MUTED);
      await new Promise((resolve) => setTimeout(resolve, 100));
      admin.disconnect();
    }
  });

  test('cannot be started without the gate, and there is nothing to stop', async () => {
    const admin = new SocketTestHelper();
    try {
      await admin.open('level-probe');
      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;

      admin.invoke('matchTrackLevel', { track: SCRATCH_TRACK_ID, meter: { kind: 'output' }, targetDb: -30, span: { kind: 'whole' } });
      assert.equal(await admin.waitForRejected('matchTrackLevel'), RejectReason.ADMIN_UNLOCKED);
      for (const command of ['stopLevelMatch', 'resumeLevelMatch', 'applyLevelMatch', 'cancelLevelMatch', 'revertLevelMatch']) {
        admin.invoke(command);
        assert.equal(await admin.waitForRejected(command), RejectReason.NOT_MEASURING, command);
      }
    } finally {
      admin.disconnect();
    }
  });
});
