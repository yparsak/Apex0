// Auth routes — depend only on the AuthProvider interface (getAuthProvider),
// never on a concrete provider implementation. This is what makes swapping
// in SSO later a change confined to app/lib/auth/, not here.

const express = require('express');
const { getAuthProvider } = require('../lib/auth');
const requireAuth = require('../lib/auth/requireAuth');
const { isNonEmptyString } = require('../lib/validate');
const { sendSuccess, sendFailure } = require('../lib/respond');
const logger = require('../lib/logger');

const router = express.Router();

const PASSWORD_MIN_LENGTH = 8;

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    return sendFailure(res, 400, 'username and password are required');
  }

  try {
    const authProvider = getAuthProvider();
    const user = await authProvider.verify(username.trim(), password);
    if (!user) {
      return sendFailure(res, 401, 'Invalid username or password');
    }
    req.session.user = user;
    return sendSuccess(res, { user }, 'Logged in successfully');
  } catch (err) {
    logger.error('login failed', { error: err.message });
    return sendFailure(res, 500, 'Login failed', { code: 'INTERNAL_ERROR' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) {
    return sendSuccess(res, {}, 'Logged out successfully');
  }

  req.session.destroy((err) => {
    if (err) {
      logger.error('logout failed', { error: err.message });
      return sendFailure(res, 500, 'Logout failed', { code: 'INTERNAL_ERROR' });
    }
    res.clearCookie('connect.sid');
    return sendSuccess(res, {}, 'Logged out successfully');
  });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return sendFailure(res, 401, 'Not authenticated');
  }
  return sendSuccess(res, { user: req.session.user });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!isNonEmptyString(currentPassword)) {
    return sendFailure(res, 400, 'currentPassword is required');
  }
  if (!isNonEmptyString(newPassword) || newPassword.length < PASSWORD_MIN_LENGTH) {
    return sendFailure(res, 400, `newPassword is required (minimum ${PASSWORD_MIN_LENGTH} characters)`);
  }

  try {
    const authProvider = getAuthProvider();
    await authProvider.changePassword(req.session.user.id, currentPassword, newPassword);
    return sendSuccess(res, {}, 'Password changed successfully');
  } catch (err) {
    if (err.code === 'INVALID_CURRENT_PASSWORD') {
      return sendFailure(res, 401, 'Current password is incorrect');
    }
    logger.error('change password failed', { userId: req.session.user.id, error: err.message });
    return sendFailure(res, 500, 'Failed to change password', { code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
