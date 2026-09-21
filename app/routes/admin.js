// Access-administration API (Phase 6) - user_repo_group_permissions
// management and user-initials editing, both audit-logged via
// app/lib/admin/adminService.js. Depends only on that service module, never
// on db access directly, same thin-HTTP-layer separation app/routes/repos.js
// keeps from app/lib/repos/repoAccess.js.

const express = require('express');
const requireAuth = require('../lib/auth/requireAuth');
const requireAdmin = require('../lib/auth/requireAdmin');
const { sendSuccess, sendFailure } = require('../lib/respond');
const { isNonEmptyString } = require('../lib/validate');
const adminService = require('../lib/admin/adminService');
const logger = require('../lib/logger');

const router = express.Router();

const INITIALS_MAX_LENGTH = 10;

// Every route below is both authenticated and admin-gated - requireAdmin
// only checks a flag already on the session (see its own file comment), so
// it's cheap to apply router-wide rather than per-route.
router.use(requireAuth, requireAdmin);

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get('/users', async (req, res) => {
  try {
    const users = await adminService.listUsers();
    return sendSuccess(res, { users });
  } catch (err) {
    logger.error('admin list users failed', { error: err.message });
    return sendFailure(res, 500, 'Failed to list users', { code: 'INTERNAL_ERROR' });
  }
});

router.put('/users/:userId/initials', async (req, res) => {
  const targetUserId = parsePositiveInt(req.params.userId);
  if (targetUserId === null) {
    return sendFailure(res, 400, 'Invalid user id');
  }

  const { initials } = req.body || {};
  if (!isNonEmptyString(initials, { maxLength: INITIALS_MAX_LENGTH })) {
    return sendFailure(res, 400, `initials is required (max ${INITIALS_MAX_LENGTH} characters)`);
  }

  try {
    await adminService.updateUserInitials({
      adminUserId: req.session.user.id,
      targetUserId,
      initials: initials.trim(),
    });
    return sendSuccess(res, {}, 'Initials updated');
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') {
      return sendFailure(res, 404, err.message, { code: 'USER_NOT_FOUND' });
    }
    logger.error('admin update initials failed', { targetUserId, error: err.message });
    return sendFailure(res, 500, 'Failed to update initials', { code: 'INTERNAL_ERROR' });
  }
});

router.get('/repo-groups', async (req, res) => {
  try {
    const repoGroups = await adminService.listRepoGroups();
    return sendSuccess(res, { repoGroups });
  } catch (err) {
    logger.error('admin list repo groups failed', { error: err.message });
    return sendFailure(res, 500, 'Failed to list repo groups', { code: 'INTERNAL_ERROR' });
  }
});

router.get('/permissions', async (req, res) => {
  try {
    const permissions = await adminService.listPermissions();
    return sendSuccess(res, { permissions });
  } catch (err) {
    logger.error('admin list permissions failed', { error: err.message });
    return sendFailure(res, 500, 'Failed to list permissions', { code: 'INTERNAL_ERROR' });
  }
});

router.post('/permissions', async (req, res) => {
  const { userId, repoGroupId } = req.body || {};
  const targetUserId = parsePositiveInt(userId);
  const targetRepoGroupId = parsePositiveInt(repoGroupId);
  if (targetUserId === null) {
    return sendFailure(res, 400, 'userId is required');
  }
  if (targetRepoGroupId === null) {
    return sendFailure(res, 400, 'repoGroupId is required');
  }

  try {
    await adminService.grantPermission({
      adminUserId: req.session.user.id,
      targetUserId,
      repoGroupId: targetRepoGroupId,
    });
    return sendSuccess(res, {}, 'Access granted');
  } catch (err) {
    if (err.code === 'ALREADY_GRANTED') {
      return sendFailure(res, 409, err.message, { code: 'ALREADY_GRANTED' });
    }
    if (err.code === 'NOT_FOUND') {
      return sendFailure(res, 404, err.message, { code: 'NOT_FOUND' });
    }
    logger.error('admin grant permission failed', { targetUserId, targetRepoGroupId, error: err.message });
    return sendFailure(res, 500, 'Failed to grant access', { code: 'INTERNAL_ERROR' });
  }
});

router.delete('/permissions/:permissionId', async (req, res) => {
  const permissionId = parsePositiveInt(req.params.permissionId);
  if (permissionId === null) {
    return sendFailure(res, 400, 'Invalid permission id');
  }

  try {
    await adminService.revokePermission({ adminUserId: req.session.user.id, permissionId });
    return sendSuccess(res, {}, 'Access revoked');
  } catch (err) {
    if (err.code === 'PERMISSION_NOT_FOUND') {
      return sendFailure(res, 404, err.message, { code: 'PERMISSION_NOT_FOUND' });
    }
    logger.error('admin revoke permission failed', { permissionId, error: err.message });
    return sendFailure(res, 500, 'Failed to revoke access', { code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
