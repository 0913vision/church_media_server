import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper } from './test-helpers.js';

// Verifies the core new behavior: the admin lock is a separate channel that
// blocks NON-admin user submissions while held, and unblocks on release.
// Uses the default admin password ('admin123' unless ADMIN_PASSWORD is set).
describe('Admin Lock Tests', () => {
  test('admin lock blocks user operations and unblocks on release', async () => {
    const admin = new SocketTestHelper();
    const user = new SocketTestHelper();

    try {
      await admin.connect();
      await user.connect();

      // Authenticate the admin socket
      admin.socket.emit('authenticateAdmin', process.env.ADMIN_PASSWORD || 'admin123');
      const auth = await admin.waitFor('adminAuthenticated');
      assert.strictEqual(auth.success, true);

      // Acquire the admin lock -> broadcast adminLockChanged = true (own event)
      admin.socket.emit('setAdminLock', true);
      const locked = await admin.waitFor('adminLockChanged');
      assert.strictEqual(locked, true);

      // A non-admin user's volume change must be blocked (no volumeChanged)
      const blocked = await user.emitAndExpectNoResponse('changeVolume', 'volumeChanged', 600, 42);
      assert.strictEqual(blocked, true, 'user op should be blocked while admin lock held');

      // Release the admin lock -> broadcast adminLockChanged = false
      admin.socket.emit('setAdminLock', false);
      const unlocked = await admin.waitFor('adminLockChanged');
      assert.strictEqual(unlocked, false);

      // Now the same user operation goes through and broadcasts
      const vol = await user.emitAndWaitFor('changeVolume', 'volumeChanged', 50);
      assert.strictEqual(vol, 50);
    } finally {
      admin.disconnect();
      user.disconnect();
    }
  });
});
