// Creates a local-auth user via AuthProvider.register(), with a default
// password the user is expected to change via /change-password on first
// login. Local-only: refuses to run under any other AUTH_PROVIDER, since SSO
// identities are provisioned externally, not through this app (see
// app/lib/auth/authProvider.js) — replaces the old POST /auth/register API,
// which let anyone self-register without an admin in the loop.
//
// Usage: node scripts/create-user.js <username> <initials>
// (normally invoked via scripts/create-user.sh, which validates arguments
// before delegating here)

require('dotenv').config();

const { getAuthProvider } = require('../app/lib/auth');

const DEFAULT_PASSWORD = 'change_me';

async function main() {
  const [username, initials] = process.argv.slice(2);
  if (!username || !initials) {
    throw new Error('Usage: node scripts/create-user.js <username> <initials>');
  }

  const providerName = process.env.AUTH_PROVIDER || 'local';
  if (providerName !== 'local') {
    throw new Error(`create-user only supports AUTH_PROVIDER=local (current: "${providerName}")`);
  }

  const authProvider = getAuthProvider();
  const user = await authProvider.register(username, DEFAULT_PASSWORD, initials);
  console.log(`Created user "${user.username}" (initials: ${user.initials}) with default password "${DEFAULT_PASSWORD}".`);
  console.log('They should log in and change this password immediately.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Create user failed:', err.message);
    process.exit(1);
  });
