import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';

// Note(yoochan.kim): valid playTrackAt is NOT exercised here — it would start
// audible playback on the host. Only the reply and rejection paths are tested.

before(() => ensureServer());
after(() => stopServer());

interface TrackInfo {
  id: string;
  title: string;
  durationSec: number;
}

async function fetchTracks(sock: SocketTestHelper): Promise<TrackInfo[]> {
  sock.socket!.emit('getTracks');
  return await sock.waitFor<TrackInfo[]>('tracksChanged');
}

describe('Track Library Tests', () => {
  test('getTracks replies with the manifest entries', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.connect();
      const tracks = await fetchTracks(sock);
      assert.ok(Array.isArray(tracks) && tracks.length > 0, 'manifest should list at least one track');
      for (const track of tracks) {
        assert.strictEqual(typeof track.id, 'string');
        assert.strictEqual(typeof track.title, 'string');
        assert.ok(Number.isFinite(track.durationSec) && track.durationSec > 0);
      }
    } finally {
      sock.disconnect();
    }
  });

  test('unknown track id is rejected (no trackChanged broadcast)', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.connect();
      const rejected = await sock.emitAndExpectNoResponse('playTrackAt', 'trackChanged', 500, 'no-such-track', 0);
      assert.strictEqual(rejected, true);
    } finally {
      sock.disconnect();
    }
  });

  test('out-of-range offsets are rejected (no trackChanged broadcast)', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.connect();
      const [track] = await fetchTracks(sock);
      assert.ok(track, 'manifest should list at least one track');

      const negative = await sock.emitAndExpectNoResponse('playTrackAt', 'trackChanged', 500, track.id, -5);
      assert.strictEqual(negative, true, 'negative offset should be rejected');

      const beyondEnd = await sock.emitAndExpectNoResponse('playTrackAt', 'trackChanged', 500, track.id, track.durationSec + 1);
      assert.strictEqual(beyondEnd, true, 'offset past the end should be rejected');
    } finally {
      sock.disconnect();
    }
  });
});
