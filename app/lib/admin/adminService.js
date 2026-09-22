// Access-administration queries (Phase 6) - closes the gap
// app/lib/repos/repoAccess.js's file comment and Phase2_test.md's raw-SQL
// seeding instructions both describe: "no admin UI for that table yet."
// Every mutation here writes a row to admin_audit_log (see
// recordAdminAction below), per roadmap.md's "itself audit-logged"
// requirement for the Phase 6 admin UI - append-only, same discipline
// audit_log already follows.
//
// Phase 7 additions below (listBlockedAllowlistAlerts, listLockContention,
// listActiveLocks) are read-only observability queries, not admin
// mutations - they intentionally don't write to admin_audit_log, since
// viewing a dashboard isn't an action taken against another user or
// permission the way everything else in this file is.

const db = require('../db');
const { listBlockedAllowlistAttempts } = require('../alerts/alertService');

async function recordAdminAction({ adminUserId, action, targetUserId, repoGroupId, detail }) {
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, repo_group_id, detail)
     VALUES (?, ?, ?, ?, ?)`,
    [adminUserId, action, targetUserId ?? null, repoGroupId ?? null, detail ?? null]
  );
}

async function listUsers() {
  return db.query(
    `SELECT id, username, initials, is_admin AS isAdmin, created_at AS createdAt
     FROM users ORDER BY username`
  );
}

async function updateUserInitials({ adminUserId, targetUserId, initials }) {
  const result = await db.query('UPDATE users SET initials = ? WHERE id = ?', [initials, targetUserId]);
  if (result.affectedRows === 0) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  await recordAdminAction({
    adminUserId,
    action: 'update_initials',
    targetUserId,
    detail: `initials set to "${initials}"`,
  });
}

async function listRepoGroups() {
  return db.query(
    `SELECT rg.id, rg.name, o.id AS orgId, o.name AS orgName
     FROM repo_groups rg
     JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name`
  );
}

async function listPermissions() {
  return db.query(
    `SELECT p.id, p.user_id AS userId, u.username, u.initials,
            p.repo_group_id AS repoGroupId, rg.name AS repoGroupName, o.name AS orgName,
            p.created_at AS createdAt
     FROM user_repo_group_permissions p
     JOIN users u ON u.id = p.user_id
     JOIN repo_groups rg ON rg.id = p.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     ORDER BY u.username, o.name, rg.name`
  );
}

async function grantPermission({ adminUserId, targetUserId, repoGroupId }) {
  try {
    await db.query('INSERT INTO user_repo_group_permissions (user_id, repo_group_id) VALUES (?, ?)', [
      targetUserId,
      repoGroupId,
    ]);
  } catch (err) {
    // ER_DUP_ENTRY - the table's UNIQUE (user_id, repo_group_id) constraint
    // (db/schema.sql) already rejects a repeat grant; surface it as a
    // distinct, expected outcome rather than a generic 500.
    if (err.code === 'ER_DUP_ENTRY') {
      const dupErr = new Error('User already has access to this repo group');
      dupErr.code = 'ALREADY_GRANTED';
      throw dupErr;
    }
    // ER_NO_REFERENCED_ROW_2 - one of the FK targets (user_id, repo_group_id)
    // doesn't exist. Both ids come from the admin UI's own dropdowns, so
    // this should only happen on a stale page; still fail closed rather
    // than guess which id was bad.
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      const refErr = new Error('User or repo group not found');
      refErr.code = 'NOT_FOUND';
      throw refErr;
    }
    throw err;
  }

  await recordAdminAction({ adminUserId, action: 'grant_permission', targetUserId, repoGroupId });
}

async function revokePermission({ adminUserId, permissionId }) {
  const rows = await db.query(
    'SELECT user_id AS userId, repo_group_id AS repoGroupId FROM user_repo_group_permissions WHERE id = ?',
    [permissionId]
  );
  if (rows.length === 0) {
    const err = new Error('Permission not found');
    err.code = 'PERMISSION_NOT_FOUND';
    throw err;
  }

  const { userId: targetUserId, repoGroupId } = rows[0];
  await db.query('DELETE FROM user_repo_group_permissions WHERE id = ?', [permissionId]);
  await recordAdminAction({ adminUserId, action: 'revoke_permission', targetUserId, repoGroupId });
}

// Phase 7: surfaces blocked_allowlist_alerts rows (see
// app/lib/alerts/alertService.js and db/schema.sql) in the admin UI.
async function listBlockedAllowlistAlerts() {
  return listBlockedAllowlistAttempts();
}

// Phase 7: aggregated contention counts per (repo, CO) - the "lock
// contention dashboard" roadmap.md's Phase 7 bullet calls for - ordered so
// the most-contended COs surface first.
async function listLockContention() {
  return db.query(
    `SELECT e.repo_id AS repoId, r.name AS repoName, e.co_number AS coNumber,
            COUNT(*) AS contentionCount, MAX(e.created_at) AS lastContentionAt
     FROM lock_contention_events e
     JOIN repos r ON r.id = e.repo_id
     GROUP BY e.repo_id, e.co_number, r.name
     ORDER BY contentionCount DESC, lastContentionAt DESC`
  );
}

// Phase 7: currently-held pipeline locks - the dashboard's other half,
// showing what's actually serializing right now (not just historical
// contention). A row's mere existence in pipeline_locks IS the lock (see
// pipelineLock.js), so this is a plain join, no separate "is it stale"
// check - the same on-demand-only philosophy this project already applies
// to branch-deletion detection.
async function listActiveLocks() {
  return db.query(
    `SELECT l.id, l.repo_id AS repoId, r.name AS repoName, l.co_number AS coNumber,
            l.locked_by_user_id AS lockedByUserId, u.username AS lockedByUsername, l.locked_at AS lockedAt
     FROM pipeline_locks l
     JOIN repos r ON r.id = l.repo_id
     JOIN users u ON u.id = l.locked_by_user_id
     ORDER BY l.locked_at ASC`
  );
}

module.exports = {
  listUsers,
  updateUserInitials,
  listRepoGroups,
  listPermissions,
  grantPermission,
  revokePermission,
  listBlockedAllowlistAlerts,
  listLockContention,
  listActiveLocks,
};
