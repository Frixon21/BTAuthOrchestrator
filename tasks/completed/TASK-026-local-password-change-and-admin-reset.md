# TASK-026: Local password self-service change and admin reset form

Owner role: Implementation
Assigned agent: Codex
Proposed by: Patrick
Proposed date: 2026-10-27
Approved by: Patrick Moon
Approved date: 2026-10-27
Related contracts: CONTRACT-009 (partially supersedes CONTRACT-005),
CONTRACT-005, CONTRACT-006
Related ADRs: ADR-001, ADR-003
Dependencies: CONTRACT-009 approved; TASK-016, TASK-018, TASK-020

## Desired outcome

A local user can change their own password from a form by entering their
current password. An operator can reset any local user's password from a
browser form using `LOCAL_USER_ADMIN_TOKEN`. Existing sessions are not
affected by either.

## Context

Today a password can be changed only with `curl` against
`PATCH /admin/users/:id`. Patrick asked for a password change form and
discussed having another authenticated user do it. Because the service has no
user roles and never verifies its own `bt_session` cookie, he chose two
pieces instead (2026-10-27): a self-service change that requires the current
password, and an admin reset form built on the existing admin API. Session
invalidation is explicitly out of scope; emergency key rotation covers it.

## Scope

### Included

- `GET` and `POST /auth/local-change-password`, per CONTRACT-009 §1–§3.
- `GET /admin/reset-password`, per CONTRACT-009 §4.
- A "Change password" link on the local sign-in page.
- Self-service audit rows, per CONTRACT-009 §5.
- OpenAPI entries, `docs/DEVELOPMENT.md`, and README updates.
- After Patrick approves CONTRACT-009, the header-only `Superseded by` edit
  to CONTRACT-005.

### Excluded

- Session revocation, roles, session verification, email reset flows, and
  any other admin UI (CONTRACT-009 Excluded).
- Schema changes.
- Changes to the deployed `.env` or the running service.

## Plan

1. Factor the existing local-login verification (throttle, uniform-cost
   derivation, lockout and disabled outcomes) so that sign-in and
   change-password share one implementation instead of two copies.
2. Add the self-service handler, its form, and the sign-in link.
3. Add the static admin reset page.
4. Add tests in the style of `scripts/test-local-registration.js`.
5. Update the documentation and OpenAPI.

## Acceptance criteria

- [x] The self-service routes are live only when `LOCAL_LOGIN=true`; the
      reset page is served in both modes.
- [x] A correct current password replaces the hash. The old password fails
      and the new one works, and no cookie is set.
- [x] Wrong and unknown credentials return the merged `401` and leave the hash
      unchanged. Wrong passwords count toward the shared account lockout, and
      both count toward the endpoint's own IP throttle.
- [x] A self-service change to the same password returns `400`; an admin
      reset to the same password succeeds.
- [x] Locked and disabled accounts return `423` and `403` and are not changed.
- [x] Validation failures return `415` or `400` with no lookup, hashing, or
      audit row.
- [x] Audit rows match CONTRACT-009 §5 and never contain a password.
- [x] The reset page resolves the username to an id and sends the correct
      `PATCH`. It renders errors as text and never stores the token.
- [x] Sessions issued before a change remain valid.

## Validation requirements

`npm run build`, the new test script, the existing
`scripts/test-local-registration.js` and `scripts/test-api-docs.js`, and
`git diff --check`. The tests use an isolated temporary PGlite database and
the real request handler. The forms' inline scripts are run in a VM with DOM
and `fetch` stand-ins.

## Risks and assumptions

- The self-service endpoint is a second place where passwords can be
  guessed. The per-account lockout is shared with sign-in, but the IP
  throttle is separate, which doubles the per-IP budget. Patrick accepted
  this while testing (CONTRACT-009 resolved decision 1).
- The admin page asks the operator to type the admin token into a browser.
  Any script injection on this origin could read it, so both pages must
  render all dynamic text with `textContent`.
- CONTRACT-009's open questions were resolved by Patrick on 2026-10-27.

## Blocker

None. CONTRACT-009 was approved by Patrick on 2026-10-27.

## Implementation handoff

