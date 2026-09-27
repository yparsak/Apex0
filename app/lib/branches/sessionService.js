// Phase 3 clarification loop: session lifecycle, Q&A turns against the
// model adapter, requirements finalization, and duplicate/overlap detection.
// See roadmap.md's "Phase 3 - Clarification loop" bullets for the scope this
// implements, and agent-prompts.md's "Phase 3" section for the system-prompt
// strategy, response-parsing convention, and audit-log semantics this module
// follows. Depends on the GitHub diff service and the model adapter, never
// on GitHub/model calls made ad hoc elsewhere - mirrors the separation
// coResolutionService.js keeps for Phase 2.
//
// Session status state machine (not spelled out verbatim in roadmap.md, so
// documented here):
//   - A session is created with status 'running' the first time a user
//     starts the clarification loop on a branch they don't already have a
//     non-terminal (awaiting_approval/queued/running) session on.
//   - Opening the loop again while a non-terminal session already exists
//     reuses it rather than creating a new row (see startOrResumeSession).
//   - 'running' -> 'awaiting_approval' once every session_requirements row
//     for the session has left 'pending_confirm' (i.e. is
//     'confirmed_proceed' or 'confirmed_skip') AND at least one is
//     'confirmed_proceed'. This is a human gate, not an automatic one: the
//     session sits in 'awaiting_approval' - showing an "Approve & Implement"
//     button - until the session's owner explicitly approves it (see
//     approveSession). Only that explicit action sets 'queued', which is
//     what worker.js actually polls for pickup.
//   - This running/awaiting_approval sync is bidirectional and fully
//     automatic (see syncSessionStatus): if the requirement set stops being
//     "fully resolved with at least one proceed" (the user adds more
//     instructions, or a new pending_confirm shows up from an overlap
//     check), it flips back to 'running'. Getting back to 'queued' after
//     that always requires a fresh, explicit approval - approval is never
//     "locked in" once given, but it's also never assumed; re-approving is
//     just one more click, not a separate "revoke" step.
//   - 'queued' -> 'running' happens two ways: worker.js's atomic claim (see
//     claimNextQueuedSession) once the pipeline actually starts executing,
//     or this module demoting it back down (same bidirectional sync as
//     above) if new unresolved work shows up before the worker gets to it.
//     Once a pipeline_runs row exists for the session with status
//     'running' (i.e. the worker has already claimed and started it),
//     syncSessionStatus leaves status alone entirely - see
//     hasActivePipelineRun - since at that point 'running' means "actively
//     executing," not "still gathering approval," and must not be
//     reinterpreted as the latter just because a user sends a stray
//     message. postMessage() rejects new messages for that same reason.
//   - 'completed'/'failed' are terminal and out of this module's control -
//     they belong to Phase 4/5's pipeline execution. A terminal session is
//     never resumed; a fresh one is started instead (see
//     startOrResumeSession).

const db = require('../db');
const logger = require('../logger');
const { getModelAdapter } = require('../model');
const { getBranchDiffSummary } = require('../github/diffService');
const { buildStartSummaryMessages, buildQaSystemPrompt, buildOverlapCheckMessages } = require('./clarificationPrompts');
const { parseRequirementsReady, parseOverlapCheck } = require('./responseParsing');

// How many prior audit_log rows (across all users/sessions) to feed into the
// start/resume summary for this (repo, CO). Fixed, non-user-supplied
// constant - inlined into the SQL LIMIT rather than bound as a placeholder,
// since mysql2 prepared statements are unreliable with bound LIMIT values.
const AUDIT_HISTORY_LIMIT = 20;

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// --- branch/session lookups -------------------------------------------------

async function getActiveBranch({ repoId, branchId }) {
  const rows = await db.query(
    `SELECT id, repo_id AS repoId, initials, co_number AS coNumber, branch_name AS branchName,
            created_by_user_id AS createdByUserId, status
     FROM branches
     WHERE id = ? AND repo_id = ? AND status = 'active'`,
    [branchId, repoId]
  );
  return rows[0] || null;
}

async function getSessionById(sessionId) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions WHERE id = ?`,
    [sessionId]
  );
  return rows[0] || null;
}

async function getSessionForBranch({ sessionId, branchId }) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions WHERE id = ? AND branch_id = ?`,
    [sessionId, branchId]
  );
  return rows[0] || null;
}

