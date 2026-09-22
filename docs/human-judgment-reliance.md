# On relying on human judgment, by design

Phase 7 hardening item (see `roadmap.md`'s "Phase 7 — Observability &
hardening" bullet: "Written internal note on the human-judgment-reliance
philosophy ... so it's on record rather than discovered later"). This
document doesn't introduce a new decision — every item below is already a
confirmed decision or accepted risk in `roadmap.md`. Its job is narrower:
state the *pattern* those decisions share explicitly, once, in one place,
so it reads as a deliberate design philosophy rather than something a
future reader has to reconstruct by noticing it repeat six times.

## The pattern

At every point in this system where a judgment call is ambiguous, hard to
verify automatically, or expensive to get wrong, the design's answer is the
same: **surface it to a human and wait, rather than have the system decide
for itself.** This is not indecision or unfinished scope — it's a
consistent, intentional boundary about what this tool is and isn't trusted
to resolve on its own. Concretely, across the phases already built:

- **CO validity** (`roadmap.md` Accepted Risk #1). Format is validated
  (`^C[0-9]{8}$`); whether the CO is *real* and *currently open* in the
  actual change-control/QMS system is not checked by this app at all. A
  human reviewing at DEV, TEST, and PR is the actual control, not a
  regex.
- **Branch reuse** (Accepted Risk #2). The app shows metadata (last
  touched, which users hold active branches for a CO); it does not know
  whether a CO has already shipped, and does not attempt to infer that.
  The choice to continue an existing branch or start a new one is left
  entirely to the person making it, with the UI's only obligation being to
  make the existing options visible enough that the choice is informed
  (see the "Active-branch list" decision row in `roadmap.md`).
- **Spec-doc staleness** (Accepted Risk #3) and **requirements-log /
  spec-doc drift** (Accepted Risk #6). Both documents can silently fall out
  of sync with the branch if someone edits it outside an AI session.
  Nothing in this system detects that — it's an accepted gap, not a bug,
  because closing it would mean either policing how engineers touch their
  own DEV branches (out of scope) or building drift-detection
  infrastructure disproportionate to the risk.
- **Branch-deletion detection** (Accepted Risk #5, and the Phase 7 bullet
  that explicitly declines to build anything new here). Existence is
  checked on-demand at two points — branch-list render and session start —
  not via a standing webhook or poll. The tradeoff is a bounded staleness
  window that self-corrects the next time anyone looks, in exchange for not
  running always-on infrastructure for a low-frequency event. Phase 7
  reconfirms this rather than "upgrading" it, because usage hasn't shown
  the staleness window causing real collisions.
- **Duplicate/overlap detection between users' sessions** (Confirmed
  decision + Accepted Risk #8). This is explicitly an LLM semantic
  judgment, not a deterministic match, and the design's own documentation
  says outright that it "can misjudge in both directions." The mitigation
  is not a better algorithm — it's that the session **pauses** and requires
  the submitting user to confirm or override before anything proceeds. A
  wrong LLM judgment gets caught by a human at exactly the point the
  system's confidence is lowest, rather than silently executed either way.
- **Parallel per-user branches on the same CO** (Confirmed decision +
  Accepted Risk #7). Two users can each hold a `-1` branch for the same CO,
  by design. Whether to coordinate on one branch or work in parallel and
  reconcile later at TEST/PR is left as a human decision entirely outside
  this tool — the system's only job is to make sure that choice is visible,
  not to make it.
- **Blocked-allowlist attempts** (Phase 7, this project's newest instance
  of the same pattern — see `db/schema.sql`'s `blocked_allowlist_alerts`
  comment and `app/lib/alerts/alertService.js`). Classifying an HTTP 403
  from a GitHub write call as "the `dev/**` ruleset probably blocked this"
  is a heuristic, not something GitHub's API confirms directly. Rather than
  have the pipeline guess further (retry differently, attempt a workaround,
  silently downgrade the operation), it records the event and surfaces it
  to an admin via the Phase 7 dashboard. The judgment about *why* it
  happened, and what to do about it, stays with a person.

## Why this is the right boundary, not a shortcut

The alternative to each of these — building more automated certainty into
the system — would either require integrating with systems outside this
tool's scope (the real change-control/QMS system, for CO validity), require
inferring intent the system has no reliable signal for (semantic duplicate
detection is already the *best-effort* version of this), or trade a rare,
self-correcting inconsistency for always-on infrastructure whose
maintenance cost outweighs the problem it solves (deletion polling).
`roadmap.md`'s "Regulatory context" section makes the sharper version of
this same point: because the AI's output stops at a DEV branch, and every
regulated-adjacent action downstream (review, TEST, PR, merge) is already
human-driven, the AI sitting outside that approval chain is *why* several
of the harder compliance questions don't apply to this tool directly. That
property depends on the AI continuing to stop short of resolving these
judgment calls itself — if a future phase ever expands the AI's authority
(e.g., PR creation or merge), every item in this document needs to be
revisited with QA/RA before that expansion ships, exactly as Accepted Risk
#4 already flags for the audit log specifically.

## What this note is not

This is not a compliance sign-off, and does not substitute for the QA/RA
review `roadmap.md`'s "Regulatory context" section says explicitly has not
happened via that document either. It's the internal record Phase 7 asks
for: a statement, in one place, that every instance of "the system doesn't
resolve this automatically" above was a decision, not an oversight.
