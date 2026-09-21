# Phase 6 manual testing

Phase 6 adds access administration: an admin UI/API for granting and
revoking `user_repo_group_permissions`, an admin UI/API for editing any
user's `initials`, and an `admin_audit_log` row for every one of those
mutations. See `roadmap.md`'s "Phase 6 — Access administration" section for
the scope this implements.

Before this phase, `Phase2_test.md` had you seed `orgs` / `repo_groups` /
`repos` / `user_repo_group_permissions` with raw SQL because there was no
admin UI yet. That gap is what this phase closes for the permissions/initials
pieces — you can still seed `orgs`/`repo_groups`/`repos` themselves by hand
(there's no admin UI for org/repo-group/repo creation, only for who has
access to an existing repo group and what their initials are).

**Testing is primarily done through the browser**, per this project's
established convention — log in as an admin, visit `/admin`, and drive the
same page a real admin would. curl is used only for the two things with no
UI path: confirming a non-admin gets a real 403 (not just a UI that hides
the link), and inspecting `admin_audit_log` rows directly.

## Prerequisites

1. Everything from `phase0.setup.md` through `Phase5_test.md` — a running
   app, `.env` configured, schema applied.
2. **No new `.env` variables**, except three that already existed in the env
   template since Phase 0 but were unused until now:
   `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_INITIALS`. Fill
   these in if they're blank (a password is required — pick anything that
   clears the 8-character minimum `auth.js` already enforces).
3. **Schema change: re-apply `db/schema.sql`.** Phase 6 adds one new,
   nullable-safe column (`users.is_admin`, `NOT NULL DEFAULT 0`) and one new
   table (`admin_audit_log`), both additive and safe to re-run against your
   existing dev database:
   ```
   make db-schema
   ```
4. Create (or promote) your admin user:
   ```
   make seed-admin
   ```
   This is idempotent — re-running it after the user already exists just
   re-promotes them, it never errors or duplicates the row.

## Seed a non-admin user and something to grant access to

If you don't already have one from earlier phases' testing, register a
second, ordinary user and seed an org/repo-group to grant them access to
(same raw-SQL step `Phase2_test.md` already walked you through, still
needed here since Phase 6 doesn't add an admin UI for creating orgs/repo
groups themselves — only for granting/revoking access to ones that already
exist):

```
curl -s -c jdoe.cookies.txt -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"jdoe","password":"correct-horse","initials":"JD"}'
```

```sql
INSERT INTO orgs (name) VALUES ('your-github-owner');
INSERT INTO repo_groups (org_id, name) VALUES (LAST_INSERT_ID(), 'Test Group');
```

## Test 1 — non-admin is blocked, both API and page

Log in as `jdoe` (a non-admin) and confirm both surfaces refuse them:

```
curl -s -b jdoe.cookies.txt http://localhost:3000/api/admin/users | json_pp
```

**Success looks like:** HTTP 403, `{"success":false,"message":"Admin access required",...}`.

Then visit `http://localhost:3000/admin` in the browser while logged in as
`jdoe`. **Success looks like:** an immediate redirect to `/repos`, not an
error page — `requireAdminPage` in `app/routes/pages.js` redirects rather
than rendering, same convention `requirePageAuth` already uses for
logged-out visitors.

Also confirm the header partial hides the link entirely for a non-admin:
open `/repos` as `jdoe` and check there's no "Admin" button next to "Log
out" (view source or inspect — `partials/header.ejs` only renders it when
`user.isAdmin` is true).

## Test 2 — admin UI: users list and initials edit