async function getLatestSessionForUser({ userId, branchId }) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions WHERE user_id = ? AND branch_id = ? ORDER BY created_at DESC LIMIT 1`,
    [userId, branchId]
  );
  return rows[0] || null;
}

async function createSession({ userId, branchId }) {
  const result = await db.query(`INSERT INTO sessions (user_id, branch_id, status) VALUES (?, ?, 'running')`, [
    userId,
    branchId,
  ]);
  return getSessionById(result.insertId);
}

async function countConversations(sessionId) {
  const rows = await db.query('SELECT COUNT(*) AS total FROM conversations WHERE session_id = ?', [sessionId]);
  return rows[0].total;
}

// --- conversations / audit_log logging --------------------------------------
//
// audit_log is append-only by design (roadmap.md Accepted Risk #4 treats it
// as the engineering-record audit trail) - every call into the model in this
// module writes exactly one new audit_log row, never an UPDATE. raw_instructions
// holds the real user text for a Q&A turn, or null for a system-triggered call
// (the start/resume summary, the overlap check) that has no user-authored
// instruction behind it. qa_history holds the model's raw reply text
// verbatim, fenced block and all, so a later parse dispute can be re-audited
// against exactly what the model said.
//
// conversations is the visible/replayable transcript. role is 'user' or
// 'assistant' for anything the user should see (Q&A turns, the start
// summary), or 'system' for internal-only turns (the overlap check) that are
// recorded for audit purposes but excluded from the chat transcript the UI
// renders (see getSessionDetail) and from the prior-turn context replayed
// into subsequent Q&A calls (see postMessage).

async function recordConversation({ sessionId, role, content }) {
  await db.query('INSERT INTO conversations (session_id, role, content) VALUES (?, ?, ?)', [sessionId, role, content]);
}

async function recordAudit({ userId, repoId, coNumber, rawInstructions, qaHistory }) {
  await db.query(
    `INSERT INTO audit_log (user_id, repo_id, co_number, raw_instructions, qa_history) VALUES (?, ?, ?, ?, ?)`,
    [userId, repoId, coNumber, rawInstructions || null, qaHistory || null]
  );
}

async function getAuditHistory({ repoId, coNumber }) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, raw_instructions AS rawInstructions, qa_history AS qaHistory, created_at AS createdAt
     FROM audit_log WHERE repo_id = ? AND co_number = ? ORDER BY created_at DESC LIMIT ${AUDIT_HISTORY_LIMIT}`,
    [repoId, coNumber]
  );
  return rows;
}

// One call into the model adapter, plus the conversations/audit_log writes
// that must accompany it. Every model call in this module goes through this
// so the logging convention above can't be forgotten at a call site.
async function runChatTurn({ session, repo, coNumber, actingUserId, messages, persistUserMessage, replyRole }) {
  const { content } = await getModelAdapter().chat({ messages });

  if (persistUserMessage) {
    await recordConversation({ sessionId: session.id, role: 'user', content: persistUserMessage });
  }
  await recordConversation({ sessionId: session.id, role: replyRole, content });
  await recordAudit({
    userId: actingUserId,
    repoId: repo.id,
    coNumber,
    rawInstructions: persistUserMessage || null,
    qaHistory: content,
  });

  return content;
}

// --- session status sync -----------------------------------------------------

// True once worker.js has claimed this session and pipelineService has
// started executing it (see pipelineService.js's createPipelineRun, called
// before any other pipeline work). This is the one reliable way to tell
// the two meanings of a 'running' session status apart from the sessions
// row alone - see the state-machine comment above.
async function hasActivePipelineRun(sessionId) {
  const rows = await db.query(`SELECT 1 FROM pipeline_runs WHERE session_id = ? AND status = 'running' LIMIT 1`, [sessionId]);
  return rows.length > 0;
}

