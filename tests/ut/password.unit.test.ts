import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { hashPassword, verifyPassword } from '../../server/auth/password.ts';

// Pure unit test (no server / no env): the password module only uses node:crypto.
describe('Password hashing (unit)', () => {
  test('verifies the correct password', () => {
    const hash = hashPassword('s3cret');
    assert.ok(hash.startsWith('scrypt$'), 'stored format is self-describing');
    assert.strictEqual(verifyPassword('s3cret', hash), true);
  });

  test('rejects a wrong password', () => {
    const hash = hashPassword('s3cret');
    assert.strictEqual(verifyPassword('wrong', hash), false);
  });

  test('rejects a malformed or empty stored hash', () => {
    assert.strictEqual(verifyPassword('s3cret', 'not-a-hash'), false);
    assert.strictEqual(verifyPassword('s3cret', ''), false);
  });

  test('uses a random salt (two hashes differ but both verify)', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    assert.notStrictEqual(a, b, 'salt makes each hash unique');
    assert.ok(verifyPassword('same', a) && verifyPassword('same', b));
  });
});
