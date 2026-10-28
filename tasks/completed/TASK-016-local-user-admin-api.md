# TASK-016: Local user admin CRUD API

Owner role: Implementer
Assigned agent: TBD
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by: Patrick
Approved date: 2026-09-15
Related contracts: CONTRACT-005 (§4, §6's admin-audit half)
Related ADRs: ADR-003
Dependencies: TASK-015 (needs `local_users` schema and the password-hashing
path to exist)

## Desired outcome

`POST/GET/PATCH/DELETE /admin/users*` exist per CONTRACT-005 §4: a
dedicated `LOCAL_USER_ADMIN_TOKEN` gates all of them, independent of
`LOCAL_LOGIN`'s value, and every action produces a `local_user_admin_audit`
row.

## Context

Depends on TASK-015 for the `local_users` table and password-hashing
function — this task adds the HTTP surface and its own authorization/audit
around them.

## Scope

### Included

- `POST /admin/users`, `GET /admin/users`, `GET /admin/users/:id`,
  `PATCH /admin/users/:id`, `DELETE /admin/users/:id` per CONTRACT-005 §4
  and Interfaces' exact request/response shapes.
- `LOCAL_USER_ADMIN_TOKEN` bearer check: constant-time comparison, generic
  401, never distinguishing missing/malformed/wrong.
- `local_user_admin_audit` table and its writes (every action, success or
  failure).
- Confirm this surface remains reachable regardless of `LOCAL_LOGIN`'s
  value (CONTRACT-005's confirmed decision — not gated by that switch).
- Username immutability: no rename via `PATCH` (confirmed — delete and
  recreate instead).

### Excluded

- `POST /auth/local-login` itself and `local_login_audit` — TASK-015.
- `scripts/seed.js` — TASK-017.
- The HTML login form — TASK-018.

## Plan

1. Add `local_user_admin_audit` to `database.ts`'s schema string.
2. Add `LOCAL_USER_ADMIN_TOKEN` bearer-check middleware/helper, reusing the
   same constant-time-comparison pattern CONTRACT-003's endpoint already
   established in `index.ts`.
3. Implement the five endpoints per CONTRACT-005 §4/Interfaces, using
   TASK-015's password-hashing function for `create`/`password`-bearing
   `update`.
4. Write an audit row for every action (success and failure).

## Acceptance criteria

- [x] Each of the five endpoints behaves per CONTRACT-005 §4/Interfaces,
      including exact status codes for conflicts (409) and not-found (404).
- [x] A request with a missing/wrong `Authorization` header is rejected
      (401) regardless of `LOCAL_LOGIN`'s value.
- [x] A valid `bt_session` cookie alone does not authorize any
      `/admin/users*` request.
- [x] No response body, at any endpoint, ever includes a password hash or
      hashing parameter.
- [x] Every action (success or failure) produces exactly one
      `local_user_admin_audit` row — see "Assumptions and deviations" for
      this task's reading of which actions the contract's own `action` enum
      (§1/§6) scopes this to (create/update/delete/auth_failure, not reads).

## Validation requirements

Per CONTRACT-005's Validation requirements section, the subset naming
`/admin/users*`.

## Risks and assumptions

None beyond TASK-015 landing first.

## Blocker

None (depends on TASK-015 completing, not literally blocked yet).

## Implementation handoff

Task: TASK-016 — Local user admin CRUD API
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
confirmed unreachable again this session; Patrick explicitly chose to
continue this substitution rather than wait for it)
Date: 2026-09-15

### Changes made

- **`src/database.ts`**: added `local_user_admin_audit` as a new
  `CREATE TABLE IF NOT EXISTS` block inside the existing `schemaMigration`
  string (this task's own new table — not TASK-015's). Columns match
  CONTRACT-005 §1's schema table exactly: `id`, `occurred_at`, `action`
  (`CHECK IN ('create', 'update', 'delete', 'auth_failure')`),
  `target_user_id`, `target_username`, `changed_fields`, `result`
  (`CHECK IN ('success', 'failure')`), `failure_reason`, `actor_label`,
  `source_ip`. The `action` CHECK deliberately has no "read"/"list"/"get"
  value — CONTRACT-005 §6 scopes the audit trail to exactly these four
  action values, so a successful `GET` is never expected to produce a row
  here (see "Assumptions and deviations").
- **`src/localUsers.ts`**: extended (not duplicated) `LocalUserStore` with
  the admin CRUD surface, reusing TASK-015's existing module boundary,
  `LocalUserRow`/`local_users` schema, and `src/password.ts`'s
  `hashPassword`/`ScryptParameters` types — no new store, no re-derivation
  of the schema:
  - `LocalUserPublicRecord` (`id`, `username`, `email`, `isActive`,
    `createdAt`, `updatedAt`) — the exact public shape returned by every
    admin endpoint; never includes `password_hash`/`password_salt`/any
    hashing parameter.
  - `UsernameConflictError`/`EmailConflictError` — thrown by
    `createUser`/`updateUser` so `src/index.ts` can map each to its own 409
    message per CONTRACT-005's Failure behavior table ("or the
    email-specific variant").
  - `createUser`: one transaction — `SELECT username, email FROM
    local_users WHERE username = $1 OR email = $2` (check-then-insert,
    mirroring `src/secrets.ts`'s existing "current signing key" check-then-
    insert pattern), throwing the specific conflict error before inserting,
    so a race is still caught by the underlying `UNIQUE` constraints even
    though the application-level check is the primary path.
  - `listUsers`/`getUserById`: plain `SELECT`s returning only the public
    columns.
  - `updateUser(id, { email?, passwordHash?, isActive? })`: one
    transaction — confirms the row exists (returns `undefined` if not, for
    a 404), conditionally builds `SET` clauses only for the fields
    supplied, re-checks email uniqueness against other rows if `email` is
    being changed, resets `failed_login_attempts = 0, locked_until = NULL`
    when `passwordHash` is supplied (CONTRACT-005 Postconditions), and
    returns both the updated public record and the list of field names
    actually changed (`changedFields`) for the audit row.
  - `deleteUser`: `DELETE ... RETURNING id, username`; returns `undefined`
    if no row matched (404).
  - `writeAdminAudit`: inserts one `local_user_admin_audit` row; does not
    swallow its own errors (same pattern as `writeLoginAudit`), so
    `src/index.ts` applies the best-effort/log-backstop wrapper.
- **`src/index.ts`**:
  - Added `checkAdminBearerAuth` (mirrors `constantTimeTokenMatches`/
    `extractBearerToken`, already generic helpers reused as-is, gated on
    `config.localUserAdminToken` instead of `config.emergencyRotationToken`)
    and `writeAdminAuditBestEffort` (same best-effort/log-backstop pattern
    as `writeEmergencyRotationFailureAudit`/`writeLocalLoginAuditBestEffort`).
  - Added `readAdminRequestBody` (reads+JSON-parses a `POST`/`PATCH` body,
    also extracting the optional `actedBy` label) and per-field validators
    `validateAdminUsername`/`validateAdminEmail`/`validateAdminPassword`
    (username: normalized-lowercase, 3-64 chars,
    `[a-z0-9._-]`, per CONTRACT-005 "Resolved decisions" #4; password:
    minimum 12 characters, no complexity rule, same source; email: a loose
    `@`/`.`-shape check plus a 254-character cap — not contract-specified,
    see "Assumptions and deviations").
  - Added five handlers: `handleAdminCreateUser`, `handleAdminListUsers`,
    `handleAdminGetUser`, `handleAdminPatchUser`, `handleAdminDeleteUser`.
    Each checks the bearer token first; on failure, writes one
    `action='auth_failure'` audit row (best effort) and returns generic
    `401 {"error":"Unauthorized"}` — never distinguishing missing/malformed/
    wrong token, identical posture to `handleEmergencyRotateKeys`. For
    `POST`/`PATCH` (which carry a body), the body is read and `actedBy`
    extracted **before** the auth check, mirroring
    `handleEmergencyRotateKeys`'s own choice to capture `triggeredBy` for
    the audit row even on an auth failure; `GET`/`DELETE` read no body (none
    is specified for them in Interfaces), so their `auth_failure` rows
    always have `actor_label = null`.
    - `handleAdminCreateUser`: validates `username`/`email`/`password` (400
      naming the first invalid field), hashes via the existing
      `hashPassword`, calls `createUser`, returns `201` with the public
      record; maps `UsernameConflictError`/`EmailConflictError` to `409`
      with that error's own message; any other failure is logged
      server-side and returns generic `500
      {"error":"Unable to complete the request."}`. Writes one `action='create'`
      audit row on every success/failure path (validation errors are
      **not** audited — see "Assumptions and deviations" for why).
    - `handleAdminListUsers`/`handleAdminGetUser`: auth check, then a plain
      read; no audit row on success or on a `GET :id` 404 — only the
      `auth_failure` case is audited, per the schema's `action` enum (see
      "Changes made" > `database.ts` above).
    - `handleAdminPatchUser`: rejects a `username` field in the body with a
      `400` (CONTRACT-005: no rename via `PATCH`); requires at least one of
      `email`/`password`/`isActive`; validates each supplied field; calls
      `updateUser`; `404` if the id doesn't exist; `409` on an email
      collision; writes one `action='update'` audit row with
      `changed_fields` set to the actual comma-joined list of changed field
      names (e.g. `"email,password"` — the field name `password` appears,
      never its value) on every outcome except a pure validation error.
    - `handleAdminDeleteUser`: calls `deleteUser`; `404` if the id doesn't
      exist; `200 {"status":"deleted","id","username"}` on success; writes
      one `action='delete'` audit row on both outcomes.
  - Route dispatch: added a block matching `POST /admin/users`,
    `GET /admin/users`, `GET|PATCH|DELETE /admin/users/:id` (via
    `/^\/admin\/users\/([^/]+)$/`), placed immediately after the existing
    `POST /admin/emergency-rotate-keys` block and **before** the
    `LOCAL_LOGIN`-gated `/auth/local-login`/Entra-route block — so this
    surface is dispatched unconditionally, regardless of `config.localLogin`,
    per CONTRACT-005 §7 ("not gated by `LOCAL_LOGIN`"). Any other
    method/path combination under `/admin/users*` (e.g. `PUT
    /admin/users/:id`) falls through to the existing, unmodified generic
    `404 {"error":"Not found"}` — no distinct "wrong method" response, same
    posture as the emergency-rotation endpoint.