async function syncSessionStatus(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session || session.status === 'completed' || session.status === 'failed') return;
  if (await hasActivePipelineRun(sessionId)) return;

  const rows = await db.query(
    `SELECT
       SUM(resolution_status = 'pending_confirm') AS pendingCount,
       SUM(resolution_status = 'confirmed_proceed') AS proceedCount,
       COUNT(*) AS total
     FROM session_requirements WHERE session_id = ?`,
    [sessionId]
  );
  const { pendingCount, proceedCount, total } = rows[0];
  const isReady = Number(total) > 0 && Number(pendingCount) === 0 && Number(proceedCount) > 0;

  // 'queued' means the owner already approved this exact ready state. Never
  // auto-promote INTO 'queued' here - that's approveSession's job alone.
  // Only demote out of it, and only if it's no longer actually ready.
  let nextStatus;
  if (session.status === 'queued') {
    nextStatus = isReady ? 'queued' : 'running';
  } else {
    nextStatus = isReady ? 'awaiting_approval' : 'running';
  }

  if (nextStatus !== session.status) {
    await db.query('UPDATE sessions SET status = ? WHERE id = ?', [nextStatus, sessionId]);
    logger.info('session status transitioned', { sessionId, from: session.status, to: nextStatus });
  }
}

// --- start / resume ----------------------------------------------------------

async function generateStartSummary({ session, repo, branch, actingUserId }) {
  const diff = await getBranchDiffSummary({
    owner: repo.githubOwner,
    repoName: repo.name,
    base: repo.defaultBranchName,
    head: branch.branchName,
  });
  const history = await getAuditHistory({ repoId: repo.id, coNumber: branch.coNumber });

  const messages = buildStartSummaryMessages({ repo, branch, diff, history });

  await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId,
    messages,
    persistUserMessage: null,
    replyRole: 'assistant',
  });
}

async function startOrResumeSession({ repo, branch, user }) {
  let session = await getLatestSessionForUser({ userId: user.id, branchId: branch.id });
  let needsSummary = false;

  if (!session || session.status === 'completed' || session.status === 'failed') {
    session = await createSession({ userId: user.id, branchId: branch.id });
    needsSummary = true;
  } else if ((await countConversations(session.id)) === 0) {
    // Defensive: a non-terminal session with no summary yet. Should only
    // happen if a prior start attempt failed after the INSERT but before
    // the summary call completed - treat it the same as brand-new.
    needsSummary = true;
  }

  if (needsSummary) {
    await generateStartSummary({ session, repo, branch, actingUserId: user.id });
  }

  return session;
}

// --- Q&A turn + finalization --------------------------------------------------

async function getConfirmedRequirementsOnBranch({ branchId }) {
  const rows = await db.query(
    `SELECT sr.id, sr.content
     FROM session_requirements sr
     JOIN sessions s ON s.id = sr.session_id
     WHERE s.branch_id = ? AND sr.resolution_status = 'confirmed_proceed'
     ORDER BY sr.submitted_at ASC`,
    [branchId]
  );
  return rows;
}

async function insertRequirements({ sessionId, requirements }) {
  // Sequential inserts, not a batch - Q&A finalization typically yields a
  // handful of requirements at once, so the simplicity of tracking each
  // insertId this way outweighs any batch-insert performance gain here.
  const inserted = [];
  for (const content of requirements) {
    const result = await db.query(
      `INSERT INTO session_requirements (session_id, content, resolution_status) VALUES (?, ?, NULL)`,
      [sessionId, content]
    );
    inserted.push({ id: result.insertId, content, resolutionStatus: null, overlapFlagRequirementId: null });
  }
  return inserted;
}

