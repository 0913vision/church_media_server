import { hashPassword } from '../server/auth/password.ts';

// CLI: print the scrypt hash for a plaintext admin password, for ADMIN_PASSWORD_HASH.
//   npm run hash-password -- 'your-password'
const plain = process.argv[2];
if (!plain) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}
console.log(hashPassword(plain));
