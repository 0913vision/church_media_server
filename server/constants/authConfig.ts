import { requireEnv } from '../utils/env.ts';

// Note(yoochan.kim): a salted scrypt hash, never the plaintext; made with `npm run hash-password`.
export const ADMIN_CONFIG = {
  ADMIN_PASSWORD_HASH: requireEnv('ADMIN_PASSWORD_HASH')
} as const;
