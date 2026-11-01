import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD, SCRATCH_TRACK_ID,
} from './test-helpers.ts';
import { MuteState, PlaybackState } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): a fade is told by how long it holds the audio lock; muted first, so nothing reaches speakers.
const FADED_MS = 1500;
const AT_ONCE_MS = 500;

async function lockFree(socket: SocketTestHelper): Promise<void> {
  for (let tries = 0; tries < 80 && (await socket.read()).audioLock; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.strictEqual((await socket.read()).audioLock, false);
}

/** Both lock ends are listened for before the press, since a start at once lets go in the same breath. */
async function pressPlay(socket: SocketTestHelper): Promise<number> {
  await lockFree(socket);
  let takenAt = 0;
  let freedAt = 0;
  const taken = socket.waitForState((patch) => patch.audioLock === true).then(() => { takenAt = Date.now(); });
  const freed = socket.waitForState((patch) => patch.audioLock === false, 8000).then(() => { freedAt = Date.now(); });
  socket.write('playback', PlaybackState.PLAYING);
  await Promise.all([taken, freed]);
  return freedAt - takenAt;
}

async function pause(socket: SocketTestHelper): Promise<void> {
  await lockFree(socket);
  if ((await socket.read()).playback !== PlaybackState.PAUSED) {
    const paused = socket.waitForState((patch) => patch.playback === PlaybackState.PAUSED, 8000);
    socket.write('playback', PlaybackState.PAUSED);
    await paused;
  }
  await lockFree(socket);
}

describe('Pressing play on the player', () => {
  test('the app\'s own songs fade in wherever they are; any other track at its beginning starts at once', async (t) => {
    const admin = new SocketTestHelper();
    try {
      const { ready } = await admin.open('fade-test');
      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;
      if (!(await admin.read()).tracks?.some((track) => track.id === SCRATCH_TRACK_ID)) {
        t.skip('no scratch track on this server');
        return;
      }

      const muted = admin.waitForState((patch) => patch.mute !== undefined);
      admin.write('mute', MuteState.MUTED);
      assert.strictEqual((await muted).mute, MuteState.MUTED);
      await pause(admin);

      // Note(yoochan.kim): the panel's own song, wherever it stands.
      assert.deepStrictEqual((await admin.read()).deck, { source: 'song' });
      const song = await pressPlay(admin);
      assert.ok(song >= FADED_MS, `the panel's song held the lock ${song}ms`);
      await pause(admin);

      const held = admin.waitForState((patch) => patch.adminLock === true);
      admin.write('adminLock', true);
      await held;

      // Note(yoochan.kim): a library track that is not one of the app's songs, at its beginning.
      const scratchOn = admin.waitForState((patch) => patch.deck?.source === 'track');
      admin.invoke('selectTrack', { id: SCRATCH_TRACK_ID });
      await scratchOn;
      const scratch = await pressPlay(admin);
      assert.ok(scratch < AT_ONCE_MS, `a track at its beginning held the lock ${scratch}ms`);
      await pause(admin);

      // Note(yoochan.kim): one of the app's songs, put on as a library track, at its beginning.
      const appSongOn = admin.waitForState((patch) => patch.deck?.source === 'track' && patch.deck.id === ready.songs[0]!.id);
      admin.invoke('selectTrack', { id: ready.songs[0]!.id });
      await appSongOn;
      const appSong = await pressPlay(admin);
      assert.ok(appSong >= FADED_MS, `an app song at its beginning held the lock ${appSong}ms`);
      await pause(admin);

      const released = admin.waitForState((patch) => patch.adminLock === false);
      admin.write('adminLock', false);
      await released;
      await lockFree(admin);
    } finally {
      if (admin.socket?.connected) {
        const unmuted = admin.waitForState((patch) => patch.mute !== undefined);
        admin.write('mute', MuteState.UNMUTED);
        await unmuted.catch(() => {});
      }
      admin.disconnect();
    }
  });
});