// Checks each newly finalized requirement against already-`confirmed_proceed`
// requirements on this same branch (any user's session) - the best available
// proxy for "already implemented" at this phase (see roadmap.md Accepted
// Risk #8; there is no actual code-execution signal yet). Fails closed on
// any parse ambiguity: an unparseable or unverifiable judgment defaults every
// affected item to pending_confirm rather than letting it through, since a
// human confirmation is the whole point of this feature, not an optimization
// to skip when the model is unsure.
async function applyOverlapCheck({ session, repo, branch, inserted }) {
  const diff = await getBranchDiffSummary({
    owner: repo.githubOwner,
    repoName: repo.name,
    base: repo.defaultBranchName,
    head: branch.branchName,
  });
  const existing = await getConfirmedRequirementsOnBranch({ branchId: branch.id });

  const messages = buildOverlapCheckMessages({
    repo,
    branch,
    diff,
    existingRequirements: existing,
    candidateRequirements: inserted.map((r) => r.content),
  });

  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const parsed = parseOverlapCheck(reply, inserted.length);
  const existingIds = new Set(existing.map((r) => r.id));

  for (let i = 0; i < inserted.length; i++) {
    const row = inserted[i];
    let resolutionStatus;
    let overlapFlagRequirementId = null;

    if (parsed === null) {
      resolutionStatus = 'pending_confirm';
      logger.warn('overlap-check reply failed to parse, defaulting to pending_confirm', {
        sessionId: session.id,
        requirementId: row.id,
      });
    } else {
      const verdict = parsed.get(i);
      if (verdict.duplicate && existingIds.has(verdict.duplicateOfRequirementId)) {
        resolutionStatus = 'pending_confirm';
        overlapFlagRequirementId = verdict.duplicateOfRequirementId;
      } else if (verdict.duplicate) {
        // The model named an id we never offered it as "already agreed" -
        // an unverifiable reference is exactly the kind of ambiguity this
        // fails closed on, same as a parse failure.
        resolutionStatus = 'pending_confirm';
        logger.warn('overlap-check named an unknown duplicateOfRequirementId, defaulting to pending_confirm', {
          sessionId: session.id,
          requirementId: row.id,
          claimedId: verdict.duplicateOfRequirementId,
        });
      } else {
        resolutionStatus = 'confirmed_proceed';
      }
    }

    await db.query('UPDATE session_requirements SET resolution_status = ?, overlap_flag_requirement_id = ? WHERE id = ?', [
      resolutionStatus,
      overlapFlagRequirementId,
      row.id,
    ]);
    row.resolutionStatus = resolutionStatus;
    row.overlapFlagRequirementId = overlapFlagRequirementId;
  }

  return inserted;
}

async function finalizeRequirements({ session, repo, branch, requirements }) {
  const inserted = await insertRequirements({ sessionId: session.id, requirements });
  const resolved = await applyOverlapCheck({ session, repo, branch, inserted });
  await syncSessionStatus(session.id);
  return resolved;
}

async function postMessage({ session, repo, branch, actingUserId, message }) {
  if (session.status === 'completed' || session.status === 'failed') {
    throw makeError('This session has already finished and cannot accept new messages', 'SESSION_TERMINAL');
  }
  // A 'running' session is ambiguous by status alone (see the state-machine
  // comment above) - it's either still mid-chat, or the worker has already
  // claimed it and is actively executing. Only the latter needs blocking
  // here; hasActivePipelineRun is what tells them apart.
  if (session.status === 'running' && (await hasActivePipelineRun(session.id))) {
    throw makeError('This session is currently being implemented and cannot accept new messages', 'SESSION_TERMINAL');
  }

  // Prior visible turns only (user/assistant) - the overlap check's
  // system-role turn is intentionally excluded from what's replayed back
  // into the ongoing Q&A conversation; it's a separate, internal concern.
  const priorRows = await db.query(
    `SELECT role, content FROM conversations WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at ASC`,
    [session.id]
  );

  const messages = [{ role: 'system', content: buildQaSystemPrompt({ repo, branch }) }, ...priorRows, { role: 'user', content: message }];

  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId,
    messages,
    persistUserMessage: message,
    replyRole: 'assistant',
  });

  const finalRequirements = parseRequirementsReady(reply);
  if (finalRequirements === null) {
    return { finalized: false, reply };
  }

  const requirements = await finalizeRequirements({ session, repo, branch, requirements: finalRequirements });
  return { finalized: true, reply, requirements };
}

