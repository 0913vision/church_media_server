import { requireEnv } from '../utils/env.ts';

// Admin authentication configuration.
// The password is stored as a salted scrypt hash (see server/auth/password.ts),
// never in plaintext. Generate one with `npm run hash-password`.
export const ADMIN_CONFIG = {
  ADMIN_PASSWORD_HASH: requireEnv('ADMIN_PASSWORD_HASH')
} as const;
