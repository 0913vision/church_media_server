import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { SocketTestHelper } from './test-helpers.js';

describe('Legacy API Path Tests (Deprecated)', () => {
  test('should fail when connecting to /api/socket path', async () => {
    const helper = new SocketTestHelper('http://localhost:3000', { 
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