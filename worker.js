// Phase 4 worker entrypoint. Polls `sessions` for status='queued' rows and
// runs the sandboxed-execution pipeline against one at a time, independent
// of any live browser session (see roadmap.md's "Runs as an async
// background job" bullet). Mirrors server.js's entrypoint style (load env,
// then start) but exposes no HTTP surface of its own.
//
// Claiming a session is a single conditional UPDATE
// (`status='running' WHERE id=? AND status='queued'`), not a SELECT then a
// separate UPDATE - this is what prevents double pickup without needing
// DB-specific `SKIP LOCKED` syntax: only one such UPDATE can ever affect the
// row, so a second worker (or a second poll racing itself) simply affects
// zero rows and moves on. See agent-prompts.md's Phase 4 section for the
// full design.
//
// Spec/Communication Protocol doc rework: this same process now also drains a second,
// unrelated queue (`spec_doc_jobs`) on the same fast loop - session pickup is tried
// first every tick, and only when there's no queued session does a tick fall through to
// a queued spec-doc job, so spec-doc regeneration never delays a user-facing session.
// Feeding that queue is a separate, much slower loop (specDocScanLoop) that enumerates
// every repo in the system and checks trunk for new commits - see
// app/lib/pipeline/specDocScanService.js's file comment for why that check does not
// belong on the fast loop's cadence.

require('dotenv').config();

const logger = require('./app/lib/logger');
const db = require('./app/lib/db');
const { runPipelineForSession } = require('./app/lib/pipeline/pipelineService');
const { getRepoById } = require('./app/lib/repos/repoAccess');
const { downloadAndExtractTree, cleanupWorkingTree } = require('./app/lib/pipeline/workingTreeService');
const { regenerateSpecDoc } = require('./app/lib/pipeline/specDocService');
const { scanReposForStaleSpecDocs } = require('./app/lib/pipeline/specDocScanService');
const {
  claimNextSpecDocJob,
  getSpecDocJobById,
  finishSpecDocJob,
  markSpecDocSynced,
} = require('./app/lib/pipeline/specDocJobService');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const SPEC_DOC_SCAN_INTERVAL_MS = Number(process.env.WORKER_SPEC_DOC_SCAN_INTERVAL_MS) || 900000;

async function claimNextQueuedSession() {
  const queued = await db.query(`SELECT id FROM sessions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`);
  if (queued.length === 0) return null;

  const sessionId = queued[0].id;
  const result = await db.query(`UPDATE sessions SET status = 'running' WHERE id = ? AND status = 'queued'`, [sessionId]);
  if (result.affectedRows !== 1) return null; // lost the race - another worker/poll already claimed it

  return sessionId;
}

async function processSpecDocJob(jobId) {
  const job = await getSpecDocJobById(jobId);
  const repo = await getRepoById(job.repoId);

  let workDir;
  try {
    const { workDir: dir, treeDir } = await downloadAndExtractTree({
      owner: repo.githubOwner,
      repoName: repo.name,
      ref: repo.defaultBranchName,
    });
    workDir = dir;

    await regenerateSpecDoc({ repo, treeDir });
    await markSpecDocSynced({ repoId: repo.id, commitSha: job.trunkCommitSha });
    await finishSpecDocJob({ jobId, status: 'completed' });
    logger.info('spec doc job completed', { jobId, repoId: repo.id });
  } catch (err) {
    await finishSpecDocJob({ jobId, status: 'failed', errorMessage: err.message });
    logger.error('spec doc job failed', { jobId, repoId: repo.id, error: err.message });
  } finally {
    if (workDir) await cleanupWorkingTree(workDir);
  }
}

async function pollOnce() {
  const sessionId = await claimNextQueuedSession();
  if (sessionId !== null) {
    logger.info('worker claimed queued session', { sessionId });
    await runPipelineForSession(sessionId);
    return;
  }

  const jobId = await claimNextSpecDocJob();
  if (jobId !== null) {
    logger.info('worker claimed spec doc job', { jobId });
    await processSpecDocJob(jobId);
  }
}

async function loop() {
  try {
    await pollOnce();
  } catch (err) {
    logger.error('worker poll iteration failed', { error: err.message });
  } finally {
    setTimeout(loop, POLL_INTERVAL_MS);
  }
}

async function specDocScanLoop() {
  try {
    await scanReposForStaleSpecDocs();
  } catch (err) {
    logger.error('spec doc staleness scan failed', { error: err.message });
  } finally {
    setTimeout(specDocScanLoop, SPEC_DOC_SCAN_INTERVAL_MS);
  }
}

logger.info('Apex worker starting', { pollIntervalMs: POLL_INTERVAL_MS, specDocScanIntervalMs: SPEC_DOC_SCAN_INTERVAL_MS });
loop();
specDocScanLoop();