Task: TASK-026
Implementer: Codex
Date: 2026-10-27

### Changes made

Added gated GET/POST /auth/local-change-password with its own IP throttle,
JSON validation, shared full-cost credential verification and failure responses,
shared account lockout, fresh password hashing through the existing atomic user
update, and one best-effort self-service admin audit row per validated attempt.
Sign-in retains its prior response, cookie, audit and throttle behavior.
Added both minimal browser forms and the sign-in change-password link. The
ungated admin reset page wraps the existing authorized list/PATCH API only.
No schema, environment, deployed-service, or Git metadata changes were made.
Moved the task approved -> in-progress -> review using plain filesystem mv.

### Validation performed

All final commands exited 0:

- `npm run build`: TypeScript compilation passed.
- `node scripts/test-local-password-change.js`: all seven PASS groups passed
  against temporary PGlite and the real handler/full-cost password functions.
- `node scripts/test-local-registration.js`: all six PASS groups passed. Its
  injected database-failure scenario emitted the expected diagnostic log.
- `node scripts/test-api-docs.js`: docs routes/assets, HEAD, mode switches,
  authorization descriptions, secret exclusion and health regression passed.
- `git diff --check`: clean, no whitespace errors.

The new test passed both its initial run and the final run after adding an
exact audit-row count assertion and cleaning up the shared helper's formatting.

After review, at Patrick's request (2026-10-27), the test gaps in review
finding F2 were closed in `scripts/test-local-password-change.js`. The new
assertions cover:

- Locked and disabled accounts with the correct current password return 423
  and 403, and their state is unchanged.
- The success audit row has a null `failure_reason` and the exact
  `source_ip`.
- The 500 path writes one `unexpected_error` audit row with no password in it.
- The leak check includes the failed attempts' new password.
- The gated 404 response bodies match the generic unmatched-route body.

The expected audit-row count rose from 15 to 17. `npm run build`, the test
script and `git diff --check` all exited 0. No application code changed.

### Acceptance criteria evidence

The new script verifies both self-service routes' 404 gate, the static admin
page in both modes, OpenAPI gating, and uncached JSON/page responses. Validation
cases instrument lookup/hash/dummy-derivation functions to prove no calls and
assert no audit rows. Success proves fresh salt/hash, updated timestamp, cleared
lockout, normalized response, no cookie or login audit, and old/new password
behavior at real sign-in. A previously issued session verifies with a local
JWKS after the change.

Unknown/wrong bodies match; dummy/locked paths execute full-cost derivation.
Wrong attempts from both endpoints share lockout, including change-only lockout.
Locked/disabled attempts preserve account state and do not consume change IP
budget. Separate throttle tests run in both directions and verify rejection
before even consuming the request stream. Same-password admin resets succeed,
clear lockout and preserve disabled status. Audit checks cover the exact count,
all credential failure categories, actor, target, source, changed fields and
password exclusion. Injected errors verify generic 500 and best-effort audit
without leaking exception values.

Both actual inline scripts run in a VM with DOM/fetch stand-ins: mismatched
confirmation, request bodies, username normalization/id lookup, missing user,
optional actedBy omission, authorization headers, success clearing/hiding, API
errors including both 401 stages, text-only rendering, no token storage, and
absence of public links to the reset page.

### Assumptions and deviations

No behavioral contract deviations. Reused the existing 16 KiB login body limit
for self-service requests and the existing unknown-source-IP bucket convention.
Unexpected failures use the internal audit category `unexpected_error`; the
four specified credential failure categories are unchanged. New failure logging
omits exception values to keep password material out of logs. Tests instrument
password exports but delegate to the real full-cost implementations.

### Unresolved risks

No implementation blockers. Real-browser layout was not exercised; scripts
were validated in a VM, matching the required precedent. The accepted separate
IP budgets and continued validity of existing sessions remain as contracted.
Independent review and human acceptance are pending.

### Documentation updated

README.md, docs/DEVELOPMENT.md and src/openapi.ts describe both flows.
CONTRACT-005 has only its supersession header extended; its body and all of
CONTRACT-009 are unchanged.

## Review

Task: TASK-026
Reviewer: QualityAssurance (Claude)
Date: 2026-10-27
Outcome: Pass

