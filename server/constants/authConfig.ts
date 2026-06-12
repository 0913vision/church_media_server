import { requireEnv } from '../utils/env.ts';

// Admin authentication configuration
export const ADMIN_CONFIG = {
  // TODO: 나중에 실제 인증 시스템으로 교체
  ADMIN_PASSWORD: requireEnv('ADMIN_PASSWORD')
} as const;
