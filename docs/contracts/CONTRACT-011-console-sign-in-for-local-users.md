# CONTRACT-011: Console sign-in for active local users

Status: Approved
Approved by: Patrick
Approved date: 2026-10-28
Related tasks: TASK-028
Related ADRs: ADR-001, ADR-003
Supersedes:
- CONTRACT-005 §4, only where it makes `LOCAL_USER_ADMIN_TOKEN` the sole
  credential for `/admin/users*`. §4 otherwise stays in force.
- CONTRACT-005 §6, only for how the actor is recorded on admin audit rows.
- CONTRACT-006, only for its rule that `POST /admin/users` returns `403`
  while public creation is disabled even with a valid admin token, and for
  attributing token-authorized creation as `public-registration` while it
  is enabled (§7).
- CONTRACT-010, for its exclusion of console accounts and sessions, its
  statement that the console adds no authorization rules, and the "Token
  sent" column of its Inputs and outputs table.

All other behavior in CONTRACT-001, CONTRACT-003, CONTRACT-005,
CONTRACT-006, CONTRACT-009 and CONTRACT-010 remains in force.
Superseded by:

## Purpose

Let an operator manage local users from the admin console by signing in
with a local username and password, instead of pasting
`LOCAL_USER_ADMIN_TOKEN` into every new tab. Patrick made these decisions on
2026-10-28:

- Tokens stay in `sessionStorage` (CONTRACT-010 §2) and remain the
  last-resort path for every admin action.
- Any active local user who signs in is treated as an admin, for now.
- The credential is the existing `bt_session` cookie. There is no separate
  console session.
- Session admin is refused whenever `ALLOW_NEW_LOCAL_LOGIN_CREATION` is on,
  because anyone could then register and become an admin.
- Only local users qualify. Entra users get no admin rights.
- A signed-in user can manage users only. Emergency key rotation stays
  token-only.

## Scope

### Included

- Accepting a valid `bt_session` as an alternative to
  `LOCAL_USER_ADMIN_TOKEN` on the user-management routes, under the
  conditions in §1.
- A request-forgery (CSRF) check on every session-authorized request.
- `GET /admin/session`, which reports whether session admin is available and
  who is signed in.
- `POST /auth/logout`, which clears `bt_session`.
- Admin-authorized user creation whatever the registration setting (§7).
- Recording on admin audit rows how each action was authorized and, for
  sessions, which user performed it.
- Console sign-in, signed-in state and sign-out.
- OpenAPI, `docs/DEVELOPMENT.md` and README updates.

### Excluded

- Any change to how tokens are stored or sent when the operator uses them.
- Roles, per-user admin flags, or any way to make an active local user
  *not* an admin.
- Admin rights for Entra users.
- Any change to `bt_session`'s claims, signing, lifetime, `Domain`, `Path`
  or `SameSite` (CONTRACT-001 §4–§7), or to `/auth/local-login`'s behavior,
  throttling, lockout or audit (CONTRACT-005 §2–§3).
- Session access to `POST /admin/emergency-rotate-keys`.
- Server-side session revocation. `bt_session` stays a stateless JWT.

## Actors

- **Signed-in operator**: an active local user holding a `bt_session` minted
  by this service's local login.
- **Token operator**: holds `LOCAL_USER_ADMIN_TOKEN` and/or
  `EMERGENCY_ROTATION_TOKEN`, as in CONTRACT-010.
- **Browser**: stores `bt_session` (HttpOnly, so console script cannot read
  it) and sends it on same-site requests.
- **Other `*.biztechro.com` sites**: share the same cookie and count as
  same-site. They are untrusted for admin purposes.
- **BTAuthOrchestrator**: verifies the cookie and authorizes each request.

## Inputs and outputs

| Console action | API call | Credential |
|---|---|---|
| Session status | `GET /admin/session` | cookie, if any |
| Sign in | `POST /auth/local-login` | username and password |
| Sign out | `POST /auth/logout` | none |
| List, view, edit, enable/disable, reset password, delete | `/admin/users*` as today | session when signed in, otherwise user-admin token |
| Create user while registration is off | `POST /admin/users` | session or user-admin token |
| Create user while registration is on | `POST /admin/users` | user-admin token if saved, otherwise none (public) |
| Emergency rotation | `POST /admin/emergency-rotate-keys` | emergency token only |

Every session-authorized request carries the header
`X-BT-Admin-Console: 1` (§1, rule 7).

