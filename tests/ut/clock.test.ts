import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';
import { RejectReason } from '../../server/protocol.ts';

before(() => ensureServer());

// Note(yoochan.kim): The offset is global and persisted, so put it back or later files inherit it.
after(async () => {
  try {
    const admin = await connectAuthedAdmin();
    admin.write('clockOffsetSec', 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    admin.disconnect();
  } catch {
    // best effort
  }
  await stopServer();
});

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.open('test-admin');
  const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
  admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
  assert.strictEqual((await authed).isAdmin, true);
  return admin;
}

describe('Church clock', () => {
  test('the offset is readable state', async () => {
    const helper = new SocketTestHelper();
    const { ready, state } = await helper.open();

    try {
      assert.ok(ready.attributes.includes('clockOffsetSec'));
      assert.strictEqual(typeof state.clockOffsetSec, 'number');
    } finally {
      helper.disconnect();
    }
  });

  test('an admin moves the clock and everyone hears about it', async () => {
    const admin = await connectAuthedAdmin();
    const listener = new SocketTestHelper();
    await listener.open('test-listener');

    try {
      const heard = listener.waitForState((patch) => patch.clockOffsetSec === 72);
      admin.write('clockOffsetSec', 72);
      assert.strictEqual((await heard).clockOffsetSec, 72);
      assert.strictEqual((await admin.read()).clockOffsetSec, 72);
    } finally {
      admin.write('clockOffsetSec', 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      listener.disconnect();
      admin.disconnect();
    }
  });

  // Note(yoochan.kim): The offset is not decoration: scheduling is judged against it. A window
  // still half an hour away by the wall clock is already gone once the church
  // clock runs an hour ahead of it.
  test('a flow is scheduled against church time, not standard time', async () => {
    const admin = await connectAuthedAdmin();
    const soon = {
      name: '시계 시험',
      lock: {
        at: new Date(Date.now() + 10 * 60_000).toISOString(),
        until: new Date(Date.now() + 40 * 60_000).toISOString(),
      },
      parts: [],
    };

    try {
      const applied = admin.waitForState((patch) => patch.clockOffsetSec === 3600);
      admin.write('clockOffsetSec', 3600);
      await applied;

      const refused = admin.waitForRejected('startFlow');
      admin.invoke('startFlow', soon);
      assert.strictEqual(await refused, RejectReason.WINDOW_PASSED);
    } finally {
      admin.write('clockOffsetSec', 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      admin.disconnect();
    }
  });

  test('a value outside the range is refused', async () => {
    const admin = await connectAuthedAdmin();

    try {
      const refused = admin.waitForRejected('clockOffsetSec');
      admin.write('clockOffsetSec', 7200);
      assert.strictEqual(await refused, RejectReason.INVALID_VALUE);
    } finally {
      admin.disconnect();
    }
  });

  test('a non-admin cannot move the clock', async () => {
    const helper = new SocketTestHelper();
    await helper.open();

    try {
      const refused = helper.waitForRejected('clockOffsetSec');
      helper.write('clockOffsetSec', 30);
      assert.strictEqual(await refused, RejectReason.NOT_ADMIN);
    } finally {
      helper.disconnect();
    }
  });

  // Note(yoochan.kim): The rule that makes the whole feature safe: a flow holds the gate for its
  // entire run, so refusing here means the clock can never move under music.
  test('the clock cannot move while the admin gate is held', async () => {
    const admin = await connectAuthedAdmin();

    try {
      admin.write('adminLock', true);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const refused = admin.waitForRejected('clockOffsetSec');
      admin.write('clockOffsetSec', 45);
      assert.strictEqual(await refused, RejectReason.ADMIN_LOCKED);
      assert.strictEqual((await admin.read()).clockOffsetSec, 0);
    } finally {
      admin.write('adminLock', false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      admin.disconnect();
    }
  });
});
