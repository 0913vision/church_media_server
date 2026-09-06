import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';
import type { ScheduleEntry } from '../../server/protocol.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): the calendar lives on the server now, so these run over the wire like
// any other state. Every entry here is lock-only: a music part would make the
// host audible, and the timeline is FlowRunner's to prove.
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function entry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `${id} 예배`,
    weekdays: ['wed'],
    autoStart: false,
    lock: { at: '19:30', until: { kind: 'clock', at: '21:30' } },
    parts: [],
    ...extra,
  };
}

/** A track this server actually has, learned from ready rather than assumed. */
let someTrackId = '';

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  const { ready } = await admin.open('schedule-admin');
  someTrackId = ready.tracks[0]!.id;
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  await authed;
  return admin;
}

async function saved(admin: SocketTestHelper, flow: Record<string, unknown>): Promise<ScheduleEntry[]> {
  const observed = admin.waitForState((patch) => patch.schedule !== undefined);
  admin.invoke('saveFlow', { flow });
  return (await observed).schedule!;
}

async function clear(admin: SocketTestHelper): Promise<void> {
  for (const flow of (await admin.read()).schedule ?? []) {
    const gone = admin.waitForState((patch) => patch.schedule !== undefined);
    admin.invoke('deleteFlow', { id: flow.id });
    await gone;
  }
}

describe('Schedule Tests', () => {
  test('the calendar is state, and only an admin moves it', async () => {
    const anyone = new SocketTestHelper();
    await anyone.open('schedule-anyone');
    const admin = await connectAuthedAdmin();

    try {
      assert.ok(Array.isArray((await anyone.read()).schedule), 'everyone can read the calendar');

      const refused = anyone.waitForRejected('saveFlow');
      anyone.invoke('saveFlow', { flow: entry('by-anyone') });
      assert.strictEqual(await refused, RejectReason.NOT_ADMIN);

      const list = await saved(admin, entry('wed-test'));
      assert.deepStrictEqual(list.map((each) => each.id), ['wed-test']);
      assert.deepStrictEqual(list[0]!.weekdays, ['wed']);

      // Note(yoochan.kim): a known id replaces in place rather than appending, or editing
      // a flow would quietly leave the old one behind it.
      const renamed = await saved(admin, entry('wed-test', { name: '이름 바뀜' }));
      assert.strictEqual(renamed.length, 1);
      assert.strictEqual(renamed[0]!.name, '이름 바뀜');

      const gone = admin.waitForState((patch) => patch.schedule !== undefined);
      admin.invoke('deleteFlow', { id: 'wed-test' });
      assert.deepStrictEqual((await gone).schedule, []);
    } finally {
      await clear(admin).catch(() => {});
      anyone.disconnect();
      admin.disconnect();
    }
  });

  test('an entry the next boot would refuse is refused now', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const cases: [string, Record<string, unknown>][] = [
        ['no weekdays', entry('bad', { weekdays: [] })],
        ['a weekday nobody has', entry('bad', { weekdays: ['funday'] })],
        ['no lock', entry('bad', { lock: undefined })],
        ['a clock that is not one', entry('bad', { lock: { at: '25:00', until: { kind: 'clock', at: '21:30' } } })],
        ['until the music, with no music', entry('bad', { lock: { at: '19:30', until: { kind: 'music' } } })],
        ['a nameless entry', entry('bad', { name: '' })],
      ];

      for (const [what, flow] of cases) {
        const refused = admin.waitForRejected('saveFlow');
        admin.invoke('saveFlow', { flow });
        assert.strictEqual(await refused, RejectReason.INVALID_VALUE, `accepted ${what}`);
      }

      assert.deepStrictEqual((await admin.read()).schedule, [], 'nothing was written');
    } finally {
      await clear(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('music that could not finish inside the gate is refused while it is being written', async () => {
    const admin = await connectAuthedAdmin();
    const cue = [{ id: 'no-such-track', volume: 40 }];

    try {
      // A track this server does not have is its own answer, not a generic refusal.
      const unknown = admin.waitForRejected('saveFlow');
      admin.invoke('saveFlow', {
        flow: entry('music-test', { parts: [{ kind: 'music', tracks: cue, endsAt: '20:00' }] }),
      });
      assert.strictEqual(await unknown, RejectReason.UNKNOWN_TRACK);

      const tracks = [{ id: someTrackId, volume: 40 }];

      const late = admin.waitForRejected('saveFlow');
      admin.invoke('saveFlow', {
        flow: entry('music-test', { parts: [{ kind: 'music', tracks, endsAt: '22:00' }] }),
      });
      assert.strictEqual(await late, RejectReason.INVALID_VALUE, 'music ending after the gate opens again');

      // Note(yoochan.kim): "until the music" is an intent, so this one needs no end time of
      // its own and cannot contradict one.
      const list = await saved(admin, entry('music-test', {
        lock: { at: '19:30', until: { kind: 'music' } },
        parts: [{ kind: 'music', tracks, endsAt: '20:00' }],
      }));
      assert.strictEqual(list[0]!.parts.length, 1);
      assert.deepStrictEqual(list[0]!.lock.until, { kind: 'music' });
    } finally {
      await clear(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('starting an entry is refused on a day it does not run', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const unknown = admin.waitForRejected('startScheduledFlow');
      admin.invoke('startScheduledFlow', { id: 'never-written' });
      assert.strictEqual(await unknown, RejectReason.UNKNOWN_FLOW);

      // Note(yoochan.kim): every day but today, so this asserts the refusal without ever
      // handing the runner a flow — nothing here reaches the deck.
      const today = WEEKDAYS[(new Date().getDay() + 6) % 7]!;
      await saved(admin, entry('other-days', { weekdays: WEEKDAYS.filter((day) => day !== today) }));

      const wrongDay = admin.waitForRejected('startScheduledFlow');
      admin.invoke('startScheduledFlow', { id: 'other-days' });
      assert.strictEqual(await wrongDay, RejectReason.WINDOW_PASSED);

      const noSkip = admin.waitForRejected('skipFlow');
      admin.invoke('skipFlow', { id: 'never-written' });
      assert.strictEqual(await noSkip, RejectReason.UNKNOWN_FLOW);
    } finally {
      await clear(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('the calendar a client reads is the one on disk', async () => {
    const admin = await connectAuthedAdmin();

    try {
      await saved(admin, entry('persisted', { name: '남아 있어야 하는 것' }));

      // A second client is told the same thing, from the same file.
      const other = new SocketTestHelper();
      await other.open('schedule-reader');
      try {
        const list = (await other.read()).schedule ?? [];
        assert.deepStrictEqual(list.map((each) => each.id), ['persisted']);
        assert.strictEqual(list[0]!.name, '남아 있어야 하는 것');
      } finally {
        other.disconnect();
      }
    } finally {
      await clear(admin).catch(() => {});
      admin.disconnect();
    }
  });
});
