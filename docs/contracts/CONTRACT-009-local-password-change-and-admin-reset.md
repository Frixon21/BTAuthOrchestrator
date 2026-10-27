# CONTRACT-009: Local password self-service change and admin reset form

Status: Approved
Approved by: Patrick
Approved date: 2026-10-27
Approval note: The resolved decisions were lost to an editor save before
approval and restored the same day at Patrick's direction. Nothing had been
built against the lost text.
Related tasks: TASK-026
Related ADRs: ADR-001, ADR-003
Supersedes: CONTRACT-005 only for (a) its exclusion of self-service password
flows, as far as a signed-out password change that requires the current
password is concerned, and (b) its exclusion of any browser-rendered admin UI,
as far as the single password-reset page defined here is concerned. All other
CONTRACT-005 behavior, and CONTRACT-006, remain in force.
Superseded by:

## Purpose

Let a local user change their own password, and let the holder of
`LOCAL_USER_ADMIN_TOKEN` reset a user's password from a browser instead of
`curl`. Patrick requested both on 2026-10-27, and decided that sessions
already issued stay valid after a password change, because emergency key
rotation (CONTRACT-003) already covers forced sign-out.

## Scope

### Included

- `POST /auth/local-change-password`: a JSON endpoint where a user proves
  they know their current password and sets a new one.
- `GET /auth/local-change-password`: a minimal HTML form that wraps that
  endpoint.
- `GET /admin/reset-password`: a minimal HTML form where an operator enters
  `LOCAL_USER_ADMIN_TOKEN`, a username, and a new password. The page calls
  the existing `GET /admin/users` and `PATCH /admin/users/:id`; it adds no
  server-side reset logic.
- Links between the new pages and the existing local sign-in page.
- Audit rows for self-service changes, in the existing
  `local_user_admin_audit` table, with no schema change.

### Excluded

- Revoking or reissuing sessions. A `bt_session` issued before a password
  change stays valid until it expires (local midnight), and a successful
  change does not set a cookie.
- Requiring a session to change a password. This service never verifies its
  own `bt_session` cookie, and this contract does not add that.
- User roles, or any local user acting on another user's account.
- Email reset links, "forgot password" self-service, "must change password at
  first login," password history, or password strength rules beyond the
  existing length minimum.
- Admin UI for anything other than resetting a password (create, disable,
  delete, edit email).
- Styling, branding, or responsive design.

## Actors

- **Local user**: knows their username and current password.
- **User-admin operator**: holds `LOCAL_USER_ADMIN_TOKEN` (CONTRACT-005 §4).
- **BTAuthOrchestrator**: verifies credentials, re-hashes passwords, and
  writes audit rows.

## Inputs and outputs

- Self-service request: `{"username": string, "currentPassword": string,
  "newPassword": string}` as JSON.
- Self-service success: `200 {"status":"password_changed","username":
  "<normalized username>"}`, with no `Set-Cookie`.
- Admin reset: the operator's browser sends the existing
  `PATCH /admin/users/:id` body `{"password": string, "actedBy"?: string}`
  with `Authorization: Bearer <LOCAL_USER_ADMIN_TOKEN>`. Request and
  response shapes are as CONTRACT-005 already defines them.

## Preconditions

- CONTRACT-005's schema, password hashing (`src/password.ts`), lockout, IP
  throttle, and admin API exist as implemented.
- The self-service endpoint and form exist only while `LOCAL_LOGIN=true`.

## Required behavior

### 1. Gating

- `GET` and `POST /auth/local-change-password` are live only when
  `LOCAL_LOGIN=true`. Otherwise they return the same generic `404` as any
  unmatched route, the same gating as `/auth/local-login` (CONTRACT-005 §7).
