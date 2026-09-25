// Local username/password implementation of AuthProvider, backed by the
// `users` table. bcrypt-hashed passwords; never store or log plaintext.

const bcrypt = require('bcryptjs');
const AuthProvider = require('./authProvider');
const db = require('../db');

const SALT_ROUNDS = 12;

class LocalPasswordAuthProvider extends AuthProvider {
  async register(username, password, initials) {
    const existing = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      const err = new Error('Username already exists');
      err.code = 'USERNAME_TAKEN';
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.query(
      'INSERT INTO users (username, password_hash, initials) VALUES (?, ?, ?)',
      [username, passwordHash, initials]
    );

    // is_admin defaults to 0 (see db/schema.sql) - every self-registered
    // user starts as a non-admin, so this is hardcoded rather than read back.
    return { id: result.insertId, username, initials, isAdmin: false };
  }

  async verify(username, password) {
    const rows = await db.query(
      'SELECT id, username, password_hash, initials, is_admin AS isAdmin FROM users WHERE username = ?',
      [username]
    );
    if (rows.length === 0) return null;

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return null;

    return { id: user.id, username: user.username, initials: user.initials, isAdmin: Boolean(user.isAdmin) };
  }

  async changePassword(userId, currentPassword, newPassword) {
    const rows = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      const err = new Error('User not found');
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!isMatch) {
      const err = new Error('Current password is incorrect');
      err.code = 'INVALID_CURRENT_PASSWORD';
      throw err;
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  }
}

module.exports = LocalPasswordAuthProvider;