## Preconditions

- `bt_session` is set with `Domain=.biztechro.com` (CONTRACT-001 §7).
  Browsers store it only when the console is reached at a host under
  `biztechro.com`, and only over HTTPS when `COOKIE_SECURE=true`. At any
  other host, such as `localhost` or a bare IP, sign-in appears to succeed
  but the cookie is not stored, and the console falls back to tokens (§5).
- The service holds its own current and retired signing keys
  (CONTRACT-008 storage interfaces).

## Required behavior

### 1. Session authorization on `/admin/users*`

This applies to `GET /admin/users`, `GET /admin/users/:id`,
`PATCH /admin/users/:id`, `DELETE /admin/users/:id`, and
`POST /admin/users` as §7 describes.

**Precedence.** If the request has an `Authorization` header, it is
authorized by the token exactly as CONTRACT-005 §4 says, and the cookie is
ignored. A wrong token is a `401` even when a valid cookie is also present.

Otherwise the request is session-authorized only when **all** of these
hold, checked at request time:

1. `ALLOW_NEW_LOCAL_LOGIN_CREATION` is not enabled.
2. `LOCAL_LOGIN` is `true`.
3. Exactly one `bt_session` cookie is present.
4. The cookie is a JWT that verifies with RS256 against one of this
   service's own **current or retired** signing keys, chosen by `kid`.
   Revoked keys never verify. `iss` equals the configured `SERVICE_ISSUER`,
   and `exp` is in the future.
5. `sub` equals the `id` of a row in `local_users`.
6. That row has `is_active = true`. A temporary lockout (`locked_until`)
   does not affect session admin.
7. The request carries `X-BT-Admin-Console: 1`. If it carries an `Origin`
   header, that value equals the origin of `SERVICE_ISSUER`. If it carries
   `Sec-Fetch-Site`, that value is `same-origin`.

Rule 5 is what excludes Entra users: their `sub` is an Entra object id,
which never matches a `local_users.id`. Rules 5 and 6 are checked on every
request, so disabling or deleting a user ends their admin access
immediately, even though their cookie stays valid for other apps until it
expires.

Rule 7 is the request-forgery defense. `SameSite=Lax` does not help here,
because every `*.biztechro.com` site is same-site. A custom header cannot be
added to a cross-origin request without a CORS preflight, and this service
answers no preflight, so another origin cannot send it. The `Origin` and
`Sec-Fetch-Site` checks are a second layer. Rule 7 applies to reads as well
as writes.

**Failure.** If no `Authorization` header is present and any rule fails, the
response is the existing generic `401` (`{"error":"Unauthorized"}`). It does
not say which rule failed. A `local_user_admin_audit` row is written with
`action = 'auth_failure'`, as today, with one of these `failure_reason`
values:

| Condition | `failure_reason` |
|---|---|
| No cookie and no `Authorization` header | `bad_credential` (unchanged) |
| Rule 1 fails | `session_registration_open` |
| Rule 2 fails | `session_local_login_off` |
| Rule 3 or 4 fails | `session_invalid` |
| Rule 5 or 6 fails | `session_user_not_active` |
| Rule 7 fails | `session_csrf_rejected` |

When rules 1, 2 and 7 all fail, the first failing rule in that list is
recorded.

**Permissions.** A session-authorized request can do everything the
user-admin token can do on these routes, with the same validation, response
shapes and error specificity (CONTRACT-005 §4). A signed-in user may edit,
disable or delete their own account. Disabling or deleting it ends their
own session admin on the next request.

### 2. `GET /admin/session`

Always available, in both login modes. It needs no credential and has no
side effects. Responses use `Cache-Control: no-store` and
`Content-Type: application/json`. It is not audited.

Response `200`:

```json
{
  "sessionAdmin": "available" | "unavailable",
  "reason": null | "registration_open" | "local_login_off",
  "signedIn": true | false,
  "user": null | { "id": "…", "username": "…" }
}
```

- `sessionAdmin` is `unavailable` when §1 rule 1 or 2 fails. `reason` names
  the first failing rule.
- `signedIn` is `true` only when the request's cookie passes §1 rules 3–6
  and `sessionAdmin` is `available`. `user` is then that row's `id` and
  `username`, and `null` otherwise.
- Rule 7 is not required here. The response reveals only the caller's own
  identity, and with no CORS another origin cannot read it.

### 3. Signing in