- `GET /admin/reset-password` is served regardless of `LOCAL_LOGIN` and
  `ALLOW_NEW_LOCAL_LOGIN_CREATION`, matching the admin API's own ungated
  reachability (CONTRACT-005 resolved decision #15). The page is static and
  contains no user data, so serving it requires no authentication. Every
  action it performs is authorized by the admin API.

### 2. Self-service change: `POST /auth/local-change-password`

The IP throttle check (step 1 below) runs first. Request validation follows.
A non-JSON `Content-Type` returns `415`. A body missing any of the three
fields, or with a field that is not a non-empty string, returns `400`. A
`newPassword` shorter than 12 characters returns `400` naming the rule. A
`newPassword` identical to `currentPassword` returns `400`: a user changing
their own password must choose a different one (resolved decision 2). None of these
checks looks up a user or hashes anything, and none counts toward a lockout,
the IP throttle, or the audit trail.

Verification follows CONTRACT-005 §2 steps 1–4, with `currentPassword` in
place of `password`:

1. Check this endpoint's own per-source-IP throttle first. It uses the same
   `LOCAL_LOGIN_IP_THROTTLE_*` thresholds as `/auth/local-login` but a
   **separate** counter, so failures at one endpoint never throttle the
   other (resolved decision 1). If the IP is throttled, respond `429` with
   the login endpoint's message, without parsing the body.
2. Normalize the username and look it up.
3. Always run a full-cost scrypt derivation, against the dummy salt when
   there is no matching row, so response timing cannot reveal which outcome
   applies.
4. Decide the outcome with the same precedence and side effects as login:
   - Unknown username, or wrong current password: `401
     {"error":"Invalid username or password."}`, byte-for-byte the login
     endpoint's merged message. A wrong current password increments
     `failed_login_attempts` and can lock the account, exactly as a failed
     sign-in does. Both cases record a failure on this endpoint's IP
     throttle counter.
   - Locked: `423`, with the same message and unlock time as login. Lockout
     state is not changed.
   - Disabled: `403`, with the same message as login.
   - Active, not locked, correct current password: success.

On success, the server hashes `newPassword` with `hashPassword` (a fresh salt
and current default parameters), and in one update stores the new hash, salt
and parameters, sets `failed_login_attempts = 0` and `locked_until = NULL`,
and updates `updated_at`. It then responds `200` as in Inputs and outputs. It
does not mint a token or set a cookie.

Responses carry `Content-Type: application/json` and `Cache-Control:
no-store`. Unexpected errors return a generic JSON `500`, never a raw error
(CONTRACT-005 §8).

### 3. Self-service form: `GET /auth/local-change-password`

The page is minimal, unstyled, self-contained HTML in the style of the
existing sign-in form (CONTRACT-005 §11). It has username, current password,
new password, and confirm new password fields. Its inline script:

- Refuses to submit, with an inline message, when the new password and its
  confirmation differ. This check runs only in the browser; the server never
  receives the confirmation field.
- Otherwise sends the three fields to `POST /auth/local-change-password` with
  `fetch()`. The page has no verification logic of its own.
- On success, replaces the form with "Your password has been changed." and a
  link to `/auth/local-login`.
- On failure, shows the response's `error` string as text (never as HTML),
  without rewording it.

The sign-in page (`GET /auth/local-login`) gains a "Change password" link to
this page.

### 4. Admin reset form: `GET /admin/reset-password`

The page is minimal, unstyled, self-contained HTML with fields for admin
token (a password-type input), username, new password, confirm new password,
and an optional "acted by" label. Its inline script:

- Refuses to submit, with an inline message, when the new password and its
  confirmation differ.
- Sends `GET /admin/users` with `Authorization: Bearer <token>` and finds the
  `id` whose `username` equals the entered username (lowercased and trimmed).
  If no user matches, it shows "No such user." and sends nothing else.
- Sends `PATCH /admin/users/:id` with `{"password": <new>, "actedBy":
  <label, omitted if blank>}` and the same `Authorization` header.
- On success, shows "Password reset for <username>." and clears the
  new-password fields. A `401` from either request shows the API's
  `Unauthorized` error text. Any other failure shows the response's `error`
  string as text.
- Keeps the token only in the input field for the page's lifetime. It never
  writes the token to `localStorage`, `sessionStorage`, a cookie, or the URL,
  and sends it only to same-origin `/admin/users*` requests.

The page's response carries `Cache-Control: no-store`. It is not linked from
any public page.

Because the reset goes through `PATCH /admin/users/:id`, CONTRACT-005's
existing rules apply unchanged. The password must be at least 12 characters.
Lockout state is reset, so a reset also unlocks the account. The account's
`is_active` flag is not changed, so a reset does not re-enable a disabled
user. One `update` audit row is written, plus an `auth_failure` row for a bad
token. An admin may set the same password the account already has; the admin
path neither knows nor checks the current password (resolved decision 2).

### 5. Audit trail

Each self-service attempt that gets past request validation and the throttle
check writes exactly one `local_user_admin_audit` row. The rows use existing
`action` values, so the table's `CHECK` constraint does not change:

- `action = 'update'`, `changed_fields = 'password'` on success (null on
  failure), `actor_label = 'self-service'`, plus `target_user_id` and
  `target_username` when a row was found (the submitted username otherwise),
  and `source_ip`.
- `result = 'failure'` uses `failure_reason` `unknown_username`,
  `bad_password`, `locked`, or `disabled`, which are more detailed than the
  HTTP response, as in `local_login_audit`.

Self-service attempts do not write `local_login_audit` rows, because they are
not sign-in attempts. Audit writes are best-effort, as in CONTRACT-005 §6.
Password values never appear in any audit row, log line, or response.

## Postconditions and invariants

- A successful change or reset leaves exactly one valid password for the
  account: the new one. The old password fails at `/auth/local-login`
  immediately afterwards.
- Sessions issued before the change still verify against JWKS until they
  expire.
- A failed self-service attempt never changes the password hash.
- The per-account lockout counts wrong passwords from sign-in and
  self-service change together. The per-IP throttle is counted separately
  per endpoint, so one IP can make up to twice the configured failures per
  window across both endpoints (resolved decision 1).
- No new server-side code path changes passwords for admins. The reset page
  is a browser-side wrapper around `PATCH /admin/users/:id`.

## Failure behavior

| Condition | Response | Side effects |
|---|---|---|
| `LOCAL_LOGIN` not `true` (self-service routes) | generic `404` | none |
| IP throttled | `429` | none |
| Non-JSON body | `415` | none |
| Missing or invalid fields, short or unchanged `newPassword` | `400` | none |
| Unknown username | `401` merged | throttle failure, audit row |
| Wrong current password | `401` merged | attempt counter or lockout, throttle failure, audit row |
| Locked | `423` | audit row |
| Disabled | `403` | audit row |
| Database or unexpected error | generic `500` JSON | best-effort audit, server-side log line |

Admin-page failures are whatever the existing admin API returns.

## Interfaces

| Method and path | Gate | Auth |
|---|---|---|
| `GET /auth/local-change-password` | `LOCAL_LOGIN=true` | none |
| `POST /auth/local-change-password` | `LOCAL_LOGIN=true` | current password |
| `GET /admin/reset-password` | always | none; page actions use the admin token |

The OpenAPI document (`src/openapi.ts`) and `docs/DEVELOPMENT.md` describe the
new endpoints.

## UX expectations

Both pages are plain functional forms, like the existing sign-in and
registration pages. Their error messages are the API's own strings, and both
pages work without any CSS.

## Validation requirements

The isolated handler and PGlite tests, in the style of
`scripts/test-local-registration.js`, cover:

- Gating: both self-service routes return `404` when `LOCAL_LOGIN=false`,
  and the reset page is served in both modes.
- The `415` and `400` cases, with no lookup, hashing, or audit row.
- A correct current password changes the hash, after which the old password
  fails and the new one succeeds at `/auth/local-login`. Lockout fields are
  cleared and no `Set-Cookie` header is sent.
- Unknown username and wrong current password return identical response
  bodies. A wrong current password increments the attempt counter and locks
  the account at the threshold.
- The change endpoint's IP throttle trips at the configured threshold, and
  its failures do not throttle `/auth/local-login` (or the reverse).
- A self-service change to the same password returns `400`; an admin reset
  to the same password succeeds.
- Locked and disabled accounts get their own responses, and their password is
  not changed.
- Audit rows have the specified fields and never contain a password.
- The reset page's inline script, run in a VM with DOM and `fetch` stand-ins
  as TASK-020's tests did, covers the confirmation mismatch, username-to-id
  lookup, the `PATCH` body and header, the unknown-username message, error
  text rendering, and the absence of any token storage.
- A previously minted session token still verifies after a password change.

## Open questions

None.

## Resolved decisions

Decided by Patrick on 2026-10-27.

1. **Separate IP throttle counters.** The change endpoint has its own IP
   throttle counter, with the same thresholds as sign-in. Patrick chose the
   more forgiving option while the service is still in testing. The
   per-account lockout is still shared, because it lives on the
   `local_users` row.
2. **Same-password rule.** A user changing their own password must choose a
   new one (`400` otherwise). An admin reset may set the same password.
3. **Paths.** `/auth/local-change-password` and `/admin/reset-password`, as
   drafted.
4. **Audit placement.** Self-service changes are `update` rows in
   `local_user_admin_audit` with `actor_label = 'self-service'`. No new
   `action` value and no migration.
