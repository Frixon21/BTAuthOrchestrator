# TASK-026: Local password self-service change and admin reset form

Owner role: Implementation
Assigned agent:
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

- [ ] The self-service routes are live only when `LOCAL_LOGIN=true`; the
      reset page is served in both modes.
- [ ] A correct current password replaces the hash. The old password fails
      and the new one works, and no cookie is set.
- [ ] Wrong and unknown credentials return the merged `401` and leave the hash
      unchanged. Wrong passwords count toward the shared account lockout, and
      both count toward the endpoint's own IP throttle.
- [ ] A self-service change to the same password returns `400`; an admin
      reset to the same password succeeds.
- [ ] Locked and disabled accounts return `423` and `403` and are not changed.
- [ ] Validation failures return `415` or `400` with no lookup, hashing, or
      audit row.
- [ ] Audit rows match CONTRACT-009 §5 and never contain a password.
- [ ] The reset page resolves the username to an id and sends the correct
      `PATCH`. It renders errors as text and never stores the token.
- [ ] Sessions issued before a change remain valid.

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

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
