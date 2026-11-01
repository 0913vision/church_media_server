import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';
import type { StatePatch } from '../../server/protocol.ts';
import { INSTANT_PATTERN, formatInstant } from '../../server/utils/instant.ts';

// Note(yoochan.kim): no flow here ever reaches playback: a music part would sound on the host.

// Note(yoochan.kim): read from the handshake: these tests need a real track, not a particular one.
let firstTrackId = '';

const cue = (id: string, volume = 40): { id: string; volume: number } => ({ id, volume });

before(async () => {
  await ensureServer();
  const probe = new SocketTestHelper();
  try {
    const { state } = await probe.open('flow-probe');
    firstTrackId = state.tracks![0]!.id;
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

function clock(offsetMinutes: number): string {
  return formatInstant(new Date(Date.now() + offsetMinutes * 60_000));
}

function lockFlow(name = '테스트 순서'): Record<string, unknown> {
  return { id: `flow-${name}`, name, lock: { at: clock(0), until: clock(60) }, parts: [] };
}

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open('test-admin');
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  assert.strictEqual((await authed).isAdmin, true);
  return admin;
}

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
      // Note(yoochan.kim): the app parses this one shape and nothing else
      assert.match(holding.flow?.phase === 'holding' ? holding.flow.unlockAt : '', INSTANT_PATTERN);
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

      // Note(yoochan.kim): released by hand, the flow would describe a lock that is gone; stopping is the way out.
      const rejected = admin.waitForRejected('adminLock');
      admin.write('adminLock', false);
      assert.strictEqual(await rejected, RejectReason.FLOW_ACTIVE);

      assert.strictEqual((await admin.read()).adminLock, true, 'the lock is still held');
    } finally {
      await stopFlow(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('a flow holding only the gate leaves the deck free', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const before = await admin.read();
      await startHoldingFlow(admin);

      // Note(yoochan.kim): holding the gate is not using the deck; playback stays out, as it would sound in the room.
      const next = before.volume === 42 ? 43 : 42;
      const observed = admin.waitForState((patch) => patch.volume !== undefined);
      admin.write('volume', next);
      assert.strictEqual((await observed).volume, next, 'the deck took the write');
    } finally {
      await stopFlow(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('a run only holding the gate leaves the deck usable, and takes it back at its own start', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const before = await admin.read();
      await startHoldingFlow(admin);

      // Note(yoochan.kim): a quiet run leaves the panel free; only a selection, as playing would sound on the host.
      const chosen = admin.waitForState((patch) => patch.deck?.source === 'track');
      admin.invoke('selectTrack', { id: firstTrackId });
      assert.strictEqual((await chosen).deck!.source, 'track', 'a quiet run does not own the deck');

      await stopFlow(admin);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Note(yoochan.kim): back to the deck the run was handed, not the track put on halfway through it.
      const after = await admin.read();
      assert.deepStrictEqual(after.deck, { source: 'song' });
      assert.strictEqual(after.song, before.song, 'the run restored what it was given');
      assert.strictEqual(after.volume, before.volume);
    } finally {
      await stopFlow(admin).catch(() => {});
      admin.disconnect();
    }
  });

  test('a library track needs the gate, and the gate puts the deck back', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const before = await admin.read();
      // Note(yoochan.kim): every refusal here comes before anything loads, so nothing reaches the speakers.
      const closed = admin.waitForRejected('selectTrack');
      admin.invoke('selectTrack', { id: firstTrackId });
      assert.strictEqual(await closed, RejectReason.ADMIN_UNLOCKED, 'no gate, no track');

      const loopClosed = admin.waitForRejected('loop');
      admin.write('loop', false);
      assert.strictEqual(await loopClosed, RejectReason.ADMIN_UNLOCKED);

      const held = admin.waitForState((patch) => patch.adminLock === true);
      admin.write('adminLock', true);
      await held;

      const unknown = admin.waitForRejected('selectTrack');
      admin.invoke('selectTrack', { id: 'no-such-track' });
      assert.strictEqual(await unknown, RejectReason.UNKNOWN_TRACK);

      const chosen = admin.waitForState((patch) => patch.loop === false);
      admin.write('loop', false);
      assert.strictEqual((await chosen).loop, false, 'the gate lets the choice through');

      // Note(yoochan.kim): opening the gate sends two patches; a read before the second would take it as its reply.
      const restored = admin.waitForState((patch) => patch.loop === true);
      admin.write('adminLock', false);
      await restored;

      const after = await admin.read();
      assert.strictEqual(after.loop, true, 'looping comes back with the panel');
      assert.strictEqual(after.unlockWhenDone, false);
      assert.deepStrictEqual(after.deck, { source: 'song' });
      assert.strictEqual(after.song, before.song);
    } finally {
      admin.write('adminLock', false);
      await new Promise((resolve) => setTimeout(resolve, 150));
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
      admin.invoke('startFlow', { id: 'flow-test', name: '락 없는 순서', parts: [] });

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
        id: 'flow-test',
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
        id: 'flow-test',
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
      admin.invoke('startFlow', { id: 'flow-test', name: '나쁜 시각', lock: { at: '19:30', until: '21:30' }, parts: [] });

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
        id: 'flow-test',
        name: '없는 곡',
        lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue('no-such-track')], endsAt: clock(30) }],
      });

      // Note(yoochan.kim): its own reason, so the client can name the missing track rather than blame the whole plan.
      assert.strictEqual(await rejected, RejectReason.UNKNOWN_TRACK);
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): one spelling only: clients may depend on any other, and the panel app cannot be updated fast.
  test('an instant written any other way is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const now = new Date(Date.now() + 10 * 60_000);
      const wrong = [
        now.toISOString(),
        formatInstant(now).slice(0, 19),
        `${formatInstant(now)}+09:00`,
        formatInstant(now).slice(0, 10),
      ];
      for (const at of wrong) {
        const rejected = admin.waitForRejected('startFlow');
        admin.invoke('startFlow', { id: 'flow-test', name: '형식 시험', lock: { at, until: clock(60) }, parts: [] });
        assert.strictEqual(await rejected, RejectReason.INVALID_VALUE, `should refuse ${at}`);
      }
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): a track with no level would play as loud as the panel was left, the surprise a level prevents.
  test('a scheduled track without a usable level is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      for (const bad of [{ id: firstTrackId }, { id: firstTrackId, volume: 140 }, { id: firstTrackId, volume: '40' }]) {
        const rejected = admin.waitForRejected('startFlow');
        admin.invoke('startFlow', {
          id: 'flow-test',
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
      // Note(yoochan.kim): accepted, it would engage and release at once, as if the button did nothing.
      admin.invoke('startFlow', {
        id: 'flow-test',
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
        id: 'flow-test',
        name: '빈 음악',
        lock: { at: clock(0), until: clock(60) },
        parts: [{ kind: 'music', tracks: [], endsAt: clock(30) }],
      });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): past the unlock the music would sound on an open panel, where a tablet could take the deck.
  test('music finishing after the lock releases is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', {
        id: 'flow-test',
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
      // Note(yoochan.kim): none of it could sound before the gate; accepted, it would look like nothing happened.
      admin.invoke('startFlow', {
        id: 'flow-test',
        name: '락 전에 끝나는 음악',
        lock: { at: clock(30), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue(firstTrackId)], endsAt: clock(20) }],
      });

      assert.strictEqual(await rejected, RejectReason.MUSIC_OUTSIDE_LOCK);
    } finally {
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): a timeline's front is cut, not refused: sound starts with the lock, where the timeline is.
  test('music timed to begin before the lock is accepted', async () => {
    const admin = await connectAuthedAdmin();
    try {
      // Note(yoochan.kim): the first track outlasts the lock-to-finish minute, so its start falls before the gate.
      const waiting = admin.waitForState((patch) => patch.flow?.phase === 'waiting');
      admin.invoke('startFlow', {
        id: 'flow-test',
        name: '앞이 잘리는 음악',
        lock: { at: clock(30), until: clock(60) },
        parts: [{ kind: 'music', tracks: [cue(firstTrackId)], endsAt: clock(31) }],
      });
      await waiting;

      // Note(yoochan.kim): nothing plays: the lock is half an hour away and the flow is stopped while still waiting.
      await stopFlow(admin);
    } finally {
      admin.disconnect();
    }
  });
});
