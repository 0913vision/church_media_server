import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';

before(() => ensureServer());

// The admin lock is global state that persists across disconnects, so clear it
// after this file — otherwise a leftover lock would block change ops in other
// test files sharing the server.
after(async () => {
  try {
    const admin = await connectAuthedAdmin();
    admin.socket!.emit('setAdminLock', false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    admin.disconnect();
  } catch {
    // best effort
  }
  await stopServer();
});

interface AuthResult {
  success: boolean;
}

async function connectAuthedAdmin(): Promise<SocketTestHelper> {
  const admin = new SocketTestHelper();
  await admin.connect();
  admin.socket!.emit('authenticateAdmin', TEST_ADMIN_PASSWORD);
  const auth = await admin.waitFor<AuthResult>('adminAuthenticated');
  assert.strictEqual(auth.success, true);
  return admin;
}

describe('Admin Auth Tests', () => {
  test('correct password authenticates', async () => {
    const admin = await connectAuthedAdmin();
    admin.disconnect();
  });

  test('wrong password is rejected', async () => {
    const sock = new SocketTestHelper();
    try {
      await sock.connect();
      sock.socket!.emit('authenticateAdmin', 'definitely-wrong');
      const auth = await sock.waitFor<AuthResult>('adminAuthenticated');
      assert.strictEqual(auth.success, false);
    } finally {
      sock.disconnect();
    }
  });
});

describe('Admin Lock Tests', () => {
  test('admin lock blocks user operations and unblocks on release', async () => {
    const admin = await connectAuthedAdmin();
    const user = new SocketTestHelper();

    try {
      await user.connect();

      admin.socket!.emit('setAdminLock', true);
      assert.strictEqual(await admin.waitFor<boolean>('adminLockChanged'), true);

      const blocked = await user.emitAndExpectNoResponse('changeVolume', 'volumeChanged', 500, 42);
      assert.strictEqual(blocked, true, 'user op should be blocked while admin lock held');

      admin.socket!.emit('setAdminLock', false);
      assert.strictEqual(await admin.waitFor<boolean>('adminLockChanged'), false);

      const vol = await user.emitAndWaitFor<number>('changeVolume', 'volumeChanged', 50);
      assert.strictEqual(vol, 50);
    } finally {
      admin.disconnect();
      user.disconnect();
    }
  });

  test('admin can still operate while the lock is on', async () => {
    const admin = await connectAuthedAdmin();

    try {
      admin.socket!.emit('setAdminLock', true);
      assert.strictEqual(await admin.waitFor<boolean>('adminLockChanged'), true);

      const vol = await admin.emitAndWaitFor<number>('changeVolume', 'volumeChanged', 33);
      assert.strictEqual(vol, 33);

      admin.socket!.emit('setAdminLock', false);
      assert.strictEqual(await admin.waitFor<boolean>('adminLockChanged'), false);
    } finally {
      admin.disconnect();
    }
  });

  test('non-admin cannot set the admin lock', async () => {
    const user = new SocketTestHelper();
    try {
      await user.connect();
      const ignored = await user.emitAndExpectNoResponse('setAdminLock', 'adminLockChanged', 400, true);
      assert.strictEqual(ignored, true, 'non-admin setAdminLock should be ignored');
    } finally {
      user.disconnect();
    }
  });

  test('the admin lock is global: it persists past the setter and any admin can release it', async () => {
    const adminA = await connectAuthedAdmin();
    const observer = new SocketTestHelper();
    await observer.connect();
    let adminB: SocketTestHelper | null = null;

    try {
      // A turns the lock on — everyone (incl. the observer) sees it
      adminA.socket!.emit('setAdminLock', true);
      assert.strictEqual(await adminA.waitFor<boolean>('adminLockChanged'), true);
      assert.strictEqual(await observer.waitFor<boolean>('adminLockChanged'), true);

      // The setter disconnects — the global lock must persist (no auto-release)
      adminA.disconnect();
      assert.strictEqual(
        await observer.emitAndWaitFor<boolean>('getLock', 'adminLockChanged'),
        true,
        'lock persists after the setting admin disconnects'
      );

      // A DIFFERENT admin can release it — broadcast false to everyone
      adminB = await connectAuthedAdmin();
      const released = observer.waitFor<boolean>('adminLockChanged');
      adminB.socket!.emit('setAdminLock', false);
      assert.strictEqual(await released, false, 'any admin can release the global lock');
    } finally {
      adminA.disconnect();
      observer.disconnect();
      if (adminB) adminB.disconnect();
    }
  });
});
