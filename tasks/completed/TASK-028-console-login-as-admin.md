# TASK-028: Admin console login for active local users

Owner role: Contract designer, then Implementation (interface-designer for
the console UI)
Assigned agent: Claude (contract drafting and implementation)
Proposed by: Patrick Moon
Proposed date: 2026-10-28
Approved by: Patrick Moon
Approved date: 2026-10-28
Related contracts: CONTRACT-001 (`bt_session`), CONTRACT-005 (local login,
admin API authorization), CONTRACT-006 (public registration switch),
CONTRACT-010 (admin console); CONTRACT-011 (Proposed, drafted for this
task) supersedes the affected parts per ADR-001
Related ADRs: ADR-001, ADR-003
Dependencies: none

## Desired outcome

An operator can sign in to `/admin/console` with a local username and
password and manage local users without pasting `LOCAL_USER_ADMIN_TOKEN`.
The bearer tokens keep working exactly as today and remain the last-resort
path for every admin action.

## Context

Tokens in the console live in `sessionStorage` (CONTRACT-010 §2), so they
are lost when the tab closes. Patrick confirmed (2026-10-28) that this stays
as it is: the tokens are the break-glass path. Instead, the console gains a
login option. Patrick's decisions (2026-10-28):

- **Who:** any active local user (`local_users.is_active = true`) who signs
  in is treated as an admin, for now. Entra users get no admin rights.
- **Credential:** reuse `bt_session`. Signing in through the console uses
  the existing `/auth/local-login` behavior and its cookie; no separate
  console session.
- **Registration guard:** cookie-based admin authorization is refused
  whenever `ALLOW_NEW_LOCAL_LOGIN_CREATION=true`. Otherwise anyone could
  self-register and become an admin. With registration on, only the tokens
  work.
- **Actions:** a signed-in user may perform user management only (list,
  create, edit, admin password reset, delete). Emergency signing-key
  rotation stays token-only (`EMERGENCY_ROTATION_TOKEN`).

Facts the contract must account for:

- `bt_session` is a JWT cookie with `Domain=.biztechro.com`,
  `SameSite=Lax`, shared by every consuming app and valid until local
  midnight. Its `sub` is `local_users.id` for local sign-ins and the Entra
  object id for Entra sign-ins. The token itself does not say which.
- Because every `*.biztechro.com` site is same-site, `SameSite=Lax` does
  not stop a request forged from another subdomain. Cookie-authorized admin
  requests need their own CSRF defense.
- A user disabled or deleted after signing in still holds a valid
  `bt_session` until midnight.

## Scope

### Included

- A new contract superseding the relevant parts of CONTRACT-005 (admin API
  authorization) and CONTRACT-010 (console sign-in), defining at least:
  - the admin user-management routes accept either the bearer token (as
    today) or a valid `bt_session`;
  - cookie authorization requires that the token verifies against the
    service's own signing keys and issuer, that its `sub` matches a
    `local_users` row with `is_active = true` at request time (so disabled
    and deleted users lose access immediately), and that
    `ALLOW_NEW_LOCAL_LOGIN_CREATION` is not `true`;
  - a CSRF defense for cookie-authorized requests (for example, a required
    custom header and an `Origin` check), chosen by the contract;
  - which routes ignore the cookie: `POST /admin/emergency-rotate-keys`
    always requires its token;
  - what a bearer token does when a cookie is also present;
  - audit attribution for cookie-authorized actions in
    `local_user_admin_audit` (the signed-in user's id/username instead of
    the unverified `actedBy`);
  - console behavior: a sign-in form, the signed-in state, sign-out, and
    how the console explains that login is unavailable while registration
    is on.
- Implementation of that contract in the server and the console.
- Tests covering the cases below, and updates to `docs/DEVELOPMENT.md`,
  `README.md` and `src/openapi.ts`.

### Excluded

- Changing token storage (stays `sessionStorage`).
- Roles or per-user admin flags. "Every active local user is an admin" is
  an explicit interim rule; a role model is future work.
- Admin rights for Entra users.
- Changes to `bt_session`'s format, lifetime, domain or `SameSite` value.
- Cookie access to emergency key rotation.

## Plan

1. Contract designer drafts the new contract; Patrick approves it.
2. Server: cookie authorization path on the user-management routes, the
   registration guard, CSRF check, audit attribution.
3. Console: sign-in form, signed-in state, sign-out, token fallback.
4. Tests and docs.

## Acceptance criteria

- [ ] An approved contract supersedes the affected parts of CONTRACT-005
      and CONTRACT-010.
- [ ] An active local user can sign in on the console and manage users with
      no token entered.
- [ ] With `ALLOW_NEW_LOCAL_LOGIN_CREATION=true`, a valid `bt_session` grants
      no admin access and the console says why; tokens still work.
- [ ] A `bt_session` for a disabled or deleted user, or for an Entra user,
      grants no admin access.
