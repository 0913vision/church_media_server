import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';

before(() => ensureServer());
after(() => stopServer());

// The audio lock is held for the whole play/pause fade (~3s). A contending
// audio request during that window must be rejected (no broadcast), and must
// work again once the lock is released.
//
// The player is muted first so the device volume is 0 throughout — this test
// is silent regardless of system volume.
describe('Audio Lock Contention Tests', () => {
  test('rejects a second audio operation while a fade holds the lock', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.connect();
      await observer.connect();

      // Keep the device silent for the whole test
      assert.strictEqual(await actor.emitAndWaitFor<number>('changeMute', 'muteChanged', 1), 1);

      // Start from paused (robust against an externally running server)
      const state = await actor.emitAndWaitFor<number>('getState', 'stateChanged');
      if (state === 1) {
        const paused = actor.waitFor<number>('stateChanged', 8000);
        actor.socket!.emit('changeState', 0);
        assert.strictEqual(await paused, 0);
      }

      // The setup ops above also held the audio lock and broadcast
      // lockChanged true/false. Drain them with a GET round-trip on the
      // observer (the server replies in order), so the listeners below can
      // only ever see the play operation's lock events.
      assert.strictEqual(await observer.emitAndWaitFor<boolean>('getLock', 'lockChanged'), false);

      // Play: the ~3s fade-in holds the audio lock
      const lockAcquired = observer.waitFor<boolean>('lockChanged');
      actor.socket!.emit('changeState', 1);
      assert.strictEqual(await lockAcquired, true);

      // Register for the release BEFORE contending, so it cannot be missed
      const lockReleased = observer.waitFor<boolean>('lockChanged', 8000);

      // Contention: a volume change during the fade must be rejected
      const rejected = await observer.emitAndExpectNoResponse('changeVolume', 'volumeChanged', 500, 60);
      assert.strictEqual(rejected, true, 'audio op during fade should be rejected');

      // Fade completes: state broadcast and lock release
      const playing = await actor.waitFor<number>('stateChanged', 8000);
      assert.strictEqual(playing, 1);
      assert.strictEqual(await lockReleased, false);

      // After release the same operation succeeds
      assert.strictEqual(await actor.emitAndWaitFor<number>('changeVolume', 'volumeChanged', 60), 60);

      // Cleanup: back to paused, unmuted
      const pausedAgain = actor.waitFor<number>('stateChanged', 8000);
      actor.socket!.emit('changeState', 0);
      assert.strictEqual(await pausedAgain, 0);
      assert.strictEqual(await actor.emitAndWaitFor<number>('changeMute', 'muteChanged', 0), 0);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });
});