### Contract and acceptance review

Reviewed against CONTRACT-009 (Approved, including resolved decisions 1-4)
and CONTRACT-005 §2, §3, §4, §6, §8 and §11. Uncommitted diff inspected:
`src/index.ts`, `src/openapi.ts`, `README.md`, `docs/DEVELOPMENT.md`, the
CONTRACT-005 header, and the untracked `scripts/test-local-password-change.js`.

- Sign-in regression: `verifyLocalCredentials` (src/index.ts:822) is a
  verbatim extraction. Lookup, uniform-cost scrypt (dummy salt for no row,
  full verify for locked and disabled rows), precedence, and
  `recordFailedPassword` (bad_password only) are unchanged.
  `recordSuccessfulLogin` stays mutually exclusive and in the same order
  before the audit write and throttle recording. Sign-in still records IP
  failures for every non-success outcome. Confirmed by a differential run (below).
- §1 gating: both self-service routes sit behind `config.localLogin` and fall
  through to the generic 404. The reset page is ungated, GET only, and sent
  with `Cache-Control: no-store`. Met.
- §2: separate `passwordChangeThrottle` with the same thresholds, checked
  before Content-Type and body parsing (src/index.ts:1029). The 415 and 400
  checks, including the same-password 400, happen before any lookup, hash or
  audit. Only unknown_username and bad_password feed the change throttle,
  matching the contract's failure table. Lockout is shared because it lives
  on the row. Success goes through `updateUser` with a fresh
  `hashPassword()`, which clears the lockout and sets `updated_at`. The
  response is `200 {"status":"password_changed",...}` with no Set-Cookie and
  `Cache-Control: no-store`. The 500 path is generic. Met.
- §3 form: confirmation is checked client-side only, the request goes through
  fetch, errors are rendered via textContent, and the success message is
  shown. The `/auth/local-login` link is always present. The sign-in page has
  the "Change password" link. Met.
- §4 reset page: the username is trimmed and lowercased before the
  `GET /admin/users` id lookup. "No such user." stops the flow. The PATCH
  sends `{password, actedBy?}` with a Bearer header to relative,
  same-origin `/admin/users*` URLs. Text-only rendering, no token
  persistence, not linked from the login, register or change pages. Met.
- §5 audit: one `update` row per validated, unthrottled attempt, with
  `actor_label='self-service'`. `changed_fields` is `password` or null. All
  four categories are present. No `local_login_audit` row is written.
  Unexpected errors use `unexpected_error`, which the handoff discloses. Met.
- Docs and OpenAPI match the contract.

### Validation reviewed or performed

All of the following were run by the reviewer:

- `npm run build`: exit 0.
- `node scripts/test-local-password-change.js`: exit 0, 7/7 PASS.
- `node scripts/test-local-registration.js`: exit 0, 6/6 PASS. The injected
  "private database failure" stack trace is expected.
- `node scripts/test-api-docs.js`: exit 0, PASS.
- `git diff --check`: exit 0, clean.
- Differential sign-in probe (scratchpad `signin-diff.js`). It builds `HEAD`
  via `git archive` into the scratchpad and runs about 20 identical sign-in
  scenarios against the HEAD and working-tree builds on isolated temp
  PGlite. Scenarios covered 400s, unknown and wrong passwords, normalization,
  lock at threshold, locked with correct and wrong passwords, no lock
  extension, disabled with correct and wrong passwords, expired-lock success,
  IP throttle fed by locked and disabled attempts, 429 before parse, audit
  rows, and the four 500 and best-effort paths. The only transcript
  differences were the new "Change password" link and a log timestamp.
- Change-password probe (scratchpad `change-probe.js`):
  - Locked account with the correct current password: 423, hash unchanged.
  - Disabled account with the correct current password: 403, hash unchanged.
  - `updateUser` throwing (message containing the new password): generic
    500, a log line without the secret, and an audit row
    `failure/unexpected_error/self-service`.
  - The concurrency and unknown-username results are in findings F1, F3
    and F4.

### Findings

No blocking or major findings.