The console signs in by calling the existing `POST /auth/local-login` with
JSON, unchanged. Its throttling, lockout, audit and cookie are exactly as
CONTRACT-005 defines. The console offers sign-in only when
`GET /admin/session` reports `sessionAdmin: "available"`.

### 4. `POST /auth/logout`

- Available in both login modes. No body and no credential.
- Requires `X-BT-Admin-Console: 1` and the same `Origin`/`Sec-Fetch-Site`
  checks as §1 rule 7. Otherwise it returns `403` and changes nothing.
- Responds `200` with `{"status":"signed_out"}` and a `Set-Cookie` that
  expires `bt_session` using the same `Name`, `Domain` and `Path` as
  CONTRACT-001 §7, with `Max-Age=0`.
- This signs the browser out of **every** `*.biztechro.com` app, because
  the cookie is shared. It does not revoke the token. A copy of the token
  held elsewhere stays valid until its `exp`.
- Not audited.

### 5. Console

These rules add to CONTRACT-010, which remains in force except as
superseded above.

- On load and after every sign-in, sign-out or `401`, the console calls
  `GET /admin/session`.
- **Sign-in panel** (Settings area, and shown on the Users area when the
  operator has neither a session nor a token): username and password fields
  and a "Sign in" button. Passwords are never stored and are cleared after
  every attempt, as CONTRACT-010 §6 requires.
- After `POST /auth/local-login` returns `200`, if `GET /admin/session`
  still reports `signedIn: false`, the console explains that the browser
  did not keep the session cookie. It names the likely causes: the console
  was not opened at a `biztechro.com` address, or HTTPS was not used while
  secure cookies are required. It suggests using a token instead.
- **Signed-in state:** shows "Signed in as `<username>`" and a "Sign out"
  button.
- **Unavailable state:** when `sessionAdmin` is `unavailable`, the sign-in
  form is hidden and the console explains why:
  - `registration_open`: "Console sign-in is turned off while public
    registration is on. Use the user-admin token."
  - `local_login_off`: "Console sign-in needs local login mode. Use the
    user-admin token."
- **Which credential is sent on `/admin/users*`:**
  - Signed in: no `Authorization` header. The request carries
    `X-BT-Admin-Console: 1` and relies on the cookie.
  - Not signed in and a user-admin token is saved: the bearer token, as
    today.
  - Neither: the action is disabled with a prompt to sign in or add a token.
  - Every console request to `/admin/users*` carries
    `X-BT-Admin-Console: 1`, whichever credential it uses.
- **`401` while signed in:** the console re-checks `GET /admin/session`. If
  the session is gone, it shows the signed-out state and asks the operator
  to sign in again. It never clears a saved token because of a session
  `401`.
- **Acting-as label:** while signed in, the label is hidden and not sent,
  because the server records the signed-in user (§6).
- **Emergency rotation** is unchanged and always uses the emergency token.
- All CONTRACT-010 §1 serving rules and headers still apply. The CSP needs
  no change, because sign-in uses `fetch` and `connect-src 'self'`.

### 6. Audit attribution

`local_user_admin_audit` gains two nullable columns. Existing rows keep
`NULL` in both:

| Column | Values |
|---|---|
| `auth_method` | `'token'`, `'session'` or `'public'` |
| `actor_user_id` | the signed-in user's `local_users.id`, for `'session'` only |

- **Session-authorized actions:** `auth_method = 'session'`,
  `actor_user_id` is the user's id, and `actor_label` is their username.
  Any `actedBy` in the request body is ignored.
- **Token-authorized actions:** `auth_method = 'token'`, and `actor_label`
  is the self-asserted `actedBy`, as today.
- **Public creation** (registration on): `auth_method = 'public'` and
  `actor_label = 'public-registration'`, as today.
- **Session `auth_failure` rows** (§1): `auth_method = 'session'`,
  `actor_label` and `actor_user_id` are `NULL`.
- Users created by a signed-in admin get `created_by` set to that admin's
  username. Users created with the token get the `actedBy` value, as
  CONTRACT-005 originally defined.

### 7. User creation by an admin credential

Patrick decided (2026-10-28, OQ-1) that a valid admin credential always
authorizes local user maintenance, including creation, whatever the
registration setting.

- **A request with an `Authorization` header** is authorized by the
  user-admin token, in both registration states. A correct token creates
  the user with `auth_method = 'token'` and `created_by`/`actor_label` from
  `actedBy`. A wrong token gets the generic `401` and an `auth_failure`
  row; it never falls back to public creation.