// Manual escape hatch for the NVIDIA NIM degeneration bug documented in
// nvidiaNimAdapter.js: that adapter already retries and rejects the most
// blatant garbage (e.g. a reply that's nothing but repeated "!"), but a
// reply that mixes in enough other characters can still slip through as a
// perfectly normal-looking 200. Only the session's own most recent visible
// (user/assistant) turn is regenerable, and only when it's an assistant
// reply - regenerating an older turn would mean re-deriving everything that
// happened after it (later requirements, resolutions, etc.), which this
// deliberately does not attempt.
async function regenerateLastReply({ session, repo, branch, actingUserId }) {
  if (actingUserId !== session.userId) {
    throw makeError('Only the session owner can regenerate a reply', 'FORBIDDEN');
  }
  if (session.status === 'completed' || session.status === 'failed') {
    throw makeError('This session has already finished and cannot be modified', 'SESSION_TERMINAL');
  }
  if (session.status === 'running' && (await hasActivePipelineRun(session.id))) {
    throw makeError('This session is currently being implemented and cannot be modified', 'SESSION_TERMINAL');
  }

  const visibleRows = await db.query(
    `SELECT id, role, content, created_at AS createdAt FROM conversations
     WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at ASC`,
    [session.id]
  );
  const last = visibleRows[visibleRows.length - 1];
  if (!last || last.role !== 'assistant') {
    throw makeError('The latest message is not an agent reply that can be regenerated', 'INVALID_STATE');
  }

  // If this reply already led to real side effects (it got parsed as a
  // finalized requirements set), silently swapping its content would leave
  // those session_requirements rows orphaned from what the transcript now
  // shows - refuse rather than guess at cleanup.
  const laterRequirements = await db.query(
    `SELECT 1 FROM session_requirements WHERE session_id = ? AND submitted_at > ? LIMIT 1`,
    [session.id, last.createdAt]
  );
  if (laterRequirements.length > 0) {
    throw makeError('This reply already produced requirements and cannot be regenerated', 'INVALID_STATE');
  }

  const priorRows = visibleRows.slice(0, -1);
  const messages =
    priorRows.length === 0
      ? await (async () => {
          // Nothing before it at all - this was the session's opening
          // start-summary turn (see generateStartSummary), not a Q&A reply.
          const diff = await getBranchDiffSummary({
            owner: repo.githubOwner,
            repoName: repo.name,
            base: repo.defaultBranchName,
            head: branch.branchName,
          });
          const history = await getAuditHistory({ repoId: repo.id, coNumber: branch.coNumber });
          return buildStartSummaryMessages({ repo, branch, diff, history });
        })()
      : [
          { role: 'system', content: buildQaSystemPrompt({ repo, branch }) },
          ...priorRows.map((r) => ({ role: r.role, content: r.content })),
        ];

  const { content } = await getModelAdapter().chat({ messages });

  await db.query('UPDATE conversations SET content = ? WHERE id = ?', [content, last.id]);
  await recordAudit({
    userId: actingUserId,
    repoId: repo.id,
    coNumber: branch.coNumber,
    rawInstructions: null,
    qaHistory: content,
  });

  return content;
}

// --- resolve / confirm --------------------------------------------------------

async function resolveRequirement({ session, requirementId, resolution, actingUserId }) {
  // Defense in depth: route layer already enforces that only the session's
  // owner can reach this (see app/routes/sessions.js's loadOwnedSession),
  // but the invariant is re-checked here too since this is where it
  // actually matters - no auto-skip, no override by anyone but the
  // submitting user, per roadmap.md's confirm/override decision.
  if (actingUserId !== session.userId) {
    throw makeError('Only the session owner can resolve its requirements', 'FORBIDDEN');
  }
  if (resolution !== 'confirmed_proceed' && resolution !== 'confirmed_skip') {
    throw makeError('resolution must be "confirmed_proceed" or "confirmed_skip"', 'INVALID_RESOLUTION');
  }

  const rows = await db.query(
    `SELECT id, session_id AS sessionId, content, resolution_status AS resolutionStatus
     FROM session_requirements WHERE id = ? AND session_id = ?`,
    [requirementId, session.id]
  );
  const requirement = rows[0];
  if (!requirement) {
    throw makeError('Requirement not found on this session', 'NOT_FOUND');
  }
  if (requirement.resolutionStatus !== 'pending_confirm') {
    throw makeError(`Requirement is not awaiting confirmation (current status: ${requirement.resolutionStatus})`, 'INVALID_STATE');
  }

  await db.query('UPDATE session_requirements SET resolution_status = ? WHERE id = ?', [resolution, requirementId]);
  await syncSessionStatus(session.id);

  return { ...requirement, resolutionStatus: resolution };
}

