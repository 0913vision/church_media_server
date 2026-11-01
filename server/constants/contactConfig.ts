import { requireEnv } from '../utils/env.ts';
import type { Contact } from '../protocol.ts';

/** Printed on clients' error screens; from the environment so the person on duty changes without an app release. */
export const ADMIN_CONTACT: Contact = {
  name: requireEnv('ADMIN_CONTACT_NAME'),
  phone: requireEnv('ADMIN_CONTACT_PHONE'),
};
