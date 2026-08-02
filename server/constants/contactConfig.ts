import { requireEnv } from '../utils/env.ts';
import type { Contact } from '../protocol.ts';

/**
 * Who to call when this server is not working.
 *
 * Deployment information rather than content — it answers "who runs this box",
 * which is the same question ADMIN_PASSWORD_HASH answers — so it lives in the
 * environment beside it and is required like everything else there. A client
 * prints it on its error screens, so the person on duty can change without a
 * release of the app.
 */
export const ADMIN_CONTACT: Contact = {
  name: requireEnv('ADMIN_CONTACT_NAME'),
  phone: requireEnv('ADMIN_CONTACT_PHONE'),
};
