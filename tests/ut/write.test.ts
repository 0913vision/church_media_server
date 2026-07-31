import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';
import { MuteState, PlaybackState, RejectReason, SongType } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

const DEFAULT_SONG_VOLUMES: Record<string, number> = { slow: 50, fast: 35 };

// Safety net: pins the write -> state contract, and the refusal reasons a
// client relies on to explain why nothing happened.
describe('Write Tests', () => {
  test('a volume write reaches every client', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.open();
      await observer.open();

      const observed = observer.waitForState((patch) => patch.volume !== undefined);
      actor.write('volume', 37);

      assert.strictEqual((await observed).volume, 37);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });

  test('a mute write reaches every client', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.open();
      await observer.open();

      const current = (await actor.read()).mute;
      const target = current === MuteState.MUTED ? MuteState.UNMUTED : MuteState.MUTED;

      const observed = observer.waitForState((patch) => patch.mute !== undefined);
      actor.write('mute', target);

      assert.strictEqual((await observed).mute, target);
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });

  test('a song write reports song, default volume and pause in one patch', async () => {
    const actor = new SocketTestHelper();

    try {
      await actor.open();

      // Server state is shared and persistent: switch to whichever song is not
      // current so the test is robust across reruns.
      const current = (await actor.read()).song;
      const target = current === SongType.SLOW ? SongType.FAST : SongType.SLOW;

      const observed = actor.waitForState((patch) => patch.song !== undefined);
      actor.write('song', target);

      // Switching a song changes three things at once, and one patch carrying
      // all of them is what keeps a client from rendering a half-applied state.
      const patch = await observed;
      assert.strictEqual(patch.song, target);
      assert.strictEqual(patch.volume, DEFAULT_SONG_VOLUMES[target]);
      assert.strictEqual(patch.playback, PlaybackState.PAUSED);
    } finally {
      actor.disconnect();
    }
  });

  test('an audio write brackets itself with the audio lock', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.open();
      await observer.open();

      const collected = observer.collectStates(400);
      actor.write('volume', 55);
      const locks = (await collected)
        .filter((patch) => patch.audioLock !== undefined)
        .map((patch) => patch.audioLock);

      assert.ok(locks.includes(true), 'should announce the lock being taken');
      assert.ok(locks.includes(false), 'should announce the lock being released');
      assert.strictEqual(locks[0], true, 'acquire must come first');
      assert.strictEqual(locks[locks.length - 1], false, 'release must come last');
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });
});

describe('Write Rejection Tests', () => {
  test('an out-of-range volume is refused as an invalid value', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('volume');
      actor.write('volume', 150);

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      actor.disconnect();
    }
  });

  test('a non-numeric volume is refused as an invalid value', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('volume');
      actor.write('volume', 'loud');

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      actor.disconnect();
    }
  });

  test('an unknown song is refused as an invalid value', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('song');
      actor.write('song', 'metal');

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      actor.disconnect();
    }
  });

  test('an invalid playback value is refused as an invalid value', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('playback');
      actor.write('playback', 2);

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      actor.disconnect();
    }
  });

  test('an unknown attribute is refused as an unknown target', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('tempo');
      actor.write('tempo', 120);

      assert.strictEqual(await rejected, RejectReason.UNKNOWN_TARGET);
    } finally {
      actor.disconnect();
    }
  });

  test('a read-only attribute is refused as not writable', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('audioLock');
      actor.write('audioLock', true);

      assert.strictEqual(await rejected, RejectReason.NOT_WRITABLE);
    } finally {
      actor.disconnect();
    }
  });

  test('setting the admin lock without admin rights is refused', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const rejected = actor.waitForRejected('adminLock');
      actor.write('adminLock', true);

      assert.strictEqual(await rejected, RejectReason.NOT_ADMIN);
    } finally {
      actor.disconnect();
    }
  });

  test('writing the song that is already current changes nothing, and is not an error', async () => {
    const actor = new SocketTestHelper();
    try {
      await actor.open();
      const current = (await actor.read()).song as string;

      const quiet = actor.expectNoState((patch) => patch.song !== undefined, 400);
      actor.write('song', current);

      assert.strictEqual(await quiet, true, 'a no-op write should not broadcast');
    } finally {
      actor.disconnect();
    }
  });
});
