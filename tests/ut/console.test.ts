import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer, TEST_ADMIN_PASSWORD } from './test-helpers.ts';

before(() => ensureServer());
after(() => stopServer());

describe('Console readback', () => {
  test('enabling an input is heard back as a console patch', async () => {
    const admin = new SocketTestHelper();
    try {
      const { ready } = await admin.open('console-probe');
      assert.ok(ready.attributes.includes('console'));

      const authed = admin.waitForState((patch) => patch.isAdmin !== undefined);
      admin.invoke('authenticate', { password: TEST_ADMIN_PASSWORD });
      await authed;

      const heard = admin.waitForState(
        (patch) => patch.console !== undefined && patch.console.aux.kind === 'read' && patch.console.aux.on,
      );
      admin.invoke('enableConsoleInput', { input: 'aux' });

      const patch = await heard;
      assert.strictEqual(patch.console!.aux.kind, 'read');
    } finally {
      admin.disconnect();
    }
  });
});
