// Queue backing the Spec/Communication Protocol trunk-staleness rework - see
// db/schema.sql's `spec_doc_jobs` comment. Fed by specDocScanService.js's periodic scan,
// drained by worker.js on its existing fast poll loop. Claiming a job uses the exact same
// atomic conditional UPDATE pattern worker.js already uses for `sessions`
// (claimNextQueuedSession) - a single `UPDATE ... WHERE status='queued'` whose
// affectedRows tells the caller whether it actually won the race, not a SELECT followed
// by a separate UPDATE - so a second worker/poll racing the same row simply affects zero
// rows rather than double-processing it.

const db = require('../db');

async function claimNextSpecDocJob() {
  const queued = await db.query(`SELECT id FROM spec_doc_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`);
  if (queued.length === 0) return null;

  const jobId = queued[0].id;
  const result = await db.query(`UPDATE spec_doc_jobs SET status = 'running' WHERE id = ? AND status = 'queued'`, [jobId]);
  if (result.affectedRows !== 1) return null; // lost the race - another worker/poll already claimed it

  return jobId;
}

async function getSpecDocJobById(jobId) {
  const rows = await db.query(`SELECT id, repo_id AS repoId, trunk_commit_sha AS trunkCommitSha FROM spec_doc_jobs WHERE id = ?`, [
    jobId,
  ]);
  return rows[0] || null;
}

async function finishSpecDocJob({ jobId, status, errorMessage }) {
  await db.query(`UPDATE spec_doc_jobs SET status = ?, error_message = ?, finished_at = NOW() WHERE id = ?`, [
    status,
    errorMessage || null,
    jobId,
  ]);
}

// Lets the scanner skip a repo that already has an in-flight attempt rather than piling
// up duplicate jobs for the same trunk movement (or, worse, for the SAME commit) every
// scan interval.
async function hasNonTerminalJobForRepo(repoId) {
  const rows = await db.query(`SELECT 1 FROM spec_doc_jobs WHERE repo_id = ? AND status IN ('queued', 'running') LIMIT 1`, [
    repoId,
  ]);
  return rows.length > 0;
}

async function enqueueSpecDocJob({ repoId, trunkCommitSha }) {
  await db.query(`INSERT INTO spec_doc_jobs (repo_id, trunk_commit_sha) VALUES (?, ?)`, [repoId, trunkCommitSha]);
}

async function markSpecDocSynced({ repoId, commitSha }) {
  await db.query(`UPDATE repos SET spec_doc_synced_commit_sha = ? WHERE id = ?`, [commitSha, repoId]);
}

module.exports = {
  claimNextSpecDocJob,
  getSpecDocJobById,
  finishSpecDocJob,
  hasNonTerminalJobForRepo,
  enqueueSpecDocJob,
  markSpecDocSynced,
};
