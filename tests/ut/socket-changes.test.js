import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper } from './test-helpers.js';

// Safety net: pins the C2S -> S2C change/broadcast contract so it survives the
// upcoming clean-code refactor (layering / notifier extraction).
describe('Change Broadcast Tests', () => {
  test('changeVolume broadcasts volumeChanged to all clients', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.connect();
      await observer.connect();

      const observed = observer.waitFor('volumeChanged');
      actor.socket.emit('changeVolume', 37);

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

      const observed = observer.waitFor('muteChanged');
      actor.socket.emit('changeMute', 1);

      assert.strictEqual(await observed, 1);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });

  test('changeSong broadcasts song, default volume, and paused state', async () => {
    const actor = new SocketTestHelper();

    try {
      await actor.connect();

      const songP = actor.waitFor('songChanged');
      const volP = actor.waitFor('volumeChanged');
      const stateP = actor.waitFor('stateChanged');

      actor.socket.emit('changeSong', 'slow', 'fast');

      const [song, vol, state] = await Promise.all([songP, volP, stateP]);
      assert.strictEqual(song, 'fast');
      assert.strictEqual(vol, 35);  // DEFAULT_SONG_VOLUMES.fast
      assert.strictEqual(state, 0); // PLAYER_STATE.PAUSED
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

      const collected = observer.collectFor('lockChanged', 400);
      actor.socket.emit('changeVolume', 55);
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
