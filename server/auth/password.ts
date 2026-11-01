import crypto from 'node:crypto';

// Note(yoochan.kim): about 16 MB of memory per hash at r=8.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

/** Carries its own scrypt parameters, so they can change without breaking stored hashes. */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

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
