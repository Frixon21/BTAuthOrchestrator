# TASK-014: Check local_login_audit table growth after testing

Owner role: Implementer
Assigned agent: TBD
Proposed by: Patrick Moon
Proposed date: 2026-09-15
Approved by:
Approved date:
Related contracts: CONTRACT-005 (local login and user management —
`local_login_audit` and `local_user_admin_audit` are this contract's tables;
CONTRACT-005 explicitly defers a retention policy to this task rather than
designing one speculatively); CONTRACT-009 (self-service password changes
do not write `local_login_audit` rows); CONTRACT-008 (Draft — container
deployment, data directory on a persistent host volume)
Related ADRs: ADR-003 (lists this task as the open retention follow-up)
Dependencies: CONTRACT-005 approved and implemented (done — TASK-015
through TASK-018 completed); a real period of testing activity against
`/auth/local-login` has actually occurred (believed met as of 2026-10-28 —
see Blocker)

## Desired outcome

A decision, backed by real data, on whether `local_login_audit` (and its
sibling `local_user_admin_audit`) needs a retention/cleanup policy — informed by its actual growth rate under real
testing load, not designed speculatively ahead of time.

## Context

CONTRACT-005 defines `local_login_audit` with no retention policy,
deliberately mirroring CONTRACT-003/CONTRACT-004's "never delete" stance on
their own audit tables — but those tables grow from rare events (an
emergency rotation, a key bootstrap), while `/auth/local-login` may be
called very frequently by automated test suites once local-login testing is
underway. Patrick asked (2026-09-15) for this to be picked up as its own
task once testing is far enough along to have produced a real growth
pattern, rather than have CONTRACT-005 guess at a policy now. Explicitly
low priority — do not pick this up until testing activity has actually
accumulated meaningful data.

Refreshed 2026-10-28. Nothing since filing has superseded this task:
TASK-018 recorded the retention question as still open, ADR-003 lists this
task as the follow-up, and TASK-027 (admin console) explicitly excluded any
audit change or audit viewer. Since filing:

- `local_user_admin_audit`, the second CONTRACT-005 audit table, is under
  the same "never delete" stance. It grows from admin actions and admin-API
  authentication failures rather than every login, so likely more slowly,
  but deciding both tables together is cheap.
- CONTRACT-009 (TASK-026) confirmed that self-service password-change
  attempts do not write `local_login_audit` rows, so they do not add to its
  growth.
- CONTRACT-008 (Draft) and TASK-025 (proposed) plan a container deployment
  with the PGlite data directory on a persistent host volume. Once deployed,
  unbounded audit growth consumes production host disk rather than only a
  developer's working copy, which raises the practical stakes of this
  decision.

## Scope

### Included

- Inspect `local_login_audit`'s and `local_user_admin_audit`'s actual row
  counts/growth rates after a real period of testing, read-only.
- Decide whether a retention policy (time-based deletion, row-count cap,
  archival, or "no policy needed, growth is negligible") is warranted.
- If a policy is warranted, propose it as a follow-up task or a CONTRACT-005
  supersession (per ADR-001, if it changes the contract's stated
  invariants).

### Excluded

- Any change to either table's schema itself unless a chosen policy
  requires one.
- Implementing any retention policy — that is a follow-up task.
- CONTRACT-003/CONTRACT-004's own audit tables — out of scope, not affected
  by this task.

## Plan

Not yet planned in detail — this is intentionally a placeholder until
enough real testing activity exists to plan against actual data rather than
guesses.

## Acceptance criteria

- [ ] Actual row-count/growth data for `local_login_audit` and
      `local_user_admin_audit` collected after a real period of testing.
- [ ] An explicit decision recorded for each table: retention policy needed
      (with a proposed shape) or not needed (with reasoning), taking the
      planned container deployment's persistent volume into account.

## Validation requirements

TBD, depends on the decision reached.

## Risks and assumptions

- Local development data may not represent production load; the growth
  rate observed in `data/` reflects test activity, not real users.
- CONTRACT-008 is still Draft; if container deployment changes shape, the
  disk-growth concern in Context should be revisited.

## Blocker

Likely cleared as of 2026-10-28. The original blocker was waiting on a
real period of `/auth/local-login` testing activity. Since filing, TASKs
015–018, 020–023, 026 and 027 have exercised local login through scripts,
the browser form and the admin console, and the local `data/` directory is
about 39 MB. Row counts have not yet been taken. Awaiting human approval to
proceed.

## Implementation handoff

Not started.

## Review

Not reviewed.
