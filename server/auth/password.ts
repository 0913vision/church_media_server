import crypto from 'node:crypto';

/**
 * Admin password hashing. Passwords are NEVER stored in plaintext — only a
 * salted, slow (scrypt) one-way hash is kept, and verification is constant
 * time. Built on Node's crypto (no external dependency).
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>` — self-describing so
 * the parameters can change without breaking existing hashes.
 */
const SCRYPT_N = 16384; // CPU/memory cost (≈16 MB at r=8)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

/** Hashes a plaintext password into the stored format above. */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Verifies a plaintext password against a stored hash (constant time). */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [scheme, nStr, rStr, pStr, saltHex, keyHex] = stored.split('$');
    if (scheme !== 'scrypt' || !nStr || !rStr || !pStr || !saltHex || !keyHex) {
      return false;
    }
    const salt = Buffer.from(saltHex, 'hex');
    const key = Buffer.from(keyHex, 'hex');
    const derived = crypto.scryptSync(plain, salt, key.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr)
    });
    return key.length === derived.length && crypto.timingSafeEqual(key, derived);
  } catch {
    return false;
  }
}