F1 (minor): concurrent disable or lock during a change is not re-checked.
- Location: src/index.ts:1069 (`updateUser` after `verifyLocalCredentials`).
- Evidence (confirmed by probe): the account was disabled after the
  verification read and before the write. The response was 200 and the hash
  changed while `is_active=false`. The write does not depend on the
  `is_active`, `locked_until` or hash state that was read.
- Affected requirement: the CONTRACT-009 rule that a disabled account is not
  changed, under concurrency. Sign-in has the same check-then-act pattern, so
  this is not a regression. The account is not re-enabled.
- Expected: a narrow race; low impact.
- Resolution: optionally make the update conditional on the verified state,
  or accept the race as residual risk.

F2 (minor): partial test-assertion gaps. Every CONTRACT-009 validation
bullet is asserted at least in part. No bullet is entirely unasserted.
- Locked and disabled cases are tested only with a wrong current password
  (scripts/test-local-password-change.js:122-130). Locked or disabled with a
  correct current password is not asserted. Behavior is correct per probe.
- The success audit row's `failure_reason IS NULL` is not asserted, and
  `source_ip` is only checked as truthy (line 158).
- The audit row written on the 500 path is not asserted (lines 170-172).
- The password-exclusion check omits the failed attempts' `newPassword`
  value, `another-password-789` (line 165).
- The 404 gating checks status only, not that the body matches the generic
  404 (line 62).
- Resolution: optionally add these assertions.

F3 (recommendation): parallel requests overshoot the IP throttle.
- Location: src/index.ts:1029 and 1066.
- Evidence (confirmed by probe): 6 parallel unknown-user requests with a
  throttle of 2 all returned 401. The check runs before scrypt, and the
  failure is recorded after it.
- Sign-in has the same existing design (src/index.ts:925 and 971), so this
  is not a regression.
- Resolution: track as residual risk.

F4 (recommendation): unknown-username audit rows store the raw submitted
username.
- Location: src/index.ts:1063.
- Evidence (confirmed by probe): an 8,000-character padded username was
  stored verbatim. Sign-in audits the normalized name.
- This conforms to the contract ("the submitted username").
- Resolution: consider storing the normalized or truncated value.

F5 (recommendation): the unexpected-error log carries no diagnostic detail.
- Location: src/index.ts:1075-1077.
- The log line contains no error class or code. This is safe but hard to
  diagnose. The `unexpected_error` category is outside the four named
  categories, which the handoff discloses.
- Resolution: optionally log a non-sensitive error class or code.

F6 (recommendation): minimum-length literal is hard-coded.
- Location: src/index.ts:1050.
- The literal `12` duplicates `ADMIN_MIN_PASSWORD_LENGTH`.
- Resolution: reuse the constant.

F7 (recommendation): reset-page autocomplete hints.
- Location: the `ADMIN_RESET_PASSWORD_FORM_HTML` username and new-password
  inputs.
- `autocomplete="username"` and `autocomplete="new-password"` may prompt the
  operator's password manager to save the target user's new credentials.
- Resolution: consider `autocomplete="off"`.

### Regression and security assessment

- Sign-in regression: confirmed unchanged by the differential run.
- Timing: change-password runs a full-cost derivation for every outcome.
  Only success adds a second scrypt for the new hash, and success is visible
  anyway.
- Secret exposure:
  - No password or token reaches responses, audit rows or logs; the probes
    confirmed this.
  - The new failure logs omit exception values.
  - Both inline scripts use only textContent; the VM test confirmed this
    with an `<img onerror>` payload.
  - The admin token is sent only to relative `/admin/users*` URLs and is
    never stored.
- Residual risks:
  - Doubled per-IP budget (accepted in resolved decision 1).
  - Sessions remain valid after a change (accepted).
  - F1 and F3 races.
  - The reset page has no framing or CSP headers. This is consistent with
    the existing pages and not required by the contract.

### Recommendations

Accept. F1-F7 are optional follow-ups. Recommended transition: the human
moves the task from review/ to completed/.

### Human decisions required

None required. For awareness: `/admin/reset-password` appears in the public
`/api/docs` OpenAPI document. The contract's Interfaces section requires the
OpenAPI document to describe it, and this is not a hyperlink from a public
page, so it is not treated as a defect.
