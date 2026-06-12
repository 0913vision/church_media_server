import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper, ensureServer, stopServer } from './test-helpers.ts';

before(() => ensureServer());
after(() => stopServer());

describe('Legacy API Path Tests (Deprecated)', () => {
  test('should fail when connecting to /api/socket path', async () => {
    const helper = new SocketTestHelper(undefined, {
      path: '/api/socket'
    });

    try {
      await helper.connect();
      throw new Error('Should not connect to deprecated /api/socket path');
    } catch (err) {
      assert.ok(err, 'Expected connection error for deprecated path');
    } finally {
      helper.disconnect();
    }
  });
});
