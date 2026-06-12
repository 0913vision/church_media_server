import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.js';

before(() => ensureServer());
after(() => stopServer());

// Safety net for the admin authentication + admin lock behavior.
// Uses the default admin password ('admin123' unless ADMIN_PASSWORD is set).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

async function connectAuthedAdmin() {
  const admin = new SocketTestHelper();
  await admin.connect();
  admin.socket.emit('authenticateAdmin', ADMIN_PASSWORD);
  const auth = await admin.waitFor('adminAuthenticated');
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
      sock.socket.emit('authenticateAdmin', 'definitely-wrong');
      const auth = await sock.waitFor('adminAuthenticated');
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

      admin.socket.emit('setAdminLock', true);
      assert.strictEqual(await admin.waitFor('adminLockChanged'), true);

      const blocked = await user.emitAndExpectNoResponse('changeVolume', 'volumeChanged', 500, 42);
      assert.strictEqual(blocked, true, 'user op should be blocked while admin lock held');

      admin.socket.emit('setAdminLock', false);
      assert.strictEqual(await admin.waitFor('adminLockChanged'), false);

      const vol = await user.emitAndWaitFor('changeVolume', 'volumeChanged', 50);
      assert.strictEqual(vol, 50);
    } finally {
      admin.disconnect();
      user.disconnect();
    }
  });

  test('admin can still operate while holding the lock', async () => {
    const admin = await connectAuthedAdmin();

    try {
      admin.socket.emit('setAdminLock', true);
      assert.strictEqual(await admin.waitFor('adminLockChanged'), true);

      const vol = await admin.emitAndWaitFor('changeVolume', 'volumeChanged', 33);
      assert.strictEqual(vol, 33);

      admin.socket.emit('setAdminLock', false);
      assert.strictEqual(await admin.waitFor('adminLockChanged'), false);
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

  test('admin lock auto-releases when the holder disconnects', async () => {
    const admin = await connectAuthedAdmin();
    const observer = new SocketTestHelper();

    try {
      await observer.connect();

      admin.socket.emit('setAdminLock', true);
      assert.strictEqual(await admin.waitFor('adminLockChanged'), true);
      // Drain the acquire (true) broadcast on the observer first, so the next
      // adminLockChanged it sees is unambiguously the auto-release.
      assert.strictEqual(await observer.waitFor('adminLockChanged'), true);

      // Holder drops -> server must auto-release and broadcast false
      const releaseSeen = observer.waitFor('adminLockChanged');
      admin.disconnect();
      assert.strictEqual(await releaseSeen, false);
    } finally {
      observer.disconnect();
    }
  });
});
