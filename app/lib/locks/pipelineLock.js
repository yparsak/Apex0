// Pipeline lock - serializes the full agent pipeline (clone -> sandbox
// build/test -> push) one session at a time per (repo_id, co_number), per
// roadmap.md's "Lock scope: entire pipeline" decision (a push-only lock
// would let two sandboxes build against stale state and race on push).
// Backed by the pipeline_locks table (db/schema.sql): a row's existence IS
// the lock. Acquiring is an INSERT that relies on the table's
// UNIQUE (repo_id, co_number) constraint to fail if another session already
// holds it; releasing is a DELETE.
//
// Phase 2 wires acquire (at CO resolution, see
// app/lib/branches/coResolutionService.js) and release-on-failure.
// Release-on-SUCCESS is Phase 5's job (see app/lib/pipeline/pipelineService.js's
// runPipelineForSession): the lock stays held across Phase 3's clarification
// loop and Phase 4's sandboxed code-gen/build/test/push, and is only
// released once Phase 5's combined commit (code + requirements log +
// optional spec doc) has actually landed. This is the first call site in the
// project that calls releaseLock() on a successful outcome - see
// agent-prompts.md's "Phase 5" section.
//
// Phase 7: every genuine contention event - one user's acquireLock() losing
// to a DIFFERENT user's already-held lock - is recorded to
// lock_contention_events, feeding the Phase 7 lock-contention dashboard on
// (repo, CO). "Already mine" (coResolutionService.js re-resolving onto a
// lock this same user still holds) is deliberately excluded - that path
// never reaches ER_DUP_ENTRY's catch block with a different holder, so it
// was never contention to begin with.

const db = require('../db');
const logger = require('../logger');

class LockHeldError extends Error {
  constructor(repoId, coNumber) {
    super(`Pipeline lock already held for repo ${repoId}, CO ${coNumber}`);
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
  }
}

async function recordContentionIfDifferentHolder({ repoId, coNumber, requestedByUserId }) {
  const rows = await db.query(
    'SELECT locked_by_user_id AS heldByUserId FROM pipeline_locks WHERE repo_id = ? AND co_number = ?',
    [repoId, coNumber]
  );
  const heldByUserId = rows[0]?.heldByUserId;
  // A missing row means the lock was released between the failed INSERT
  // and this SELECT (the holder's pipeline just finished) - not contention
  // worth recording, since there's no one left to have blocked anyone.
  if (!heldByUserId || heldByUserId === requestedByUserId) return;

  await db.query(
    'INSERT INTO lock_contention_events (repo_id, co_number, requested_by_user_id, held_by_user_id) VALUES (?, ?, ?, ?)',
    [repoId, coNumber, requestedByUserId, heldByUserId]
  );
}

async function acquireLock({ repoId, coNumber, userId }) {
  try {
    await db.query('INSERT INTO pipeline_locks (repo_id, co_number, locked_by_user_id) VALUES (?, ?, ?)', [
      repoId,
      coNumber,
      userId,
    ]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      await recordContentionIfDifferentHolder({ repoId, coNumber, requestedByUserId: userId }).catch((contentionErr) =>
        logger.error('failed to record lock contention event', { repoId, coNumber, error: contentionErr.message })
      );
      throw new LockHeldError(repoId, coNumber);
    }
    throw err;
  }
}

async function releaseLock({ repoId, coNumber }) {
  await db.query('DELETE FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [repoId, coNumber]);
}

// Lets a caller distinguish "someone else is mid-pipeline on this CO" from
// "I'm the one holding this lock, from an earlier resolve in this same
// in-flight run" - see coResolutionService.js's use of this. Without it, a
// user who already resolved once (e.g. created a branch) gets a LockHeldError
// on every subsequent /resolve for that CO - including re-selecting the exact
// branch they just created, since the branch list has no other way to reach
// the session-start screen until a sessions row exists (Phase 3).
async function isLockHeldByUser({ repoId, coNumber, userId }) {
  const rows = await db.query('SELECT 1 FROM pipeline_locks WHERE repo_id = ? AND co_number = ? AND locked_by_user_id = ?', [
    repoId,
    coNumber,
    userId,
  ]);
  return rows.length > 0;
}

module.exports = { acquireLock, releaseLock, isLockHeldByUser, LockHeldError };
