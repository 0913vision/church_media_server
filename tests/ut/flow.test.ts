import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';
import type { StatePatch } from '../../server/protocol.ts';

// Note(yoochan.kim): no flow here ever reaches playback. A music part would
// start audible sound on the host, so the music timeline is covered by the
// FlowRunner's own scheduling — and the music tests below are all refusals,
// which are decided before anything is loaded.

// Note(yoochan.kim): Read from the handshake rather than hardcoded: these tests need "a real
// track", not a particular one, and the library is fixed at boot anyway.
let firstTrackId = '';

/** A track as a flow schedules it: an id and the level it plays at. */
const cue = (id: string, volume = 40): { id: string; volume: number } => ({ id, volume });

before(async () => {
  await ensureServer();
  const probe = new SocketTestHelper();
  try {
    const { ready } = await probe.open('flow-probe');
    firstTrackId = ready.tracks[0]!.id;
  } finally {
    probe.disconnect();
  }
});

after(async () => {
  // Note(yoochan.kim): A leftover flow would hold the admin lock and block every other test file.
  try {
    const admin = await connectAuthedAdmin();
    admin.invoke('stopFlow', {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    admin.disconnect();
  } catch {
    // Note(yoochan.kim): best effort
  }
  await stopServer();
});

/** An absolute instant this many minutes from now, as the protocol wants it */
function clock(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

/** A lock-only flow that engages now and would release in an hour */
function lockFlow(name = '테스트 순서'): Record<string, unknown> {
  return { name, lock: { at: clock(0), until: clock(60) }, parts: [] };
}

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open('test-admin');
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  assert.strictEqual((await authed).isAdmin, true);
  return admin;
}

/** Starts a lock-only flow and waits until it is actually holding the lock */
async function startHoldingFlow(admin: SocketTestHelper, name?: string): Promise<StatePatch> {
  const holding = admin.waitForState((patch) => patch.flow?.phase === 'holding');
  admin.invoke('startFlow', lockFlow(name));
  return await holding;
}

async function stopFlow(admin: SocketTestHelper): Promise<StatePatch> {
  const idle = admin.waitForState((patch) => patch.flow?.phase === 'idle');
  admin.invoke('stopFlow', {});
  return await idle;
}

describe('Flow Tests', () => {
  test('the server advertises that it runs flows', async () => {
    const sock = new SocketTestHelper();
    try {
      const { ready } = await sock.open();

      assert.ok(ready.commands.includes('startFlow'));
      assert.ok(ready.commands.includes('stopFlow'));
    } finally {
      sock.disconnect();
    }
  });

  test('a lock-only flow engages the lock, and stopping releases it', async () => {
    const admin = await connectAuthedAdmin();
    const observer = new SocketTestHelper();

    try {
      await observer.open();

      const lockedForEveryone = observer.waitForState((patch) => patch.adminLock === true);
      const holding = await startHoldingFlow(admin, '수요 예배');

      // Note(yoochan.kim): The status describes itself: name and release time, no separate lookup.
      assert.deepStrictEqual(holding.flow?.phase, 'holding');
      assert.strictEqual(holding.flow?.phase === 'holding' ? holding.flow.name : '', '수요 예배');
      await lockedForEveryone;

      const released = observer.waitForState((patch) => patch.adminLock === false);
      const idle = await stopFlow(admin);

      assert.deepStrictEqual(idle.flow, { phase: 'idle' });
      await released;
    } finally {
      admin.disconnect();
      observer.disconnect();
    }
  });

  test('a flow that is running owns the admin lock', async () => {
    const admin = await connectAuthedAdmin();

    try {
      await startHoldingFlow(admin);

      // Note(yoochan.kim): Toggling the gate by hand would leave the flow describing a lock that
      // is no longer there, so it is refused and stopping is the way out.
      const rejected = admin.waitForRejected('adminLock');
      admin.write('adminLock', false);
      assert.strictEqual(await rejected, RejectReason.FLOW_ACTIVE);

      assert.strictEqual((await admin.read()).adminLock, true, 'the lock is still held');
    } finally {
      await stopFlow(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('only one flow runs at a time', async () => {
    const admin = await connectAuthedAdmin();

    try {
      await startHoldingFlow(admin);

      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', lockFlow('두 번째'));
      assert.strictEqual(await rejected, RejectReason.FLOW_ACTIVE);
    } finally {
      await stopFlow(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('stopping when nothing runs says so', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const rejected = admin.waitForRejected('stopFlow');
      admin.invoke('stopFlow', {});

      assert.strictEqual(await rejected, RejectReason.NO_FLOW);
    } finally {
      admin.disconnect();
    }
  });

  test('a non-admin cannot start a flow', async () => {
    const user = new SocketTestHelper();
    try {
      await user.open();

      const rejected = user.waitForRejected('startFlow');
      user.invoke('startFlow', lockFlow());

      assert.strictEqual(await rejected, RejectReason.NOT_ADMIN);
    } finally {
      user.disconnect();
    }
  });
});

describe('Flow Validation Tests', () => {
  test('a flow with no lock is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', { name: '락 없는 순서', parts: [] });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  test('the same kind of part twice is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', {
        name: '중복',
        lock: { at: clock(0), until: clock(60) },
        parts: [
          { kind: 'music', tracks: [], endsAt: clock(30) },
          { kind: 'music', tracks: [], endsAt: clock(40) },
        ],
      });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  test('an unknown part kind is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', {
        name: '미래 기능',
        lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'lights', on: true }],
      });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  test('a malformed clock is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      // Note(yoochan.kim): A bare clock time is not an instant: the server will not guess a date.
      admin.invoke('startFlow', { name: '나쁜 시각', lock: { at: '19:30', until: '21:30' }, parts: [] });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  test('a track the library does not have is refused by name', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', {
        name: '없는 곡',
        lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue('no-such-track')], endsAt: clock(30) }],
      });

      // Note(yoochan.kim): Distinguished from a malformed request, so the client can say which
      // track went missing rather than blaming the whole plan.
      assert.strictEqual(await rejected, RejectReason.UNKNOWN_TRACK);
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): a track with no level would fall back to whatever the
  // panel was left at, which is exactly the surprise the level exists to stop.
  test('a scheduled track without a usable level is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      for (const bad of [{ id: firstTrackId }, { id: firstTrackId, volume: 140 }, { id: firstTrackId, volume: '40' }]) {
        const rejected = admin.waitForRejected('startFlow');
        admin.invoke('startFlow', {
          name: '볼륨 없는 곡',
          lock: { at: clock(0), until: clock(60) },
          parts: [{ kind: 'music', tracks: [bad], endsAt: clock(30) }],
        });

        assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
      }
    } finally {
      admin.disconnect();
    }
  });

  test('a flow whose window has already passed is refused, not silently completed', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      // Note(yoochan.kim): Accepting this would engage and release in the same millisecond, which
      // looks to the operator like the button did nothing.
      admin.invoke('startFlow', {
        name: '지난 순서',
        lock: { at: clock(-120), until: clock(-60) },
        parts: [],
      });

      assert.strictEqual(await rejected, RejectReason.WINDOW_PASSED);
    } finally {
      admin.disconnect();
    }
  });

  test('music with no tracks is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', {
        name: '빈 음악',
        lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'music', tracks: [], endsAt: clock(30) }],
      });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): Only the finish is bound to the window: music running past the unlock
  // would sound on an open panel, where a tablet could take the deck out from
  // under the run.
  test('music finishing after the lock releases is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', {
        name: '락보다 늦게 끝나는 음악',
        lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue(firstTrackId)], endsAt: clock(90) }],
      });

      assert.strictEqual(await rejected, RejectReason.MUSIC_OUTSIDE_LOCK);
    } finally {
      admin.disconnect();
    }
  });

  test('music that would end before the lock engages is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      // Note(yoochan.kim): Ends fully before the gate: with the front cut at the lock instant,
      // nothing of it could ever sound, so accepting it would look like the
      // button doing nothing.
      admin.invoke('startFlow', {
        name: '락 전에 끝나는 음악',
        lock: { at: clock(30), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue(firstTrackId)], endsAt: clock(20) }],
      });

      assert.strictEqual(await rejected, RejectReason.MUSIC_OUTSIDE_LOCK);
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): The front of a timeline is cut, not refused: the sound would start with
  // the lock and seek to where the timeline already is. Nothing plays here —
  // the lock is half an hour away and the flow is stopped while still waiting.
  test('music timed to begin before the lock is accepted', async () => {
    const admin = await connectAuthedAdmin();
    try {
      // Note(yoochan.kim): The library's first track is longer than the one minute between the
      // lock and the finish, so the derived start lands before the gate.
      const waiting = admin.waitForState((patch) => patch.flow?.phase === 'waiting');
      admin.invoke('startFlow', {
        name: '앞이 잘리는 음악',
        lock: { at: clock(30), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue(firstTrackId)], endsAt: clock(31) }],
      });
      await waiting;

      await stopFlow(admin);
    } finally {
      admin.disconnect();
    }
  });
});
