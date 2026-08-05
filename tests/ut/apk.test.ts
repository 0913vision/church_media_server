import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { ensureServer, stopServer, TEST_PORT } from './test-helpers.ts';

before(() => ensureServer());
after(() => stopServer());

// Note(yoochan.kim): only the wiring is tested — a real download would depend
// on the Pi's file server being on the network.
describe('APK download relay', () => {
  test('a path that names no variant is 404, not a relay attempt', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/apk/bogus`);
    assert.strictEqual(response.status, 404);
  });

  test('anything outside /apk is 404', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/whatever`);
    assert.strictEqual(response.status, 404);
  });
});
