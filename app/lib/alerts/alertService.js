// Phase 7: records + lists "blocked-allowlist attempt" alerts - see
// roadmap.md's "Alerts on blocked-allowlist attempts" bullet under Phase 7.
//
// A blocked-allowlist attempt is a GitHub write call (branch creation or the
// Phase 4/5 combined push) that came back HTTP 403 - see db/schema.sql's
// blocked_allowlist_alerts comment for why 403 is the classification this
// project uses. This module only persists + surfaces the event; it never
// changes pipeline behavior - the caller still fails loudly on the
// underlying error exactly as it did before Phase 7 (see
// app/lib/branches/coResolutionService.js and
// app/lib/pipeline/pipelineService.js, the two call sites that invoke
// recordBlockedAllowlistAttempt and then rethrow their original error
// regardless of whether recording succeeded).

const db = require('../db');
const logger = require('../logger');

async function recordBlockedAllowlistAttempt({
  repoId,
  coNumber,
  branchName,
  sessionId,
  operation,
  httpStatus,
  responseDetail,
}) {
  await db.query(
    `INSERT INTO blocked_allowlist_alerts (repo_id, co_number, branch_name, session_id, operation, http_status, response_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      repoId,
      coNumber ?? null,
      branchName,
      sessionId ?? null,
      operation,
      httpStatus,
      // Capped, not the raw unbounded GitHub error body - same
      // truncate-and-log discipline sandboxRunner.js's MAX_LOG_CHARS and
      // diffService.js already follow elsewhere in this project.
      responseDetail ? responseDetail.slice(0, 5000) : null,
    ]
  );
  logger.error('blocked-allowlist attempt', { repoId, coNumber, branchName, sessionId, operation, httpStatus });
}

async function listBlockedAllowlistAttempts() {
  return db.query(
    `SELECT a.id, a.repo_id AS repoId, r.name AS repoName, a.co_number AS coNumber, a.branch_name AS branchName,
            a.session_id AS sessionId, a.operation, a.http_status AS httpStatus, a.response_detail AS responseDetail,
            a.created_at AS createdAt
     FROM blocked_allowlist_alerts a
     JOIN repos r ON r.id = a.repo_id
     ORDER BY a.created_at DESC
     LIMIT 200`
  );
}

module.exports = { recordBlockedAllowlistAttempt, listBlockedAllowlistAttempts };
