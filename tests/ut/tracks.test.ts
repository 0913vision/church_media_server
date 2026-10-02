import { test, describe, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import {
  SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD, SCRATCH_TRACK_ID, SCRATCH_TRACK_FILE,
} from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';
import { formatInstant } from '../../server/utils/instant.ts';

before(() => ensureServer());
after(() => stopServer());

async function connectAuthedAdmin(client: string): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open(client);
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  await authed;
  return admin;
}

/**
 * Whether the scratch track is here to be renamed and deleted. A server started
 * elsewhere has none, and these tests must never pick a real one instead.
 */
async function hasScratch(admin: SocketTestHelper, t: TestContext): Promise<boolean> {
  const present = ((await admin.read()).tracks ?? []).some((track) => track.id === SCRATCH_TRACK_ID);
  if (!present) t.skip('no scratch track on an externally started server');
  return present;
}

function clock(offsetMinutes: number): string {
  return formatInstant(new Date(Date.now() + offsetMinutes * 60_000));
}

// Note(yoochan.kim): tracks are added and deleted while clients are connected, so the
// library is state rather than part of the handshake.
describe('Track Library Tests', () => {
  test('the tracks attribute carries the manifest entries', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready, state } = await sock.open();

      assert.ok(ready.attributes.includes('tracks'));
      assert.ok(!('tracks' in ready), 'the library is no longer fixed at boot');
      assert.ok(state.tracks!.length > 0, 'manifest should list at least one track');
      for (const track of state.tracks!) {
        assert.strictEqual(typeof track.id, 'string');
        assert.strictEqual(typeof track.title, 'string');
        assert.ok(Number.isFinite(track.durationSec) && track.durationSec > 0);
        assert.ok(Number.isInteger(track.volume) && track.volume >= 0 && track.volume <= 100);
      }
    } finally {
      sock.disconnect();
    }
  });

  test('file paths never reach a client', async () => {
    const sock = new SocketTestHelper();
    try {
      const { state } = await sock.open();

      for (const track of state.tracks!) {
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

// Note(yoochan.kim): only the scratch track is ever renamed or deleted here. It is a
// silent copy in the test's own folder, so nothing these do reaches the room
// or the library this building plays from.
describe('Renaming and deleting tracks', () => {
  test('only an admin renames or deletes', async () => {
    const anyone = new SocketTestHelper();
    try {
      await anyone.open('tracks-anyone');
      for (const [command, args] of [
        ['renameTrack', { id: SCRATCH_TRACK_ID, title: '누구나' }],
        ['deleteTrack', { id: SCRATCH_TRACK_ID }],
      ] as const) {
        const refused = anyone.waitForRejected(command);
        anyone.invoke(command, args);
        assert.strictEqual(await refused, RejectReason.NOT_ADMIN, command);
      }
    } finally {
      anyone.disconnect();
    }
  });

  test('a panel song keeps its name and its place', async () => {
    const admin = new SocketTestHelper();
    try {
      const { ready } = await admin.open('tracks-admin');
      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;
      const song = ready.songs[0]!.id;

      const renamed = admin.waitForRejected('renameTrack');
      admin.invoke('renameTrack', { id: song, title: '다른 이름' });
      assert.strictEqual(await renamed, RejectReason.DECK_SONG);

      const deleted = admin.waitForRejected('deleteTrack');
      admin.invoke('deleteTrack', { id: song });
      assert.strictEqual(await deleted, RejectReason.DECK_SONG);
    } finally {
      admin.disconnect();
    }
  });

  test('what does not check out is refused before anything moves', async () => {
    const admin = await connectAuthedAdmin('tracks-admin');
    try {
      const taken = (await admin.read()).tracks![0]!.title;
      const cases: [string, Record<string, unknown>, RejectReason][] = [
        ['renameTrack', { id: 'no-such-track', title: '이름' }, RejectReason.UNKNOWN_TRACK],
        ['renameTrack', { id: SCRATCH_TRACK_ID, title: '   ' }, RejectReason.INVALID_VALUE],
        ['renameTrack', { id: SCRATCH_TRACK_ID }, RejectReason.INVALID_VALUE],
        ['renameTrack', { id: SCRATCH_TRACK_ID, title: ` ${taken} ` }, RejectReason.TITLE_TAKEN],
        ['deleteTrack', { id: 'no-such-track' }, RejectReason.UNKNOWN_TRACK],
        ['deleteTrack', {}, RejectReason.INVALID_VALUE],
      ];
      for (const [command, args, reason] of cases) {
        const refused = admin.waitForRejected(command);
        admin.invoke(command, args);
        assert.strictEqual(await refused, reason, `${command} ${JSON.stringify(args)}`);
      }
    } finally {
      admin.disconnect();
    }
  });

  test('a renamed track keeps its id, so whatever names it still does', async (t) => {
    const admin = await connectAuthedAdmin('tracks-admin');
    try {
      if (!(await hasScratch(admin, t))) return;

      const observed = admin.waitForState((patch) => patch.tracks !== undefined);
      admin.invoke('renameTrack', { id: SCRATCH_TRACK_ID, title: '  이름 바뀐 곡 ' });
      const renamed = (await observed).tracks!.find((track) => track.id === SCRATCH_TRACK_ID);
      assert.strictEqual(renamed?.title, '이름 바뀐 곡', 'the spaces around it are not part of a name');
    } finally {
      admin.disconnect();
    }
  });

  test('a track the calendar, a run or the deck still needs cannot be deleted', async (t) => {
    const admin = await connectAuthedAdmin('tracks-admin');
    try {
      if (!(await hasScratch(admin, t))) return;
      const cue = [{ id: SCRATCH_TRACK_ID, volume: 40 }];

      // Note(yoochan.kim): the calendar names it.
      const saved = admin.waitForState((patch) => patch.schedule !== undefined);
      admin.invoke('saveFlow', {
        flow: {
          id: 'uses-scratch', name: '시험', weekdays: ['wed'], autoStart: false,
          lock: { at: '19:30', until: { kind: 'music' } },
          parts: [{ kind: 'music', tracks: cue, endsAt: '20:00' }],
        },
      });
      await saved;
      const byCalendar = admin.waitForRejected('deleteTrack');
      admin.invoke('deleteTrack', { id: SCRATCH_TRACK_ID });
      assert.strictEqual(await byCalendar, RejectReason.TRACK_IN_USE, 'a calendar entry names it');
      const unsaved = admin.waitForState((patch) => patch.schedule !== undefined);
      admin.invoke('deleteFlow', { id: 'uses-scratch' });
      await unsaved;

      // Note(yoochan.kim): a run that copied it and has yet to play it. Its music is
      // due fifty minutes out and the run is stopped long before.
      const holding = admin.waitForState((patch) => patch.flow?.phase === 'holding');
      admin.invoke('startFlow', {
        id: 'flow-scratch', name: '시험', lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'music', tracks: cue, endsAt: clock(50) }],
      });
      await holding;
      const byRun = admin.waitForRejected('deleteTrack');
      admin.invoke('deleteTrack', { id: SCRATCH_TRACK_ID });
      assert.strictEqual(await byRun, RejectReason.TRACK_IN_USE, 'the run in flight names it');
      const idle = admin.waitForState((patch) => patch.flow?.phase === 'idle');
      admin.invoke('stopFlow', {});
      await idle;

      // Note(yoochan.kim): on the deck, paused at its start. Nothing is played.
      const held = admin.waitForState((patch) => patch.adminLock === true);
      admin.write('adminLock', true);
      await held;
      const onDeck = admin.waitForState((patch) => patch.deck?.source === 'track');
      admin.invoke('selectTrack', { id: SCRATCH_TRACK_ID });
      await onDeck;
      const byDeck = admin.waitForRejected('deleteTrack');
      admin.invoke('deleteTrack', { id: SCRATCH_TRACK_ID });
      assert.strictEqual(await byDeck, RejectReason.TRACK_IN_USE, 'it is on the deck');
      const released = admin.waitForState((patch) => patch.deck?.source === 'song');
      admin.write('adminLock', false);
      await released;

      assert.ok(fs.existsSync(SCRATCH_TRACK_FILE), 'every refusal left the audio alone');
    } finally {
      admin.disconnect();
    }
  });

  test('a deleted track leaves the library, and its audio goes with it', async (t) => {
    const admin = await connectAuthedAdmin('tracks-admin');
    try {
      if (!(await hasScratch(admin, t))) return;

      const observed = admin.waitForState((patch) => patch.tracks !== undefined);
      admin.invoke('deleteTrack', { id: SCRATCH_TRACK_ID });
      const patch = await observed;
      assert.ok(!patch.tracks!.some((track) => track.id === SCRATCH_TRACK_ID));
      assert.strictEqual(fs.existsSync(SCRATCH_TRACK_FILE), false);
    } finally {
      admin.disconnect();
    }
  });
});
