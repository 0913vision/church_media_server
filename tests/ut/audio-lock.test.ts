import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';
import { MuteState, PlaybackState, RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// The audio lock is held for the whole play/pause fade (~3s). A contending
// audio write during that window must be refused as deviceBusy — not as a
// permission problem — and must work again once the lock is released.
//
// The player is muted first so the device volume is 0 throughout: this test is
// silent regardless of system volume.
describe('Audio Lock Contention Tests', () => {
  test('a second audio write during a fade is refused as device busy', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.open();
      await observer.open();

      // Keep the device silent for the whole test
      const muted = actor.waitForState((patch) => patch.mute !== undefined);
      actor.write('mute', MuteState.MUTED);
      assert.strictEqual((await muted).mute, MuteState.MUTED);

      // Start from paused (robust against an externally running server)
      if ((await actor.read()).playback === PlaybackState.PLAYING) {
        const paused = actor.waitForState((patch) => patch.playback !== undefined, 8000);
        actor.write('playback', PlaybackState.PAUSED);
        assert.strictEqual((await paused).playback, PlaybackState.PAUSED);
      }

      // The setup writes above also took the audio lock. Drain them with a read
      // round-trip (the server answers in order), so the listeners below can
      // only see the play operation's lock transitions.
      assert.strictEqual((await observer.read()).audioLock, false);

      // Play: the ~3s fade-in holds the audio lock
      const lockAcquired = observer.waitForState((patch) => patch.audioLock === true);
      actor.write('playback', PlaybackState.PLAYING);
      await lockAcquired;

      // Register for the release BEFORE contending, so it cannot be missed
      const lockReleased = observer.waitForState((patch) => patch.audioLock === false, 8000);

      // Contention: a volume write during the fade is refused, and the client
      // is told the device is busy rather than being left to guess.
      const rejected = observer.waitForRejected('volume');
      observer.write('volume', 60);
      assert.strictEqual(await rejected, RejectReason.DEVICE_BUSY);

      // Fade completes: playback is announced and the lock released
      const playing = await actor.waitForState((patch) => patch.playback !== undefined, 8000);
      assert.strictEqual(playing.playback, PlaybackState.PLAYING);
      await lockReleased;

      // After release the same write succeeds
      const accepted = actor.waitForState((patch) => patch.volume !== undefined);
      actor.write('volume', 60);
      assert.strictEqual((await accepted).volume, 60);

      // Cleanup: back to paused, unmuted
      const pausedAgain = actor.waitForState((patch) => patch.playback !== undefined, 8000);
      actor.write('playback', PlaybackState.PAUSED);
      assert.strictEqual((await pausedAgain).playback, PlaybackState.PAUSED);

      const unmuted = actor.waitForState((patch) => patch.mute !== undefined);
      actor.write('mute', MuteState.UNMUTED);
      assert.strictEqual((await unmuted).mute, MuteState.UNMUTED);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });
});