- **`docs/DEVELOPMENT.md`**: added a new "Local user admin API (CONTRACT-005
  §4, TASK-016)" subsection (immediately after the local-login subsection,
  before the emergency-rotation paragraph) describing the five endpoints,
  the bearer-token check, validation rules, conflict/not-found behavior,
  username immutability, and the audit trail's scope; updated the
  `LOCAL_USER_ADMIN_TOKEN` paragraph (no longer "reserved for the future
  API" — the API now exists) and the `LOCAL_LOGIN` mode-switch paragraph to
  note `/admin/users*` is unaffected by that flag in either state.
- No changes to `src/config.ts`, `src/password.ts`, `src/tokens.ts`,
  `src/oidc.ts`, `src/secrets.ts`, `src/ipThrottle.ts`, or
  `src/verify-offline.ts` — `LOCAL_USER_ADMIN_TOKEN`'s config validation was
  already complete from TASK-015 (confirmed by inspection before starting;
  reused as-is).

### Validation performed

This sandbox session permits live socket binding (confirmed directly with a
throwaway `net.createServer().listen(0, "127.0.0.1", ...)` probe, same check
TASK-009/015's sessions made: `live socket binding OK on port 36975`). All
HTTP validation below therefore used the real compiled service
(`dist/index.js`) over a real loopback socket, not the exported-handler
fallback.

- `npm run build`: TypeScript compiled cleanly with no errors, both after
  the initial implementation and again after every subsequent edit.

- **End-to-end setup**: fresh scratch `PGLITE_DATA_DIR` (`chmod 700`),
  seeded via `node dist/seed.js --client-secret-file=...`, then the real
  compiled service started against it (`LOCAL_LOGIN=true` first, then a
  second run with `LOCAL_LOGIN=false` plus `TENANT_ID`/`CLIENT_ID` set,
  against the same data directory, sequentially — never concurrently,
  respecting the single-process lock).

- **`POST /admin/users`** (real `curl -i` against the live service):
  - No `Authorization` header, wrong token (correct length, wrong value),
    and malformed scheme (`Authorization: bearer <token>`, lowercase) each
    returned identical `401 {"error":"Unauthorized"}`.
  - Correct token, valid body (`{"username":"alice","email":"alice@example.invalid","password":"correct horse battery staple","actedBy":"patrick-test"}`):
    `201 Created`, body `{"id":"93d6479d-...","username":"alice","email":"alice@example.invalid","isActive":true,"createdAt":"...","updatedAt":"..."}`
    — no password field of any kind.
  - Duplicate `username` (different email): `409
    {"error":"A user with that username already exists."}`. Duplicate
    `email` (different username): `409 {"error":"A user with that email
    already exists."}`.
  - Short password (`"short"`): `400 {"error":"password must be at least 12
    characters"}`. Invalid username (`"Bob!"`, uppercase/punctuation): `400
    {"error":"username must be 3-64 characters, using only lowercase
    letters, digits, '.', '-', or '_'"}`. Invalid email (`"not-an-email"`):
    `400 {"error":"email must be a valid email address"}`. Missing `email`
    field: `400 {"error":"email is required and must be a non-empty
    string"}`.
  - Mixed-case/whitespace username (`"  DaveMixed  "`): created
    successfully as `"davemixed"`, confirming trim+lowercase normalization
    at write time (matching `/auth/local-login`'s own normalization).
  - Malformed (non-JSON) body: `400 {"error":"Request body must be a JSON
    object."}`. A JSON array body (`[1,2,3]`): fell through field
    validation to `400 {"error":"username is required and must be a
    string"}` (not a distinct code path — array is a JS "object", but has
    no `username` property — verified this doesn't crash the handler).

- **`GET /admin/users` / `GET /admin/users/:id`**:
  - No auth: `401`. Correct token: `200 {"users":[...]}` listing every
    created user's public fields only.
  - `GET /admin/users/<real-id>` with correct token: `200` with that user's
    record. `GET /admin/users/00000000-0000-0000-0000-000000000000`: `404
    {"error":"No such user."}`.

- **`PATCH /admin/users/:id`**:
  - No auth: `401`. Empty body `{}`: `400 {"error":"At least one of email,
    password, or isActive is required."}`. Body containing `"username"`:
    `400 {"error":"username cannot be changed via this endpoint; delete and
    recreate the user instead."}`.
  - Email collision (PATCH alice's email to bob-disabled's existing email):
    `409 {"error":"A user with that email already exists."}`.
  - `{"isActive":false,"actedBy":"patrick-test"}` against `bob-disabled`:
    `200` with `isActive:false` in the response.
  - `{"email":"alice-new@example.invalid","password":"a-new-strong-password-99"}`
    against `alice`: `200` with the new email; direct DB inspection (see
    below) confirmed `changed_fields = "email,password"`.
  - Nonexistent id: `404 {"error":"No such user."}`. Short password on an
    existing user: `400`. Non-boolean `isActive` (`"yes"`): `400
    {"error":"isActive must be a boolean."}`.

- **`DELETE /admin/users/:id`**:
  - No auth: `401`. Correct token against alice's real id: `200
    {"status":"deleted","id":"93d6479d-...","username":"alice"}`. Repeating
    the same delete: `404 {"error":"No such user."}`.

- **Admin-created/updated users are usable through `/auth/local-login`**
  (proves the admin API and TASK-015's login path share the same
  `local_users` row/hashing path, not two parallel implementations):
  logged in as `alice` with the password `PATCH` had just set
  (`a-new-strong-password-99`): `200 {"status":"signed_in","username":"alice"}`
  with a `Set-Cookie: bt_session=...`. Immediately retried with alice's
  **old** password (from creation, before the `PATCH`): `401 {"error":"Invalid
  username or password."}`, confirming the password change took effect.
  Logged in as `bob-disabled` (disabled via the admin `PATCH` above): `403
  {"error":"This account has been disabled."}` — confirming `isActive`
  toggled via the admin API is observed by the login path.

- **`bt_session` cookie never authorizes `/admin/users*`**: minted a real
  cookie via a successful `/auth/local-login` call, then presented `Cookie:
  bt_session=<jwt>` alone (no `Authorization` header) to both `GET
  /admin/users` and `POST /admin/users`: both returned `401
  {"error":"Unauthorized"}`.

- **Reachability regardless of `LOCAL_LOGIN`, both directions**: with
  `LOCAL_LOGIN=false` and `TENANT_ID=validation-tenant
  CLIENT_ID=validation-client` set (a second live service instance, same
  data directory, started only after the first was cleanly stopped and its
  lock file confirmed removed): `POST /auth/local-login` → `404
  {"error":"Not found"}` (as CONTRACT-005 §7 already established in
  TASK-015); `GET /admin/users` with the correct token → `200`, listing
  users created in the earlier `LOCAL_LOGIN=true` run (same underlying
  data); `POST /admin/users` with no token → `401`; `POST /admin/users` with
  the correct token → `201`, confirming the admin API is fully live and
  functional under `LOCAL_LOGIN=false`, not merely reachable-but-broken.

- **Wrong method under `/admin/users*` falls through to the generic 404**:
  `PUT /admin/users/00000000-0000-0000-0000-000000000000` with a correct
  token → `404 {"error":"Not found"}` (not a distinct "wrong method"
  response).

- **Audit trail — direct database inspection** (standalone PGlite
  connection against the stopped service's data directory, after both live
  runs above): exactly 21 `local_user_admin_audit` rows, matching every
  auth-gated attempt made across both runs one-for-one:
  - 10 `action='auth_failure'` rows (one per missing/wrong/malformed-token
    request across `POST`/`GET`(list)/`GET`(:id)/`PATCH`/`DELETE`, plus the
    two `bt_session`-cookie-alone attempts), every one `result='failure'`,
    `failure_reason='bad_credential'`, `target_user_id=null`,
    `target_username=null`.
  - 5 `action='create'` rows: 3 `result='success'` (alice, bob-disabled,
    carol — the third from the `LOCAL_LOGIN=false` run) and 2
    `result='failure', failure_reason='conflict'` (duplicate username,
    duplicate email), the successful rows correctly naming
    `target_user_id`/`target_username` and `actor_label='patrick-test'` on
    alice's row (the only create call that supplied `actedBy`).
  - 4 `action='update'` rows: 2 `result='success'` (`changed_fields`
    exactly `"isActive"` for bob-disabled and `"email,password"` for alice
    — confirming the field-name-only convention, never a value), 1
    `result='failure', failure_reason='conflict'` (the email-collision
    attempt), 1 `result='failure', failure_reason='not_found'` (the
    nonexistent-id attempt, `target_user_id` populated from the URL even
    though the row didn't exist).
  - 2 `action='delete'` rows: 1 `result='success'` (alice, with her
    username correctly recorded) and 1 `result='failure',
    failure_reason='not_found'` (the repeat delete).
  - Zero rows for any `GET` request (list or single), success or 404 —
    confirming reads are correctly excluded from the audited action set
    (see "Assumptions and deviations").
  - Confirmed `local_users` reflected exactly the expected final state
    (`alice` gone; `bob-disabled` present with `is_active=false`; `carol`
    present) — matching the audit trail's own account of what happened.

- **No secret/password/hash leakage**: grepped the full server logs from
  both live-service runs for the real `LOCAL_USER_ADMIN_TOKEN` value and
  every plaintext test password used — zero occurrences in either log (both
  logs contained only their startup line; no error path was exercised that
  would have logged anything). Visually inspected every captured HTTP
  response body across all cases above, and every audit row printed via the
  direct database inspection — none contain `password_hash`,
  `password_salt`, any password/hashing-parameter value, or the admin
  token. Confirmed `changed_fields` names the field `"password"` on a
  password-changing `update` row but never carries the password's value.

- **Clean shutdown / no lock leakage**: each of the three live-service
  instances started during this validation (two on the primary data
  directory sequentially, one earlier throwaway) was stopped via `pkill`
  and confirmed, via `ls`, to have removed
  `PGLITE_DATA_DIR/.btauthorchestrator.lock` before the next instance
  against the same directory was started.

### Acceptance criteria evidence

- [x] "Each of the five endpoints behaves per CONTRACT-005 §4/Interfaces,
  including exact status codes for conflicts (409) and not-found (404)." —
  confirmed for all five endpoints above: `201`/`200`/`404`/`409`/`400`/`401`
  all exercised with exact bodies matching CONTRACT-005's Failure behavior
  table and Interfaces section.
- [x] "A request with a missing/wrong `Authorization` header is rejected
  (401) regardless of `LOCAL_LOGIN`'s value." — confirmed under both
  `LOCAL_LOGIN=true` and `LOCAL_LOGIN=false` live runs.
- [x] "A valid `bt_session` cookie alone does not authorize any
  `/admin/users*` request." — confirmed directly above (`GET`/`POST`, both
  `401`).
- [x] "No response body, at any endpoint, ever includes a password hash or
  hashing parameter." — confirmed by inspection of every response body
  captured during validation; the public record shape
  (`LocalUserPublicRecord`) has no field capable of carrying one.
- [x] "Every action (success or failure) produces exactly one
  `local_user_admin_audit` row." — confirmed for every `create`/`update`/
  `delete`/`auth_failure` attempt (21 attempts, 21 rows, one-to-one) — see
  "Assumptions and deviations" for why a successful/404 `GET` does not
  itself produce a row, which is this task's reading of CONTRACT-005 §6
  rather than a shortfall against it.

All five of TASK-016's acceptance criteria are met under that reading.

### Assumptions and deviations

- **Successful/404 `GET` requests do not write a `local_user_admin_audit`
  row; only an auth failure on those endpoints does.** CONTRACT-005 §6
  states "every admin CRUD action — `create`, `update`, `delete` — and
  every admin-API authentication failure produces exactly one
  `local_user_admin_audit` row," and the schema's own `action` column
  (Required behavior §1) is `CHECK`-constrained to exactly
  `'create'`/`'update'`/`'delete'`/`'auth_failure'` — there is no value a
  "read" action could take. TASK-016's own file paraphrases this more
  loosely ("every action (success or failure) produces exactly one... row"),
  but per `AGENTS.md`'s instruction-precedence order, an approved contract
  ranks above the task's own acceptance-criteria wording where the two
  could be read to disagree; I followed the contract's more precise text
  and its schema literally. Flagged here explicitly rather than silently
  picked, since this is the one place the task brief and the contract could
  be read as being in tension.
- **Auth-check ordering relative to body reading.** For `POST`/`PATCH` (bodies
  carrying the optional `actedBy` label), I read and parse the body *before*
  checking the bearer token, mirroring `handleEmergencyRotateKeys`'s own
  choice to capture `triggeredBy` for the audit row even on an
  authentication failure (CONTRACT-003 precedent, and the task brief's
  explicit instruction to mirror that endpoint's style). For `GET`/`DELETE`
  (no body specified in Interfaces), I check the bearer token first, since
  reading a body that shouldn't exist buys nothing and costs an
  unnecessary read. Not explicitly specified either way by CONTRACT-005.
- **Validation-error responses on `POST`/`PATCH` are not separately
  audited.** A malformed body or a field that fails validation (bad
  username/email/password shape, missing required field, an attempted
  username rename) returns `400` without writing a
  `local_user_admin_audit` row. CONTRACT-005's Failure behavior table lists
  this case only as "Specific validation message naming the field" with no
  accompanying audit-row requirement (contrast with the adjacent rows for
  409/404/500, which explicitly mention the audit write); I read this as
  intentional — a request that never resolved to a concrete create/update
  target is closer to a client-side usage error than an auditable action
  attempt. A conflict (409), not-found (404), or unexpected database error
  (500) *is* audited, since those rows are explicitly named in the Failure
  behavior table.
- **PATCH rejects a `username` field outright (400) rather than silently
  ignoring it.** CONTRACT-005 confirms username is not renamable via
  `PATCH` but doesn't specify the exact response to an attempt. I chose an
  explicit `400` over silent ignoring so an operator who mistakenly sends
  `username` gets clear feedback rather than a silently-partial update.
- **Email format validation** (a loose `@`/`.`-shape regex plus a
  254-character cap) is an implementation judgment call — CONTRACT-005
  specifies username's exact character/length rules but does not specify an
  email format beyond "identity fields satisfying CONTRACT-001's claim
  shape." Not derived from any stated requirement; flagged the same way
  TASK-015 flagged its own body-size-cap judgment calls.
- **`createUser`'s conflict check is a pre-check inside the same
  transaction as the insert**, not a catch on the `UNIQUE` constraint
  violation itself — chosen to distinguish *which* field collided (username
  vs. email) without depending on parsing a PGlite/Postgres constraint-name
  error message, and to mirror the existing check-then-insert pattern
  `src/secrets.ts` already uses for `signing_keys`'s "one current key"
  invariant. The underlying `UNIQUE` constraints remain the actual
  atomicity backstop against a race between the pre-check and the insert.
- Did not touch `src/config.ts` — `LOCAL_USER_ADMIN_TOKEN`'s required/≥32-
  character validation was already complete from TASK-015; confirmed by
  reading `src/config.ts` before starting, per the task brief's explicit
  instruction not to re-add it.
- Did not implement `scripts/seed.js` changes (TASK-017) or the HTML login
  form (TASK-018), per this task's explicit exclusions.

### Unresolved risks

- **No automated regression test suite exists for this endpoint set**
  (`package.json` defines no test command beyond `build`, matching every
  prior task's validation methodology in this project) — validation above
  is live-HTTP and direct-database-inspection based, reproducible manually
  but not wired into CI. Same accepted posture as TASK-007/008/009/012/015.
- **The email-format regex is intentionally permissive** and has not been
  adversarially tested against RFC 5322 edge cases (quoted local parts,
  IP-literal domains, etc.) — reasonable for an internal admin tool
  provisioning test accounts, but worth revisiting if this API is ever
  exposed to a less-trusted operator population.
- **A race between `createUser`'s pre-check and its insert** (two
  concurrent `POST /admin/users` calls for the same username/email) is only
  guarded by the underlying `UNIQUE` constraints as a backstop, not
  explicitly tested under concurrency in this validation pass (unlike
  CONTRACT-003's endpoint, which TASK-009 explicitly load-tested for
  concurrent triggers) — CONTRACT-005 does not call out concurrent admin
  requests as a scenario requiring a specific guarantee, so this wasn't
  treated as a required test, but flagging the gap for completeness.

### Documentation updated

- `docs/DEVELOPMENT.md`: added the "Local user admin API (CONTRACT-005 §4,
  TASK-016)" subsection; updated the `LOCAL_USER_ADMIN_TOKEN` paragraph and
  the `LOCAL_LOGIN` mode-switch paragraph to reflect that the admin API now
  exists and is unaffected by that flag.

## Review

Not reviewed.
