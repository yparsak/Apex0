# Phase 7 manual testing

Phase 7 adds observability and hardening on top of Phase 6's access
administration: a "blocked-allowlist attempt" alert trail, a lock-contention
dashboard on `(repo, CO)`, a GitHub App key-rotation runbook
(`docs/github-app-key-rotation.md`), and a written internal note on the
human-judgment-reliance philosophy running through every earlier phase
(`docs/human-judgment-reliance.md`). See `roadmap.md`'s "Phase 7 —
Observability & hardening" section for the scope this implements.

Branch-deletion detection is **not** revisited here — Phase 7 explicitly
declines to build anything new for it (the inline checks from Phase 2 and
Phase 4 already cover it; see `roadmap.md`). There is nothing to test for
that item beyond what `Phase2_test.md` and `Phase4_test.md` already cover.

## Prerequisites

1. Everything from `phase0.setup.md` through `Phase6_test.md` — a running
   app, `.env` configured, schema applied, an admin user seeded via
   `make seed-admin`.
2. **Schema change: re-apply `db/schema.sql`.** Phase 7 adds two new,
   additive tables (`blocked_allowlist_alerts`, `lock_contention_events`) —
   safe to re-run against your existing dev database:
   ```
   make db-schema
   ```
3. No new `.env` variables.
4. Two ordinary (non-admin) users with access to the same repo, so Test 2
   below can generate real lock contention. If you don't already have a
   second user from earlier phases' testing:
   ```
   curl -s -c user2.cookies.txt -X POST http://localhost:3000/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"username":"user2","password":"correct-horse","initials":"U2"}'
   ```
   Then grant both `jdoe` (or your existing second user) and `user2` access
   to the same repo group via `/admin`'s "Grant repo-group access" section
   (Phase 6), or repeat `Phase2_test.md`'s raw-SQL grant for both.

## Test 1 — blocked-allowlist alert: recorded and surfaced

