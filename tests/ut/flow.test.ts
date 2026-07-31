import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';
import type { StatePatch } from '../../server/protocol.ts';

// Note(yoochan.kim): every flow here is lock-only. A music part would start
// audible playback on the host, so the music timeline is covered by the
// FlowRunner's own scheduling rather than by sound.

before(() => ensureServer());

after(async () => {
  // A leftover flow would hold the admin lock and block every other test file.
  try {
    const admin = await connectAuthedAdmin();
    admin.invoke('stopFlow', {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    admin.disconnect();
  } catch {
    // best effort
  }
  await stopServer();
});

function clock(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** A lock-only flow that engages now and would release in an hour */
function lockFlow(name = '테스트 순서'): Record<string, unknown> {
  return { name, parts: [{ kind: 'lock', at: clock(0), until: clock(60) }] };
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

      // The status describes itself: name and release time, no separate lookup.
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

      // Toggling the gate by hand would leave the flow describing a lock that
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
  test('a flow with no parts is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', { name: '빈 순서', parts: [] });

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
        parts: [
          { kind: 'lock', at: clock(0), until: clock(30) },
          { kind: 'lock', at: clock(0), until: clock(60) },
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
      admin.invoke('startFlow', { name: '미래 기능', parts: [{ kind: 'lights', on: true }] });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  test('a malformed clock is refused', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', { name: '나쁜 시각', parts: [{ kind: 'lock', at: '25:00', until: '26:00' }] });

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
        parts: [{ kind: 'music', tracks: ['no-such-track'], endsAt: clock(30) }],
      });

      // Distinguished from a malformed request, so the client can say which
      // track went missing rather than blaming the whole plan.
      assert.strictEqual(await rejected, RejectReason.UNKNOWN_TRACK);
    } finally {
      admin.disconnect();
    }
  });

  test('a flow whose window has already passed is refused, not silently completed', async () => {
    const admin = await connectAuthedAdmin();
    try {
      const rejected = admin.waitForRejected('startFlow');
      // Accepting this would engage and release in the same millisecond, which
      // looks to the operator like the button did nothing.
      admin.invoke('startFlow', {
        name: '지난 순서',
        parts: [{ kind: 'lock', at: clock(-120), until: clock(-60) }],
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
      admin.invoke('startFlow', { name: '빈 음악', parts: [{ kind: 'music', tracks: [], endsAt: clock(30) }] });

      assert.strictEqual(await rejected, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });
});