- [ ] A cookie-authorized request that fails the CSRF check is refused.
- [ ] Emergency key rotation still requires `EMERGENCY_ROTATION_TOKEN`; a
      `bt_session` alone is refused.
- [ ] Token-only use of the console and API behaves exactly as before.
- [ ] Cookie-authorized actions are audited with the signed-in user's
      identity.

## Validation requirements

Extend `scripts/test-admin-console.js` and the admin API tests to cover
every acceptance criterion, including forged cross-origin requests and a
user disabled mid-session. Rerun the existing local-login, registration and
password-change tests unchanged.

## Risks and assumptions

- **Any active local user is an admin.** If local users are ever created for
  people who should not manage users, this rule gives them that power. It is
  accepted as interim and must be revisited before that happens.
- **`bt_session` is shared across every `*.biztechro.com` app.** Any of those
  apps, or a script injected into one, that can make a user's browser send
  requests carries that user's admin rights to this service. The CSRF
  defense limits this but is the critical control.
- **The registration switch is now a security control.** Turning
  `ALLOW_NEW_LOCAL_LOGIN_CREATION` on silently disables console login.
- **Network exposure.** Once TASK-025 publishes the service through Caddy,
  this login is reachable from wherever the dedicated IP is. See TASK-025's
  open question on restricting `/admin/*` at Caddy.

## Blocker

None.

## Implementation handoff

Completed 2026-10-28 against CONTRACT-011 (signed by Patrick 2026-10-28).

### Changes

- `src/index.ts`: `authorizeAdminRequest` implements §1 (token precedence,
  rules 1-7, failure reasons), `resolveSessionUser` verifies `bt_session`
  with `jose.jwtVerify` against current and retired keys, and the
  `/admin/users*` handlers use it. `POST /admin/users` follows §7.
  `GET /admin/session` (§2) and `POST /auth/logout` (§4) added.
- `src/localUsers.ts`, `src/database.ts`: `auth_method` and `actor_user_id`
  on `local_user_admin_audit`, added by an idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at startup (§6).
- `src/console/index.html`, `src/console/app.js`: sign-in panel in Settings,
  quick sign-in on the Users prompt, signed-in chip, sign-out, unavailable and
  cookie-not-kept messages, session-first credential choice, console header,
  session `401` handling, acting-as label hidden while signed in (§5).
- `src/openapi.ts`: `ConsoleSession` scheme, the two new paths, updated
  creation and console descriptions.
- Docs: `docs/DEVELOPMENT.md` (new "Console sign-in" section, updated admin
  API, console and API docs text), `README.md`.
- Contract headers: `Superseded by` notes on CONTRACT-005, CONTRACT-006 and
  CONTRACT-010 per ADR-001 (header only).
- Tests: new `scripts/test-console-sign-in.js`; updated
  `scripts/test-admin-console.js`, `scripts/test-local-registration.js` and
  `scripts/test-api-docs.js` for the §7 change and the new UI.

### Validation

`npm run build`, then all five test scripts pass:
`test-console-sign-in.js`, `test-admin-console.js`, `test-api-docs.js`,
`test-local-password-change.js`, `test-local-registration.js`. The new
script covers every case in the contract's Validation requirements,
including each §1 rule failing alone, retired versus revoked keys, mid-session
disable and delete, precedence, rotation refusing the cookie, every
`/admin/session` combination, logout headers, creation in both registration
states, the migration on a pre-existing audit table, and that tokens never
reach audit rows.

Not done:
- **Manual browser check** (sign-in, sign-out and user management at a
  `*.biztechro.com` host via a hosts-file entry, and the cookie-not-kept
  message at `localhost`). Needs Patrick or a reviewer with a browser.
- `npm run verify-offline` was not run; it needs a seeded `.env` deployment
  and this change does not touch token minting or JWKS.

### Implementation judgment calls

1. **Check order.** No cookie and no `Authorization` header is
   `bad_credential` first. Then rules 1, 2 and 7 (no I/O), then the cookie
   count (rule 3), then verification and the user lookup (rules 4-6).
2. **`auth_method` on failures.** A failed token gets `'token'`; a request
   with no credential gets `NULL`; session failures get `'session'`.
3. **Store failures** while checking a session return `500` with no audit
   row, matching the contract's Failure behavior, and are logged.
4. **Unparseable `SERVICE_ISSUER`.** It is not validated as a URL at
   startup, so the origin check fails closed whenever an `Origin` header is
   present, rather than crashing.
5. **Acting-as label while signed in** is not sent anywhere, including as
   `triggeredBy` on emergency rotation, following §5 literally. Rotation by a
   signed-in operator therefore records no label unless they sign out first.
6. **Self-service password changes** keep `auth_method = NULL`; CONTRACT-011
   names no value for them.
7. **`/admin/session` with two `bt_session` cookies** reports
   `signedIn: false`, consistent with rule 3.

## Review

Not reviewed.