- **Registration off, no `Authorization` header:** the request is
  session-authorized under §1. A valid session creates the user with
  session attribution (§6). Anything else gets the generic `401` and an
  `auth_failure` row, replacing CONTRACT-006's `403`/`creation_disabled`.
- **Registration on, no `Authorization` header:** creation stays public
  exactly as CONTRACT-006 defines, attributed `public-registration`. §1
  does not apply, because session admin is always refused while
  registration is on.
- The request body, validation, hashing and responses are unchanged in
  every case.
- The console sends the user-admin token on create whenever one is saved
  and the operator is not signed in, so its creations are attributed to an
  admin rather than to public registration. This supersedes CONTRACT-010
  §2's rule that `POST /admin/users` never carries a token.

### 8. Unchanged

- `POST /admin/emergency-rotate-keys` never reads `bt_session`. A cookie
  alone gets CONTRACT-003's `401`.
- `/admin/reset-password` (CONTRACT-009) is unchanged and still uses the
  token.
- Nothing in this contract changes what other apps see in `bt_session`.

## Postconditions and invariants

- With registration on, no request is ever authorized by `bt_session`.
- No Entra-issued session, and no session for an inactive or deleted user,
  ever authorizes an admin request.
- No session-authorized request succeeds without `X-BT-Admin-Console: 1`.
- Token behavior on every route is unchanged, except `POST /admin/users`
  while registration is off (§7).
- `bt_session`'s value never appears in logs, audit rows, response bodies or
  error messages.
- Console script never reads or writes `bt_session`. Only the server sets or
  clears it.

## Failure behavior

| Condition | Result |
|---|---|
| No credential on `/admin/users*` | `401`, `bad_credential` audit |
| `Authorization` present and wrong, valid cookie present | `401`, `bad_credential` audit |
| Valid session, registration on | `401`, `session_registration_open` audit |
| Valid session, `LOCAL_LOGIN=false` | `401`, `session_local_login_off` audit |
| Bad signature, revoked key, wrong `iss`, expired, malformed, more than one cookie | `401`, `session_invalid` audit |
| Session for an Entra, disabled or deleted user | `401`, `session_user_not_active` audit |
| Missing custom header, foreign `Origin`, or `Sec-Fetch-Site` not `same-origin` | `401`, `session_csrf_rejected` audit |
| Signing-key lookup fails while verifying | `500`, generic error, no admin action taken |
| `GET /admin/session` cannot read keys or users | `500`, generic error; console treats it as signed out |
| `POST /auth/logout` without the custom header or with a foreign origin | `403`, cookie unchanged |
| Cookie not stored after sign-in (wrong host, HTTP with secure cookies) | Console explains and suggests tokens (§5) |

## Interfaces

| Method and path | Auth | Notes |
|---|---|---|
| `GET /admin/session` | none (reads cookie if present) | §2 |
| `POST /auth/logout` | none; custom header and origin checks | §4 |
| `GET/PATCH/DELETE /admin/users*` | user-admin token **or** session (§1) | token wins when `Authorization` is present |
| `POST /admin/users` | token in either state; session while registration off; public while registration on | §7 |
| `POST /admin/emergency-rotate-keys` | emergency token only | unchanged |

Request header: `X-BT-Admin-Console: 1`, required on every
session-authorized request and on `POST /auth/logout`.

Schema: `local_user_admin_audit` adds `auth_method text` with
`CHECK (auth_method IN ('token', 'session', 'public'))` and
`actor_user_id text`, both nullable, added by an idempotent migration.

## UX expectations

- Signing in should feel like the fastest way into the console. Tokens are
  presented as the fallback, not a prerequisite.
- When sign-in is unavailable or the cookie did not stick, the console says
  why in one plain sentence and points to the token.
- The console makes clear that "Sign out" signs the browser out of every
  BizTech app, not just the console.

## Validation requirements

Isolated handler tests, in the style of the existing `scripts/test-*.js`
files, injecting the `Cookie` header directly (so no `biztechro.com` host is
needed), cover:

- **Session success:** an active local user's freshly minted cookie with the
  custom header lists, views, edits, disables, resets and deletes users.
  Write audit rows show `auth_method = 'session'`, the user's id and
  username, and ignore a body `actedBy`.
