import { hashPassword } from '../server/auth/password.ts';

// Note(yoochan.kim): prints the value ADMIN_PASSWORD_HASH takes in .env.
const plain = process.argv[2];
if (!plain) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}
console.log(hashPassword(plain));
