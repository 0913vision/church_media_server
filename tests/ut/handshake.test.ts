import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';
import { C2S, PROTOCOL_VERSION, RejectReason, S2C } from '../../server/protocol.ts';
import type { S2CPayloads, StatePatch } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

const EXPECTED_ATTRIBUTES = [
  'playback', 'volume', 'mute', 'song', 'adminLock', 'audioLock', 'isAdmin', 'flow', 'clockOffsetSec', 'console',
];

describe('Handshake and Read Tests', () => {
  test('hello is answered with ready, then the full state', async () => {
    const helper = new SocketTestHelper();

    try {
      const { ready, state } = await helper.open();

      assert.strictEqual(ready.protocolVersion, PROTOCOL_VERSION);
      assert.strictEqual(ready.accepted, true);
      // Note(yoochan.kim): A client renders from this one patch, so every attribute must be there.
      assert.deepStrictEqual(Object.keys(state).sort(), [...EXPECTED_ATTRIBUTES].sort());
    } finally {
      helper.disconnect();
    }
  });

  test('ready enumerates what this server implements', async () => {
    const helper = new SocketTestHelper();

    try {
      const { ready } = await helper.open();

      assert.deepStrictEqual([...ready.attributes].sort(), [...EXPECTED_ATTRIBUTES].sort());
      // Note(yoochan.kim): Commands are advertised only when implemented, so a client can hide
      // controls for the rest instead of guessing.
      assert.ok(ready.commands.includes('authenticate'));
      assert.ok(ready.commands.includes('enableConsoleInput'));

      // Note(yoochan.kim): Songs are named by the server, so renaming one never means a client
      // release — the catalogue arrives with the handshake.
      assert.ok(ready.songs.length > 0);
      for (const song of ready.songs) {
        assert.strictEqual(typeof song.id, 'string');
        assert.ok(song.title.length > 0, 'every song carries a name to show');
      }
      assert.ok(Array.isArray(ready.tracks));

      // Note(yoochan.kim): Clients print this on their error screens, so it has to be there
      // before anything goes wrong.
      assert.ok(ready.contact.name.length > 0, 'someone is named as responsible');
      assert.ok(ready.contact.phone.length > 0, 'and can be called');
    } finally {
      helper.disconnect();
    }
  });

  test('read returns every attribute with a usable value', async () => {
    const helper = new SocketTestHelper();

    try {
      const { ready } = await helper.open();
      const state = await helper.read();

      assert.ok(['playing', 'paused'].includes(state.playback as string));
      assert.strictEqual(typeof state.volume, 'number');
      assert.ok((state.volume as number) >= 0 && (state.volume as number) <= 100);
      assert.ok(['muted', 'unmuted'].includes(state.mute as string));
      assert.ok(ready.songs.some((song) => song.id === state.song), 'the selected song is one the server offers');
      assert.strictEqual(typeof state.audioLock, 'boolean');
      assert.strictEqual(typeof state.adminLock, 'boolean');
      assert.strictEqual(state.isAdmin, false);
    } finally {
      helper.disconnect();
    }
  });

  test('the idle flow slot reads as a value, never as nothing', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.open();
      const state = await helper.read();

      // Note(yoochan.kim): Absence is spelled out, so a client cannot mistake "no flow" for
      // "this field was not sent".
      assert.deepStrictEqual(state.flow, { phase: 'idle' });
    } finally {
      helper.disconnect();
    }
  });

  test('an unknown protocol version is told to update, and its writes are refused', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const readyP = helper.waitFor<S2CPayloads['ready']>(S2C.READY);
      helper.socket!.emit(C2S.HELLO, { client: 'ancient-app', protocolVersion: PROTOCOL_VERSION + 99 });

      const ready = await readyP;
      assert.strictEqual(ready.accepted, false);
      assert.strictEqual(ready.protocolVersion, PROTOCOL_VERSION);

      // Note(yoochan.kim): State still flows, so a stale client can at least display something.
      const rejected = helper.waitForRejected('volume');
      helper.write('volume', 42);
      assert.strictEqual(await rejected, RejectReason.PROTOCOL_MISMATCH);
    } finally {
      helper.disconnect();
    }
  });

  // Note(yoochan.kim): every panel is on the current version now, so an older one
  // is refused again. ACCEPTED_VERSIONS is where a temporary exception would go.
  test('a panel one version behind is refused', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const readyP = helper.waitFor<S2CPayloads['ready']>(S2C.READY);
      helper.socket!.emit(C2S.HELLO, { client: 'one-behind', protocolVersion: PROTOCOL_VERSION - 1 });

      const ready = await readyP;
      assert.strictEqual(ready.accepted, false);
      assert.strictEqual(ready.protocolVersion, PROTOCOL_VERSION);
    } finally {
      helper.disconnect();
    }
  });

  test('writing before hello is refused', async () => {
    const helper = new SocketTestHelper();

    try {
      await helper.connect();
      const rejected = helper.waitForRejected('volume');
      helper.write('volume', 42);

      assert.strictEqual(await rejected, RejectReason.PROTOCOL_MISMATCH);
    } finally {
      helper.disconnect();
    }
  });

  test('attribute changes reach other clients as a state patch', async () => {
    const actor = new SocketTestHelper();
    const observer = new SocketTestHelper();

    try {
      await actor.open();
      await observer.open();

      const patch: StatePatch = await new Promise((resolve) => {
        observer.socket!.once(S2C.STATE, resolve);
        actor.write('volume', 41);
      });

      assert.ok('volume' in patch || 'audioLock' in patch, 'changes travel as state patches');
    } finally {
      actor.disconnect();
      observer.disconnect();
    }
  });
});
