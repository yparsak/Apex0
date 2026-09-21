// Admin-only route guard (Phase 6) - 403s via the standard JSON envelope
// when the authenticated user isn't an admin. Must run after requireAuth
// (see app/routes/admin.js), and only checks the `isAdmin` flag already
// carried on the session - set at login/register time in
// app/lib/auth/localPasswordAuthProvider.js, same as `username`/`initials` -
// never a fresh DB lookup per request.

const { sendFailure } = require('../respond');

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.isAdmin) {
    return sendFailure(res, 403, 'Admin access required');
  }
  return next();
}

module.exports = requireAdmin;