Triggering a *real* GitHub 403 requires a misconfigured or deliberately
restrictive `dev/**` ruleset on an actual GitHub repo (see
`Phase1_test.md`'s note on setting one up) — not something every dev
environment has. Since `app/lib/alerts/alertService.js` is a thin,
independently-testable persistence + query layer (see its file comment),
this test exercises the same path an app-level 403 would exercise, without
requiring a live ruleset violation.

Insert a row directly, matching what `recordBlockedAllowlistAttempt` writes:

```sql
INSERT INTO blocked_allowlist_alerts (repo_id, co_number, branch_name, operation, http_status, response_detail)
VALUES (1, 'C12345678', 'dev/JD-C12345678-1', 'push', 403, 'Simulated: Changes must be made through a pull request.');
```

Replace `repo_id` with a real id from your `repos` table if `1` isn't valid.

Log in as your admin user and visit `/admin`. **Success looks like:** a
"Blocked-allowlist alerts" table showing the row you just inserted — repo
name (joined from `repos`), CO number, branch name, operation (`push`),
HTTP status (`403`), and a timestamp. Confirm the API directly too:

```sql
SELECT * FROM blocked_allowlist_alerts ORDER BY id DESC LIMIT 1;
```

```
curl -s -b admin.cookies.txt http://localhost:3000/api/admin/alerts | json_pp
```

**Success looks like:** the same row appears in the JSON response under
`alerts`, and a non-admin (`jdoe`) gets a 403 from the same endpoint —
these routes sit behind the same router-wide `requireAuth`/`requireAdmin`
as every other `/api/admin/*` route from Phase 6.

### Optional — trigger a real one end-to-end

If you have admin access to a test GitHub org, you can exercise the actual
code path (`app/lib/branches/coResolutionService.js`'s `createNextBranch`,
or `app/lib/pipeline/pipelineService.js`'s push step) rather than simulating
it: configure a repository ruleset that restricts `dev/**` pushes to a
*different* App installation than the one this app's `.env` points at, then
attempt to create a branch or let a pipeline run push. **Success looks
like:** the operation fails with a 403 exactly as it would have before
Phase 7, *and* a row appears in `blocked_allowlist_alerts` with the real
GitHub response body in `response_detail` — Phase 7 adds observability, it
does not change what happens on failure (see
`app/lib/pipeline/pipelineService.js`'s and `coResolutionService.js`'s
comments: the original error is always rethrown unchanged).

## Test 2 — lock contention: a real conflict, end to end

This one doesn't need any simulation — it exercises the actual
`(repo_id, co_number)` lock from Phase 2.

1. As **user1** (or `jdoe`), pick a repo you both have access to and start
   resolving a CO — e.g. via the branches UI, or directly:
   ```
   curl -s -b jdoe.cookies.txt -X POST http://localhost:3000/api/repos/<repoId>/resolve \
     -H 'Content-Type: application/json' \
     -d '{"coNumber":"C99999999","action":"create"}'
   ```
   **Success looks like:** `200`, a newly created `dev/JD-C99999999-1`
   branch, and the pipeline lock for `(repoId, C99999999)` now held by
   `jdoe` (per `roadmap.md`'s "Lock scope: entire pipeline" decision, this
   lock stays held until Phase 5 delivery completes or the run fails — see
   `app/lib/locks/pipelineLock.js`'s file comment).
2. Before that session completes (check `/repos` for `jdoe`'s session
   status if you want to confirm it's still `queued`/`running`), as
   **user2**, attempt to resolve the *same* CO on the *same* repo:
   ```
   curl -s -b user2.cookies.txt -X POST http://localhost:3000/api/repos/<repoId>/resolve \
     -H 'Content-Type: application/json' \
     -d '{"coNumber":"C99999999","action":"create"}'
   ```
   **Success looks like:** HTTP `409`,
   `{"success":false,"message":"Pipeline lock already held for repo <repoId>, CO C99999999","code":"LOCK_HELD",...}`
   — unchanged from Phase 2's existing behavior; Phase 7 does not touch
   what the requester sees.
3. Confirm the contention event was recorded:
   ```sql
   SELECT repo_id, co_number, requested_by_user_id, held_by_user_id FROM lock_contention_events ORDER BY id DESC LIMIT 1;
   ```
   **Success looks like:** one row with `held_by_user_id` matching `jdoe`'s
   user id and `requested_by_user_id` matching `user2`'s.
4. Visit `/admin` as your admin user. **Success looks like:** the "Currently
   held" table lists `(repo, C99999999)` held by `jdoe`, and the
   "Most-contended COs" table shows that pair with a contention count of at
   least 1.

## Test 3 — re-resolving your own lock is not contention

Repeat step 1's exact request as `jdoe` again (same CO, same repo, still
mid-pipeline). **Success looks like:** `200`, not `409` — this is the
existing "already mine" path `coResolutionService.js` has had since Phase 2
(re-selecting a branch you just created before a `sessions` row exists).
Confirm no new row was added:

```sql
SELECT COUNT(*) FROM lock_contention_events WHERE requested_by_user_id = (SELECT id FROM users WHERE username = 'jdoe');
```

**Success looks like:** the count is unchanged from before this test —
`recordContentionIfDifferentHolder` (`app/lib/locks/pipelineLock.js`) skips
recording whenever the requester and the current holder are the same user,
so re-resolving your own in-flight work never shows up as contention on the
dashboard.

## Test 4 — non-admin still blocked from all three new endpoints

```
curl -s -b jdoe.cookies.txt http://localhost:3000/api/admin/alerts | json_pp
curl -s -b jdoe.cookies.txt http://localhost:3000/api/admin/lock-contention | json_pp
curl -s -b jdoe.cookies.txt http://localhost:3000/api/admin/locks | json_pp
```

**Success looks like:** HTTP `403` on all three, same
`{"success":false,"message":"Admin access required",...}` shape Phase 6
established — these routes are added to the same router that already
applies `requireAuth`/`requireAdmin` ahead of every `/api/admin/*` route
(`app/routes/admin.js`), so no new gating logic was needed.

## Common errors

| Symptom | Likely cause |
|---|---|
| `ER_NO_SUCH_TABLE` referencing `blocked_allowlist_alerts` or `lock_contention_events` | `make db-schema` wasn't re-run after pulling Phase 7's changes. |
| Test 2's step 2 returns `200` instead of `409` | `jdoe`'s pipeline from step 1 already completed (or failed) before you ran step 2 — the lock only lives as long as the pipeline is in flight. Re-run step 1 with a fresh CO number and move to step 2 faster, or check `sessions.status` for `jdoe`'s session first. |
| Admin page's new sections stay on "Loading…" forever | Check the browser console / Network tab for a failed `/api/admin/alerts`, `/lock-contention`, or `/locks` call — `admin.js`'s `loadAll()` runs all six loaders via `Promise.all`, so one failing load doesn't block the others from rendering, but each section's own request still needs to succeed independently. |
| Test 1's simulated row doesn't show a repo name | The `repo_id` you inserted doesn't match a row in `repos` — `listBlockedAllowlistAttempts`'s query INNER JOINs on `repos`, so a bad `repo_id` hides the row entirely rather than showing it with a blank name. Use a real id from `SELECT id, name FROM repos`. |

## What this does and doesn't prove

This proves that a GitHub write call blocked by the `dev/**` allowlist
ruleset (or an App-permission scope issue surfacing the same 403) leaves a
durable, admin-visible record instead of only a log line; that genuine lock
contention between two different users is now visible both as a live
"currently held" view and as historical counts per `(repo, CO)`; and that
none of this changes what either the submitting user or the pipeline itself
experiences on failure — Phase 7 adds visibility, not new behavior.

It does **not** add real-time alerting (email/Slack/pager) for either
signal — consistent with this project's existing "surface it in the UI the
user next looks at, no separate notification channel" pattern from Phase 2
(session-completion status). It does not add a way to resolve or dismiss an
alert or contention row from the UI — both are simple append-only tables,
same as `audit_log` and `admin_audit_log` before them. It does not
automate GitHub App key rotation — `docs/github-app-key-rotation.md` is a
runbook for a human to follow, not a script, since the actual key-generation
step only exists on GitHub's own settings UI. And it does not add anything
new for branch-deletion detection, since Phase 7 explicitly reconfirms the
existing inline checks rather than replacing them.
