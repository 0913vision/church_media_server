import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';
import { MuteState, PlaybackState, RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): the audio lock is held for a whole fade, which lasts seconds, so a write can land inside it.
describe('Audio Lock Contention Tests', () => {
  test('a second audio write during a fade is refused as device busy', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.open();
      await observer.open();

      // Note(yoochan.kim): muted first, so the test is silent whatever the system volume.
      const muted = actor.waitForState((patch) => patch.mute !== undefined);
      actor.write('mute', MuteState.MUTED);
      assert.strictEqual((await muted).mute, MuteState.MUTED);

      // Note(yoochan.kim): Start from playing (robust against an externally running server)
      if ((await actor.read()).playback !== PlaybackState.PLAYING) {
        const playing = actor.waitForState((patch) => patch.playback !== undefined, 8000);
        actor.write('playback', PlaybackState.PLAYING);
        assert.strictEqual((await playing).playback, PlaybackState.PLAYING);
      }

      // Note(yoochan.kim): setup writes took the lock too; wait it out so the listeners below see only the pause's.
      for (let tries = 0; tries < 50 && (await observer.read()).audioLock; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.strictEqual((await observer.read()).audioLock, false);

      // Note(yoochan.kim): pausing's fade, since a song at its beginning starts without one.
      const lockAcquired = observer.waitForState((patch) => patch.audioLock === true);
      actor.write('playback', PlaybackState.PAUSED);
      await lockAcquired;

      // Note(yoochan.kim): Register for the release BEFORE contending, so it cannot be missed
      const lockReleased = observer.waitForState((patch) => patch.audioLock === false, 8000);

      // Note(yoochan.kim): refused as deviceBusy, not as a permission problem, so the client need not guess.
      const rejected = observer.waitForRejected('volume');
      observer.write('volume', 60);
      assert.strictEqual(await rejected, RejectReason.DEVICE_BUSY);

      const paused = await actor.waitForState((patch) => patch.playback !== undefined, 8000);
      assert.strictEqual(paused.playback, PlaybackState.PAUSED);
      await lockReleased;

      const accepted = actor.waitForState((patch) => patch.volume !== undefined);
      actor.write('volume', 60);
      assert.strictEqual((await accepted).volume, 60);

      const unmuted = actor.waitForState((patch) => patch.mute !== undefined);
      actor.write('mute', MuteState.UNMUTED);
      assert.strictEqual((await unmuted).mute, MuteState.UNMUTED);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });
});