Log in as your `SEED_ADMIN_USERNAME` user and visit `/admin`. You should see
the "Admin" button in the header (Test 1's negative case, now positive), and
the page's Users table listing every registered user, with your seed admin
showing an **Admin** badge and `jdoe` showing none.

Edit `jdoe`'s initials in the table's input field and click **Save**.

**Success looks like:** a green "Initials updated." banner, and the row's
value persists after a page refresh. Confirm server-side:

```sql
SELECT username, initials FROM users WHERE username = 'jdoe';
SELECT action, target_user_id, detail FROM admin_audit_log ORDER BY id DESC LIMIT 1;
```

**Success looks like:** `jdoe`'s `initials` column reflects your edit, and
the latest `admin_audit_log` row has `action = 'update_initials'`,
`target_user_id` matching `jdoe`'s id, and `detail` naming the new value.

## Test 3 — admin UI: grant access

In the "Grant repo-group access" section, select `jdoe` and your seeded
"Test Group", then click **Grant**.

**Success looks like:** a green "Access granted." banner, and a new row
appears in the "Current access" table below showing `jdoe`, your org name,
and "Test Group". Confirm:

```sql
SELECT user_id, repo_group_id FROM user_repo_group_permissions
  WHERE user_id = (SELECT id FROM users WHERE username = 'jdoe');
SELECT action, target_user_id, repo_group_id FROM admin_audit_log ORDER BY id DESC LIMIT 1;
```

**Success looks like:** the permission row exists, and the latest audit row
has `action = 'grant_permission'` with matching `target_user_id` and
`repo_group_id`.

Log in as `jdoe` (a fresh session, separate cookie jar) and confirm the
grant actually took effect end to end — `GET /api/repos` should now list a
repo in "Test Group" if you seeded one under it, per `Phase2_test.md`'s
`repos` seeding step (Phase 6 doesn't add repo creation, so add a `repos`
row by hand if you haven't already).

## Test 4 — granting the same access twice is rejected, not silently duplicated

Repeat Test 3's grant (same `jdoe` / "Test Group" pair) without revoking
first.

**Success looks like:** a red error banner reading "User already has access
to this repo group," **not** a second row in the "Current access" table and
**not** a second `admin_audit_log` row — `user_repo_group_permissions`'
`UNIQUE (user_id, repo_group_id)` constraint (`db/schema.sql`) rejects the
INSERT before `adminService.grantPermission` ever gets to writing the audit
row, so a failed grant leaves no audit trace of an action that didn't
actually happen.

## Test 5 — admin UI: revoke access

Click **Revoke** on the row from Test 3.

**Success looks like:** a green "Access revoked." banner, and the row
disappears from the "Current access" table. Confirm:

```sql
SELECT * FROM user_repo_group_permissions
  WHERE user_id = (SELECT id FROM users WHERE username = 'jdoe');
SELECT action, target_user_id, repo_group_id FROM admin_audit_log ORDER BY id DESC LIMIT 1;
```

**Success looks like:** no permission row comes back at all, and the latest
audit row has `action = 'revoke_permission'` with the same
`target_user_id`/`repo_group_id` the now-deleted row had — `revokePermission`
reads those before deleting specifically so the audit trail still names what
was revoked after the row itself is gone.

Log back in as `jdoe` and confirm `GET /api/repos` no longer lists that
repo.

## Test 6 — `make seed-admin` is idempotent

Run `make seed-admin` a second time without changing `.env`.

**Success looks like:** exit code 0, console output reading
`User "<SEED_ADMIN_USERNAME>" already exists; promoting to admin.` followed
by `"<SEED_ADMIN_USERNAME>" is now an admin.` — no error, no duplicate user
row (`users.username` is `UNIQUE` per `db/schema.sql`, and
`scripts/seed-admin.js` catches exactly the `USERNAME_TAKEN` error
`AuthProvider.register()` throws for this case).

## Common errors

| Symptom | Likely cause |
|---|---|
| `Admin access required` (403) even though you just ran `make seed-admin` | Your browser session was created *before* you ran the seed script — `isAdmin` is set on the session at login time (`app/lib/auth/localPasswordAuthProvider.js`), not re-read from the DB per request. Log out and back in. |
| `/admin` redirects to `/repos` for a user you just promoted | Same cause as above — stale session. Log out/in to pick up the new `isAdmin` flag. |
| Grant fails with "User or repo group not found" | One of the two ids no longer exists — most likely the page was left open across a `db-drop`/reseed. Refresh `/admin` to repopulate the dropdowns from current data. |
| `ER_BAD_FIELD_ERROR` referencing `is_admin` on login/register | `make db-schema` wasn't re-run after pulling this phase's changes — `users.is_admin` doesn't exist yet on your database. |
| Initials save succeeds in the UI but doesn't change branch naming for that user's *next* branch | Not a bug — per roadmap.md's `users.initials` row, "if initials change, historical branch names do not retroactively update." Only future branch creations (`app/lib/branches/coResolutionService.js`) pick up the new value. |

## What this does and doesn't prove

This proves the `user_repo_group_permissions` and `users.initials` gaps that
every earlier phase's test doc explicitly called out as "no admin UI yet,
seed by hand" are now closed: an admin can grant/revoke access and edit
initials through a real UI/API, gated so a non-admin can reach neither the
page nor the underlying routes, and every mutation leaves a permanent,
append-only `admin_audit_log` row naming who did what to whom.

It does **not** add an admin UI for creating `orgs`/`repo_groups`/`repos`
themselves — those are still seeded by hand, same as every prior phase's
test doc did. It does not add any way to revoke admin status through the UI
(only `is_admin`'s `DEFAULT 0` plus direct SQL or `make seed-admin` can grant
it, and nothing in this phase removes it) — demoting an admin is an
accepted manual-SQL gap for this phase, not an oversight, mirroring how
`Phase2_test.md` already treated permission seeding before this phase
existed. It does not prove anything about Phase 7 (observability/hardening),
which remains entirely unbuilt.
