# GitHub App private-key rotation

Phase 7 hardening item (see `roadmap.md`'s "Phase 7 — Observability &
hardening" bullet: "GitHub App key rotation process"). This is a written
runbook, not new code — the mechanics that make rotation safe (a
secrets-provider abstraction, and GitHub's own support for multiple valid
keys per App) already exist as of Phase 1; this document is what turns them
into a repeatable, low-risk procedure.

## Why this is safe to do with zero downtime

Two independent facts make key rotation a non-event for this app:

1. **GitHub allows more than one active private key per App.** Generating a
   new key does not invalidate the old one — both remain valid until you
   explicitly delete the old one from the App's settings page. This is the
   entire rotation mechanism: generate new, deploy new, verify new, *then*
   delete old. There is no window where the App has zero valid keys.
2. **The "env" secrets provider re-reads its source on every call.**
   `app/lib/secrets/envSecretsProvider.js` resolves `GITHUB_APP_PRIVATE_KEY`
   by reading `GITHUB_APP_PRIVATE_KEY_PATH` fresh on every
   `getSecret()` call (see `agent-prompts.md`'s "Secrets provider contract"
   section) — it does not cache the file's contents in memory at startup.
   If your `.pem` file is at a stable path, **overwriting that file in
   place picks up the new key without restarting the app or worker
   process.** (If you instead set `GITHUB_APP_PRIVATE_KEY` directly to a
   raw env var, that *is* read once at process start via `dotenv`, and does
   require a restart — using the `_PATH` file form is what makes the
   in-place swap possible.)

Neither of these is Phase-7-specific code — they're existing Phase 1
guarantees this runbook simply relies on rather than duplicates.

## Rotation procedure

1. **Generate a new private key.** GitHub org → Settings → Developer
   settings → GitHub Apps → (this App) → "Generate a private key". This
   downloads a new `.pem`; the old key remains valid.
2. **Stage the new key without touching production traffic.** Save the new
   `.pem` to a temporary path, distinct from the path
   `GITHUB_APP_PRIVATE_KEY_PATH` currently points at.
3. **Verify the new key mints a token before cutting over.** Point a local
   or staging `.env` at the new key's path and run:
   ```
   GITHUB_APP_PRIVATE_KEY_PATH=/path/to/new-key.pem make test-github-token
   ```
   **Success looks like** the same output `Phase1_test.md`'s Test 1
   describes (`Token minted OK. Masked token: ...  Expires at: ...`). This
   confirms the new key is well-formed and matches the App's registered
   public key before it's anywhere near production.
4. **Cut over.** Overwrite the file at the path `GITHUB_APP_PRIVATE_KEY_PATH`
   already points at (in every environment running the app or the worker)
   with the new key's contents. Because of the re-read-on-every-call
   behavior above, this takes effect on the very next token mint — no
   restart required. If your deployment instead sets the raw
   `GITHUB_APP_PRIVATE_KEY` env var, restart the app and worker processes
   after updating it.
5. **Confirm the live app is using the new key.** Run `make test-github-token`
   again against the real (now-updated) `.env` / secrets path, or watch for
   a normal `minted GitHub installation token` log line (see
   `githubAppTokenProvider.js`) on the next real pipeline run — a
   successful mint after step 4 confirms the cutover worked; the old key is
   no longer being read at all once the file/env var is overwritten.
6. **Only after step 5 succeeds, delete the old key** from the App's
   settings page. Deleting it while step 4/5 might still be relying on it
   would reintroduce exactly the outage rotation is meant to avoid — this
   ordering is the whole point of GitHub allowing multiple simultaneous
   keys.
7. **Securely delete the local copy of both the old and staged `.pem`
   files** once rotation is confirmed complete — neither should be
   retained outside the secrets store/path the running app reads from.

## When to rotate

- On a fixed schedule (recommended: no longer than annually, sooner if your
  org's key-rotation policy is stricter).
- Immediately, out of schedule, if a `.pem` file is suspected exposed
  (committed accidentally, present on a decommissioned host, etc.) — in
  that case, treat step 6 (deleting the old key) as urgent rather than a
  routine follow-up, since the compromised key stays valid until deleted.

## What this does not cover

- Rotating `GITHUB_APP_ID` or `GITHUB_APP_INSTALLATION_ID` — those aren't
  secrets and don't need rotation; this document is about the private key
  only.
- A non-"env" `SECRETS_PROVIDER` implementation (a real secrets manager).
  Whatever provider you swap in per `app/lib/secrets/secretsProvider.js`'s
  contract needs its own equivalent of step 4's "update in place, no
  restart needed" property re-verified — that's a property of the "env"
  provider's file-read behavior, not a guarantee the interface itself
  makes.
