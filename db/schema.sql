-- Phase 0 schema — see roadmap.md "Data model (Phase 0)" for the rationale behind each table.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  initials VARCHAR(10) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orgs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS repo_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  org_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS repos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_group_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  default_branch_name VARCHAR(255) NOT NULL DEFAULT 'main',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_group_id) REFERENCES repo_groups(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_repo_group_permissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  repo_group_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (repo_group_id) REFERENCES repo_groups(id),
  UNIQUE (user_id, repo_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS change_orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  UNIQUE (repo_id, co_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS branches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  created_by_user_id INT UNSIGNED NOT NULL,
  initials VARCHAR(10) NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  increment INT UNSIGNED NOT NULL,
  branch_name VARCHAR(255) NOT NULL,
  status ENUM('active', 'deleted') NOT NULL DEFAULT 'active',
  last_checked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  UNIQUE (repo_id, initials, co_number, increment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  branch_id INT UNSIGNED NOT NULL,
  status ENUM('awaiting_approval', 'queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 'awaiting_approval' added for the explicit human approval gate (see
-- sessionService.js's state-machine comment) - MODIFY COLUMN is idempotent,
-- safe to re-apply against an already-provisioned dev database exactly like
-- this schema's other additive statements.
ALTER TABLE sessions MODIFY COLUMN status ENUM('awaiting_approval', 'queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued';

CREATE TABLE IF NOT EXISTS session_requirements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  overlap_flag_requirement_id INT UNSIGNED NULL,
  resolution_status ENUM('pending_confirm', 'confirmed_proceed', 'confirmed_skip') NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (overlap_flag_requirement_id) REFERENCES session_requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  repo_id INT UNSIGNED NULL,
  co_number VARCHAR(20) NULL,
  raw_instructions TEXT NULL,
  qa_history TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (repo_id) REFERENCES repos(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 2: serializes the full pipeline (clone -> sandbox build/test -> push
-- -> Phase 5 delivery) one session at a time per (repo_id, co_number) - see
-- roadmap.md's "Lock scope: entire pipeline" decision. A row's existence IS
-- the lock: acquiring is an INSERT that relies on the UNIQUE constraint
-- below to fail when another session already holds it; releasing is a
-- DELETE. Phase 2 wires acquire-at-CO-resolution and release-on-failure;
-- release on a *successful* full-pipeline completion is wired by Phase 5
-- (see app/lib/pipeline/pipelineService.js), only after its combined commit
-- - code changes, the requirements-log update, and any regenerated spec doc
-- - has actually landed.
CREATE TABLE IF NOT EXISTS pipeline_locks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  locked_by_user_id INT UNSIGNED NOT NULL,
  locked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  FOREIGN KEY (locked_by_user_id) REFERENCES users(id),
  UNIQUE (repo_id, co_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 4: one row per worker pickup attempt of a queued session (see
-- worker.js and app/lib/pipeline/pipelineService.js). Deliberately a new,
-- separate table rather than new columns bolted onto `sessions` - matches
-- how normalized the rest of this schema already is (session_requirements,
-- conversations, and audit_log are all separate from sessions too), and
-- means this table needs no ALTER-based migration story: it's additive via
-- plain CREATE TABLE IF NOT EXISTS, safe to apply against an
-- already-provisioned dev database exactly like every other table here.
-- `log` holds the sandboxed build/test run's captured stdout/stderr (capped
-- and truncated before being written - see sandboxRunner.js); `commit_sha`
-- is set only on a successful push; `error_message` is set only on failure
-- (branch deleted, config invalid, codegen unparseable, build/test failed,
-- push failed after exhausting fetch-and-retry).
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED NOT NULL,
  status ENUM('running', 'completed', 'failed') NOT NULL DEFAULT 'running',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  log LONGTEXT NULL,
  commit_sha VARCHAR(64) NULL,
  error_message TEXT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 5: DEV-branch delivery. Records the CO-keyed Spec/Communication
-- Protocol document path (see app/lib/pipeline/deliveryPaths.js) ONLY when
-- this run's model judgment actually (re)generated one as part of its
-- combined commit - NULL is the common case (most sessions don't touch the
-- API surface; see app/lib/pipeline/specDocService.js). Not modeled as a new
-- table: it's one more fact about a run this table already tracks, sharing
-- the same row as commit_sha rather than needing its own join. Added via
-- `ADD COLUMN IF NOT EXISTS` (supported since MariaDB 10.0.2) rather than a
-- new table, keeping this additive and safe to re-apply against an
-- already-provisioned dev database, matching this schema's existing
-- CREATE-TABLE-IF-NOT-EXISTS discipline for a case where the table itself
-- already exists.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS spec_doc_path VARCHAR(500) NULL AFTER commit_sha;

-- Phase 6: access administration. `is_admin` gates the admin UI/API (see
-- app/lib/auth/requireAdmin.js) and is carried on the session alongside
-- `username`/`initials` (see app/lib/auth/localPasswordAuthProvider.js) so a
-- request doesn't need a fresh DB lookup to check it. Defaults to 0 so every
-- pre-Phase-6 user stays a non-admin until promoted by hand or via
-- `make seed-admin` (see scripts/seed-admin.js). Additive via
-- `ADD COLUMN IF NOT EXISTS`, same discipline as spec_doc_path above.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin TINYINT(1) NOT NULL DEFAULT 0;

-- Phase 6: append-only record of every admin mutation (permission
-- grant/revoke, initials edit), per roadmap.md's "itself audit-logged"
-- requirement for the Phase 6 admin UI. Deliberately a separate table from
-- `audit_log` rather than reusing it: `audit_log`'s shape
-- (raw_instructions/qa_history, repo_id/co_number) is specific to the AI
-- Q&A pipeline (Phases 3-5), and none of that fits an admin action - same
-- "separate, normalized table per concern" discipline session_requirements/
-- conversations/audit_log already follow relative to `sessions`.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_user_id INT UNSIGNED NOT NULL,
  action VARCHAR(50) NOT NULL,
  target_user_id INT UNSIGNED NULL,
  repo_group_id INT UNSIGNED NULL,
  detail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_user_id) REFERENCES users(id),
  FOREIGN KEY (target_user_id) REFERENCES users(id),
  FOREIGN KEY (repo_group_id) REFERENCES repo_groups(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 7: "blocked-allowlist attempt" alerting (see roadmap.md's Phase 7
-- bullet). A row is written when a GitHub write call - branch creation
-- (branchService.js's createBranchFrom) or the Phase 4/5 combined push
-- (commitService.js's commitAndPushChanges) - comes back HTTP 403. That's
-- the status GitHub surfaces both for an App-permission scope violation and
-- for the `dev/**` repository ruleset (see githubAppTokenProvider.js's file
-- comment) rejecting a ref outside the allowed pattern. A 422/409
-- non-fast-forward push is a routine, already-handled retry case
-- (commitService.js) and never reaches this table. Classifying "403 means
-- allowlist block" is a heuristic, not a GitHub guarantee about *why* the
-- 403 happened - see docs/human-judgment-reliance.md for why this project
-- treats that kind of judgment call as something to surface to a human
-- rather than something to resolve with more code.
CREATE TABLE IF NOT EXISTS blocked_allowlist_alerts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(20) NULL,
  branch_name VARCHAR(255) NOT NULL,
  session_id INT UNSIGNED NULL,
  operation VARCHAR(50) NOT NULL,
  http_status SMALLINT UNSIGNED NOT NULL,
  response_detail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 7: lock-contention observability, one row per genuine contention
-- event - a user's acquireLock() call (pipelineLock.js) found the
-- (repo_id, co_number) lock already held by a DIFFERENT user. Deliberately
-- excludes the "already mine" case coResolutionService.js already treats as
-- a non-conflict re-resolve (re-selecting a branch you just created in the
-- same in-flight run), so this table only ever reflects real contention
-- between two different users on the same CO, feeding the Phase 7
-- lock-contention dashboard on (repo, CO).
CREATE TABLE IF NOT EXISTS lock_contention_events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  requested_by_user_id INT UNSIGNED NOT NULL,
  held_by_user_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id),
  FOREIGN KEY (held_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delivery docs (requirements log, Spec/Communication Protocol doc) no longer ride
-- along in the Phase 4/5 combined commit to the customer's repo - see
-- app/lib/pipeline/documentsService.js. Apex now stores them itself: one row per
-- (repo, doc_type, co_number), browsable/downloadable from the Documents UI instead of
-- being pushed to GitHub. `co_number` uses `''` as a sentinel for repo-level docs (the
-- requirements log, one cumulative record per repo, not per CO) rather than NULL,
-- because MySQL's UNIQUE index treats every NULL as distinct from every other NULL -
-- an empty-string sentinel is a real value, so the UNIQUE constraint below actually
-- dedupes the repo-level case instead of silently allowing duplicate rows.
CREATE TABLE IF NOT EXISTS repo_documents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  doc_type VARCHAR(50) NOT NULL,
  co_number VARCHAR(20) NOT NULL DEFAULT '',
  content LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  UNIQUE (repo_id, doc_type, co_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