- **Each rule in §1 failing in isolation:** registration on; `LOCAL_LOGIN`
  off; two cookies; bad signature; a cookie signed by a revoked key; wrong
  `iss`; expired; an Entra-style `sub`; a disabled user; a deleted user;
  missing custom header; foreign `Origin`; `Sec-Fetch-Site: same-site`. Each
  gets the generic `401` and the matching `failure_reason`.
- **A cookie signed by a retired key** still authorizes.
- **Mid-session disable:** a user disabled between two requests is refused
  on the second.
- **Precedence:** a wrong bearer token plus a valid cookie gets `401`; a
  correct token plus no cookie behaves exactly as before.
- **Rotation:** `POST /admin/emergency-rotate-keys` with only a valid cookie
  gets `401`.
- **`GET /admin/session`:** every combination of `reason` and `signedIn`.
- **`POST /auth/logout`:** the cookie-clearing header matches CONTRACT-001
  §7's name, domain and path; missing header or foreign origin gets `403`.
- **Creation (§7):** with registration off, token- and session-authorized
  creation succeed and an unauthenticated request gets `401`; with
  registration on, a correct token creates with token attribution, a wrong
  token gets `401`, and no `Authorization` header matches CONTRACT-006
  exactly.
- **Migration:** runs on a database with existing audit rows, leaves them
  with `NULL` in the new columns, and is safe to run twice.
- **Console script** (VM with DOM, `fetch` and storage stand-ins): sends the
  custom header on every `/admin/users*` call; sends no `Authorization`
  while signed in; falls back to the token when signed out; a session `401`
  does not clear a saved token; the unavailable and cookie-not-stored
  messages appear; password fields are cleared after sign-in.
- **Unchanged behavior:** every existing test script passes. The ones that
  assert CONTRACT-006's `403` for admin-token creation while registration
  is off, or `public-registration` attribution for token creation while it
  is on, are updated to the §7 behavior.
- **Manual browser check, recorded in the handoff:** sign-in, sign-out and
  user management at a `*.biztechro.com` host (a hosts-file entry is
  enough), and the cookie-not-stored message at `localhost`.

## Open questions

All open questions were decided by Patrick on 2026-10-28. The draft is
ready for approval.


1. **Creating users while registration is off.** Session admin only works
   with registration off, and CONTRACT-006 refuses creation then, even with
   the admin token. So a signed-in admin could never create a user.
   Options:
   - (a) Allow creation by token or session while registration is off, as
     drafted in §7. This supersedes part of CONTRACT-006.
   - (b) Keep CONTRACT-006 as it is. Signed-in admins cannot create users;
     the operator has to turn registration on, which turns console sign-in
     off.
   **Decided (Patrick, 2026-10-28): (a), broadened.** A token or session
   overrides the registration gate on local user maintenance, so a valid
   admin token creates users in both registration states. See §7.
2. **Sign-out.** No logout endpoint exists today, and the console cannot
   clear an HttpOnly cookie itself. Options:
   - (a) Add `POST /auth/logout` as in §4, accepting that it signs the
     browser out of every `*.biztechro.com` app.
   - (b) No sign-out. The session ends at local midnight or when the
     browser clears its cookies.
   **Decided (Patrick, 2026-10-28): (a).** See §4.
3. **Entra mode.** Local users can only obtain `bt_session` while
   `LOCAL_LOGIN=true`. A cookie minted before switching to Entra mode would
   still verify until midnight. Should session admin require
   `LOCAL_LOGIN=true` (rule 2)? Recommended: yes.
   **Decided (Patrick, 2026-10-28): yes.** See §1 rule 2.
4. **Audit columns.** Today `actor_label` is free text, so a token user's
   `actedBy` could imitate a signed-in username. Adding `auth_method` and
   `actor_user_id` makes the two distinguishable, at the cost of a schema
   migration. The alternative is a label prefix such as `session:alice`
   with no schema change, which a token user could still imitate.
   **Decided (Patrick, 2026-10-28): add the columns.** See §6.
5. **Locked accounts.** A lockout from failed password attempts protects the
   password. It does not mean the user should lose access. Should a locked
   user's existing session keep admin rights? Recommended: yes, as drafted
   in rule 6.
   **Decided (Patrick, 2026-10-28): yes, as drafted in rule 6.**
6. **Header name.** `X-BT-Admin-Console: 1` is proposed. Any name works; it
   only has to be custom.
   **Decided (Patrick, 2026-10-28): `X-BT-Admin-Console: 1`.**
