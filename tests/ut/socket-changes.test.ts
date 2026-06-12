import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';

before(() => ensureServer());
after(() => stopServer());

// Safety net: pins the C2S -> S2C change/broadcast contract so it survives
// refactors (layering / notifier extraction / TypeScript migration).
describe('Change Broadcast Tests', () => {
  test('changeVolume broadcasts volumeChanged to all clients', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.connect();
      await observer.connect();

      const observed = observer.waitFor<number>('volumeChanged');
      actor.socket!.emit('changeVolume', 37);

      assert.strictEqual(await observed, 37);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });

  test('changeMute broadcasts muteChanged to all clients', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.connect();
      await observer.connect();

      const observed = observer.waitFor<number>('muteChanged');
      actor.socket!.emit('changeMute', 1);

      assert.strictEqual(await observed, 1);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });

  test('changeSong broadcasts song, default volume, and paused state', async () => {
    const actor = new SocketTestHelper();
    const DEFAULT_SONG_VOLUMES: Record<string, number> = { slow: 50, fast: 35 };

    try {
      await actor.connect();

      // Server state is shared/persistent: switch to whichever song is NOT
      // current so the test is robust across reruns.
      const current = await actor.emitAndWaitFor<string>('getCurrentSong', 'songChanged');
      const target = current === 'slow' ? 'fast' : 'slow';

      const songP = actor.waitFor<string>('songChanged');
      const volP = actor.waitFor<number>('volumeChanged');
      const stateP = actor.waitFor<number>('stateChanged');

      actor.socket!.emit('changeSong', current, target);

      const [song, vol, state] = await Promise.all([songP, volP, stateP]);
      assert.strictEqual(song, target);
      assert.strictEqual(vol, DEFAULT_SONG_VOLUMES[target]);
      assert.strictEqual(state, 0); // PlayerState.PAUSED
    } finally {
      actor.disconnect();
    }
  });

  test('rejects an out-of-range volume (no broadcast)', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.connect();
      const rejected = await actor.emitAndExpectNoResponse('changeVolume', 'volumeChanged', 400, 150);
      assert.strictEqual(rejected, true);
    } finally {
      actor.disconnect();
    }
  });

  test('rejects a non-numeric volume (no broadcast)', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.connect();
      const rejected = await actor.emitAndExpectNoResponse('changeVolume', 'volumeChanged', 400, 'loud');
      assert.strictEqual(rejected, true);
    } finally {
      actor.disconnect();
    }
  });

  test('rejects an unknown song (no broadcast)', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.connect();
      const rejected = await actor.emitAndExpectNoResponse('changeSong', 'songChanged', 400, 'slow', 'metal');
      assert.strictEqual(rejected, true);
    } finally {
      actor.disconnect();
    }
  });

  test('ignores a change to the already-current song (no broadcast)', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.connect();
      const current = await actor.emitAndWaitFor<string>('getCurrentSong', 'songChanged');
      const rejected = await actor.emitAndExpectNoResponse('changeSong', 'songChanged', 400, current, current);
      assert.strictEqual(rejected, true);
    } finally {
      actor.disconnect();
    }
  });

  test('rejects an invalid playback state (no broadcast)', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.connect();
      const rejected = await actor.emitAndExpectNoResponse('changeState', 'stateChanged', 400, 2);
      assert.strictEqual(rejected, true);
    } finally {
      actor.disconnect();
    }
  });

  test('rejects an invalid mute value (no broadcast)', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.connect();
      const rejected = await actor.emitAndExpectNoResponse('changeMute', 'muteChanged', 400, 5);
      assert.strictEqual(rejected, true);
    } finally {
      actor.disconnect();
    }
  });

  test('an audio change broadcasts lockChanged true then false', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.connect();
      await observer.connect();

      const collected = observer.collectFor<boolean>('lockChanged', 400);
      actor.socket!.emit('changeVolume', 55);
      const events = await collected;

      assert.ok(events.includes(true), 'should broadcast audio lock acquired');
      assert.ok(events.includes(false), 'should broadcast audio lock released');
      assert.strictEqual(events[0], true, 'acquire must come first');
      assert.strictEqual(events[events.length - 1], false, 'release must come last');
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });
});
