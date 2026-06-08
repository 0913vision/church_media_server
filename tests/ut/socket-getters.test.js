import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper } from './test-helpers.js';

describe('Socket Getter Tests', () => {
  test('should get current state', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const state = await helper.emitAndWaitFor('getState', 'stateChanged');

      assert.strictEqual(typeof state, 'number');
      assert.ok([0, 1].includes(state));
    } finally {
      helper.disconnect();
    }
  });

  test('should get current volume', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const volume = await helper.emitAndWaitFor('getVolume', 'volumeChanged');

      assert.strictEqual(typeof volume, 'number');
      assert.ok(volume >= 0 && volume <= 100);
    } finally {
      helper.disconnect();
    }
  });

  test('should get mute state', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const mute = await helper.emitAndWaitFor('getMute', 'muteChanged');

      assert.strictEqual(typeof mute, 'number');
      assert.ok([0, 1].includes(mute));
    } finally {
      helper.disconnect();
    }
  });

  test('should get current song', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const song = await helper.emitAndWaitFor('getCurrentSong', 'songChanged');

      assert.strictEqual(typeof song, 'string');
      assert.ok(['slow', 'fast'].includes(song));
    } finally {
      helper.disconnect();
    }
  });

  test('should get audio lock status (lockChanged)', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const lock = await helper.emitAndWaitFor('getLock', 'lockChanged');

      assert.strictEqual(typeof lock, 'boolean');
    } finally {
      helper.disconnect();
    }
  });

  test('should get admin lock status (adminLockChanged) on its own event', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const adminLock = await helper.emitAndWaitFor('getLock', 'adminLockChanged');

      // Verify the protocol: admin lock is reported as a boolean on its own,
      // separate event. (The value is global server state that other tests may
      // toggle, so we assert the type, not a specific value.)
      assert.strictEqual(typeof adminLock, 'boolean');
    } finally {
      helper.disconnect();
    }
  });
});
