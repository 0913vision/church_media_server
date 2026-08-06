import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): The track library is fixed at boot, so it rides along with the handshake
// rather than needing a request of its own.
describe('Track Library Tests', () => {
  test('ready carries the manifest entries', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready } = await sock.open();

      assert.ok(ready.tracks.length > 0, 'manifest should list at least one track');
      for (const track of ready.tracks) {
        assert.strictEqual(typeof track.id, 'string');
        assert.strictEqual(typeof track.title, 'string');
        assert.ok(Number.isFinite(track.durationSec) && track.durationSec > 0);
      }
    } finally {
      sock.disconnect();
    }
  });

  test('file paths never reach a client', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready } = await sock.open();

      for (const track of ready.tracks) {
        assert.deepStrictEqual(Object.keys(track).sort(), ['durationSec', 'id', 'title', 'volume']);
      }
    } finally {
      sock.disconnect();
    }
  });

  test('the flow slot reads as idle until the flow engine runs one', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.open();
      assert.deepStrictEqual((await sock.read()).flow, { phase: 'idle' });
    } finally {
      sock.disconnect();
    }
  });

  test('a command this server does not implement is refused as unknown', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready } = await sock.open();
      assert.ok(!ready.commands.includes('rebootPi'), 'guard: this command is not part of the protocol');

      const rejected = sock.waitForRejected('rebootPi');
      sock.invoke('rebootPi', {});

      assert.strictEqual(await rejected, RejectReason.UNKNOWN_TARGET);
    } finally {
      sock.disconnect();
    }
  });
});
