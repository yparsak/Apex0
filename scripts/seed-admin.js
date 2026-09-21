// One-time (idempotent) seed for the first admin user, using
// SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD / SEED_ADMIN_INITIALS from
// .env - these three vars have existed in the env template since Phase 0
// but were unused until this phase, since there was no admin concept yet.
// Run:
//   node scripts/seed-admin.js   (or `make seed-admin`)
// Safe to re-run: reuses AuthProvider.register() rather than duplicating its
// hashing/validation, and if the username already exists this just promotes
// it to admin instead of erroring. See Phase6_test.md.

require('dotenv').config();

const db = require('../app/lib/db');
const { getAuthProvider } = require('../app/lib/auth');

async function main() {
  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const initials = process.env.SEED_ADMIN_INITIALS;

  if (!username || !password || !initials) {
    throw new Error('SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD, and SEED_ADMIN_INITIALS must all be set in .env');
  }

  const authProvider = getAuthProvider();
  try {
    await authProvider.register(username, password, initials);
    console.log(`Created admin user "${username}".`);
  } catch (err) {
    if (err.code !== 'USERNAME_TAKEN') throw err;
    console.log(`User "${username}" already exists; promoting to admin.`);
  }

  const result = await db.query('UPDATE users SET is_admin = 1 WHERE username = ?', [username]);
  if (result.affectedRows === 0) {
    throw new Error(`Failed to promote "${username}" to admin - no matching user row.`);
  }

  console.log(`"${username}" is now an admin.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed admin failed:', err.message);
    process.exit(1);
  });
