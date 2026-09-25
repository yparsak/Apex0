// AuthProvider interface (contract only — never instantiate directly).
//
// Any identity backend — today's local username/password, a future SSO
// implementation — must implement this shape. Route call sites depend only
// on this interface (obtained via `getAuthProvider()` in ./index.js), never
// on a concrete provider class, so swapping the backend later is a
// drop-in change: implement this contract, flip AUTH_PROVIDER, done.
//
// A future SSO provider may implement `register()` as a no-op/throw (SSO
// identities are provisioned externally, not created through this app) —
// the contract still stands because call sites never assume `register()`
// succeeds for every provider, they just call it and handle whatever the
// active provider returns/throws.
class AuthProvider {
  /**
   * Create a new local identity. Always starts as a non-admin - see
   * app/lib/auth/requireAdmin.js; promoting to admin is Phase 6's
   * scripts/seed-admin.js or an existing admin's own judgment, never
   * self-service at registration time.
   * @param {string} username
   * @param {string} password
   * @param {string} initials
   * @returns {Promise<{id: number, username: string, initials: string, isAdmin: boolean}>}
   */
  async register(_username, _password, _initials) {
    throw new Error('AuthProvider.register() is not implemented');
  }

  /**
   * Verify credentials.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{id: number, username: string, initials: string, isAdmin: boolean} | null>} null when invalid
   */
  async verify(_username, _password) {
    throw new Error('AuthProvider.verify() is not implemented');
  }

  /**
   * Change an already-authenticated user's own password, given their
   * current one. A future SSO provider may implement this as a no-op/throw
   * (SSO credentials are managed by the external identity provider, not
   * this app) - same contract-stands-either-way reasoning as `register()`.
   * @param {number} userId
   * @param {string} currentPassword
   * @param {string} newPassword
   * @returns {Promise<void>}
   * @throws {Error} with `err.code === 'INVALID_CURRENT_PASSWORD'` when currentPassword doesn't match
   */
  async changePassword(_userId, _currentPassword, _newPassword) {
    throw new Error('AuthProvider.changePassword() is not implemented');
  }
}

module.exports = AuthProvider;