// The one explicit human gate between clarification and worker.js's pickup
// - see the state-machine comment above. Deliberately re-reads the session
// and re-derives readiness rather than trusting the caller's (possibly
// stale) `session` object, since the page could have been open a while;
// the conditional UPDATE below is the actual race guard, this is just what
// produces a clear error instead of a silent no-op.
async function approveSession({ session, actingUserId }) {
  if (actingUserId !== session.userId) {
    throw makeError('Only the session owner can approve it', 'FORBIDDEN');
  }

  const current = await getSessionById(session.id);
  if (!current || current.status !== 'awaiting_approval') {
    throw makeError(
      `Session is not awaiting approval (current status: ${current ? current.status : 'not found'})`,
      'INVALID_STATE'
    );
  }

  const result = await db.query(`UPDATE sessions SET status = 'queued' WHERE id = ? AND status = 'awaiting_approval'`, [session.id]);
  if (result.affectedRows !== 1) {
    throw makeError('Session status changed before approval could be applied - refresh and try again', 'INVALID_STATE');
  }

  logger.info('session approved for implementation', { sessionId: session.id, actingUserId });
  return getSessionById(session.id);
}

// --- read views ---------------------------------------------------------------

async function listOtherSessionsForBranch({ branchId, excludingUserId }) {
  const sessions = await db.query(
    `SELECT s.id, s.user_id AS userId, u.username, u.initials, s.status, s.created_at AS createdAt
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.branch_id = ? AND s.user_id != ?
     ORDER BY s.created_at DESC`,
    [branchId, excludingUserId]
  );
  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const placeholders = sessionIds.map(() => '?').join(', ');
  const requirementRows = await db.query(
    `SELECT session_id AS sessionId, content, resolution_status AS resolutionStatus
     FROM session_requirements WHERE session_id IN (${placeholders}) ORDER BY submitted_at ASC`,
    sessionIds
  );

  const requirementsBySession = new Map();
  for (const row of requirementRows) {
    if (!requirementsBySession.has(row.sessionId)) requirementsBySession.set(row.sessionId, []);
    requirementsBySession.get(row.sessionId).push({ content: row.content, resolutionStatus: row.resolutionStatus });
  }

  return sessions.map((s) => ({
    sessionId: s.id,
    username: s.username,
    initials: s.initials,
    status: s.status,
    createdAt: s.createdAt,
    requirements: requirementsBySession.get(s.id) || [],
  }));
}

// Phase 4's latest pipeline_runs row for this session, if any - included in
// getSessionDetail below so the UI's Pipeline panel can render status/log/
// commit link off the same GET .../sessions/:id call, per the "don't add a
// new endpoint for this" instruction. This is a plain read of a table Phase
// 4 owns (app/lib/pipeline/pipelineService.js writes it); kept here rather
// than importing pipelineService.js to avoid a require cycle, since
// pipelineService.js already depends on this module for runChatTurn below.
async function getLatestPipelineRun(sessionId) {
  const rows = await db.query(
    `SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, log,
            commit_sha AS commitSha, spec_doc_path AS specDocPath, error_message AS errorMessage
     FROM pipeline_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function getSessionDetail({ session, repo, branch }) {
  const conversations = await db.query(
    `SELECT id, role, content, created_at AS createdAt FROM conversations
     WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at ASC`,
    [session.id]
  );
  const requirements = await db.query(
    `SELECT id, content, submitted_at AS submittedAt, overlap_flag_requirement_id AS overlapFlagRequirementId,
            resolution_status AS resolutionStatus
     FROM session_requirements WHERE session_id = ? ORDER BY submitted_at ASC`,
    [session.id]
  );
  const otherSessions = await listOtherSessionsForBranch({ branchId: branch.id, excludingUserId: session.userId });
  const pipelineRun = await getLatestPipelineRun(session.id);

  return { session, repo, branch, conversations, requirements, otherSessions, pipelineRun };
}

module.exports = {
  getActiveBranch,
  getSessionForBranch,
  startOrResumeSession,
  postMessage,
  regenerateLastReply,
  resolveRequirement,
  approveSession,
  getSessionDetail,
  // Reused as-is by Phase 4's app/lib/pipeline/pipelineService.js for its two
  // system-triggered model calls (file-selection, code-changes), so every
  // model call in the whole app goes through the same conversations/
  // audit_log discipline established here - see agent-prompts.md's Phase 4
  // section.
  runChatTurn,
};
