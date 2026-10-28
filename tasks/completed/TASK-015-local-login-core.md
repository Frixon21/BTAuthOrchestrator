# TASK-015: Local login core — schema, password hashing, login endpoint, mode switch

Owner role: Implementer
Assigned agent: TBD (Codex/openai-coder normally; substituted this session
per Codex MCP being disconnected — confirm current status before dispatch)
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by: Patrick
Approved date: 2026-09-15
Related contracts: CONTRACT-005 (§1–§3, §7, §9, §10), CONTRACT-001
(`mintSessionToken`/cookie logic reused, not modified), CONTRACT-004
(`getCurrentSigningKey()` consumed, not modified)
Related ADRs: ADR-003
Dependencies: CONTRACT-005 approved (it is)

## Desired outcome

`POST /auth/local-login` exists and works end-to-end: a correct
username/password mints and sets a `bt_session` cookie byte-identical in
shape to CONTRACT-001's Entra path; wrong credentials, disabled accounts,
and locked accounts fail correctly and distinctly per CONTRACT-005 §2; and
`LOCAL_LOGIN` correctly gates this endpoint against CONTRACT-001's Entra
routes as a strict either/or switch.

## Context

This is the foundational piece of CONTRACT-005 — TASK-016 (admin CRUD),
TASK-017 (seed.js bootstrap), and TASK-018 (HTML form) all depend on the
schema and password-hashing path this task establishes. Deliberately scoped
to exclude the admin API, seed-script changes, and the HTML form so this
stays reviewable on its own.

## Scope

### Included

- `local_users` table (CONTRACT-005 §1's exact schema).
- scrypt password hashing per CONTRACT-005 §1's exact parameters, including
  the `maxmem` requirement.
- `POST /auth/local-login` per CONTRACT-005 §2: request/response shape,
  the two-tier enumeration-resistance scheme (merged unknown-username/
  wrong-password; distinct disabled/locked responses), and the uniform-cost
  timing mitigation.
- Brute-force protection per CONTRACT-005 §3: per-account lockout,
  per-source-IP throttle, all four thresholds configurable via the optional
  `.env` variables CONTRACT-005 specifies (`LOCAL_LOGIN_MAX_FAILED_ATTEMPTS`,
  `LOCAL_LOGIN_LOCKOUT_MINUTES`, `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`,
  `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES`).
- `local_login_audit` table and its writes (CONTRACT-005 §6, the
  local-login half only — not the admin-audit table, which is TASK-016's).
- The `LOCAL_LOGIN` mode switch itself (CONTRACT-005 §7): config.ts
  validation, and gating `POST /auth/local-login` vs. CONTRACT-001's
  `GET /auth/login`/`GET /auth/callback` as a strict either/or, both
  falling through to the existing generic 404 when inert.
- The `TENANT_ID`/`CLIENT_ID` conditional-requirement change (CONTRACT-005
  §10): required only when `LOCAL_LOGIN=false`.
- `mintSessionToken`/cookie-construction reuse per CONTRACT-005 §9 — call
  the existing function, do not reimplement it.
- `LOCAL_USER_ADMIN_TOKEN`'s config.ts validation (required, ≥32 chars) —
  the admin API itself is TASK-016's scope, but the env var and its
  startup validation belong here alongside `LOCAL_LOGIN`'s own validation,
  since both are config.ts changes.

### Excluded

- The admin CRUD API (`/admin/users*`) and `local_user_admin_audit` —
  TASK-016.
- `scripts/seed.js` changes — TASK-017.
- The HTML login form (`GET /auth/local-login`) — TASK-018.

## Plan

1. Add the `local_users` and `local_login_audit` tables to `database.ts`'s
   schema string.
2. Implement scrypt-based password hashing/verification (a new module or
   an addition to an existing one — implementer's call, document it).
3. Add `LOCAL_LOGIN`, `LOCAL_USER_ADMIN_TOKEN`, and the four optional
   threshold variables to `config.ts`, including the conditional
   `TENANT_ID`/`CLIENT_ID` requirement.
4. Implement `POST /auth/local-login` in `index.ts`: credential
   verification (§2), lockout/throttle (§3), audit write (§6), token
   minting via the existing `mintSessionToken` (§9).
5. Implement the `LOCAL_LOGIN` gating for both the new endpoint and
   CONTRACT-001's existing routes (§7).

## Acceptance criteria

- [x] A user created directly in the database (via a validation script —
      the admin API doesn't exist yet) can log in via `POST
      /auth/local-login` and receive a valid `bt_session` cookie.
- [x] Unknown username and wrong password produce identical 401 responses;
      disabled and locked accounts produce their own distinct responses
      (CONTRACT-005 §2's exact status codes/messages).
- [x] Ten consecutive wrong-password attempts lock the account; the
      configured lockout window is honored; a correct password after it
      passes succeeds and clears lockout state.
- [x] `LOCAL_LOGIN=true` makes CONTRACT-001's Entra routes fall through to
      generic 404; `LOCAL_LOGIN=false` makes `/auth/local-login` do the
      same — verified both directions.
- [x] `LOCAL_LOGIN=true` with `TENANT_ID`/`CLIENT_ID` absent from `.env`
      starts successfully.

## Validation requirements

Per CONTRACT-005's own Validation requirements section (the subset
applicable to this task's scope — excludes anything naming `/admin/users*`
or the HTML form).

## Risks and assumptions

None beyond CONTRACT-005 being approved (it is).

## Blocker

None.

## Implementation handoff

Task: TASK-015 — Local login core (schema, password hashing, login endpoint,
mode switch)
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
confirmed unreachable again this session; Patrick explicitly chose to keep
using this substitution rather than wait for it)
Date: 2026-09-15

### Changes made

- **`src/database.ts`**: added `local_users` and `local_login_audit` as new
  `CREATE TABLE IF NOT EXISTS` blocks inside the existing `schemaMigration`
  string, columns matching CONTRACT-005 §1's schema tables exactly (including
  `password_algorithm`/`password_cost_n`/`password_block_size_r`/
  `password_parallelization_p`/`password_key_length` as sibling columns
  rather than a packed string, and `result` `CHECK`s matching the existing
  `emergency_rotation_audit` convention). Did **not** add
  `local_user_admin_audit` — that table is TASK-016's scope, not this task's.
- **`src/password.ts`** (new module): scrypt password hashing/verification,
  kept deliberately separate from `src/secrets.ts`'s `SecretsStore` per
  CONTRACT-005's own reasoning (password hashes are one-way and never
  decrypted, so they don't use CONTRACT-004's AES-GCM envelope encryption —
  see the module's header comment and CONTRACT-005 Interfaces > "Interface to
  CONTRACT-004"). Documents the plan's step 2 ("a new module... implementer's
  call").
  - `hashPassword(password)`: fresh 16-byte salt (`crypto.randomBytes(16)`),
    current defaults `N=131072, r=8, p=1, keylen=64`.
  - `verifyPassword(candidate, stored)`: re-derives with the row's own
    stored salt/parameters and compares via `crypto.timingSafeEqual` (never
    `===`); throws if `stored.algorithm !== "scrypt"` (the only algorithm
    this task implements — see "Assumptions and deviations").
  - `deriveDummyHashForTimingParity()`: CONTRACT-005 §2 step 3's fixed,
    hardcoded, non-secret dummy salt/password derivation for the
    unknown-username case, at the same current-default parameters.
  - **The `maxmem` gotcha**: Node's `crypto.scrypt`/`scryptSync` is
    overloaded (with/without an options object), and `node:util`'s
    `promisify` resolves to the without-options overload's type — calling
    the promisified function with an options object (`{N, r, p, maxmem}`)
    fails to type-check. Worked around by wrapping the options-accepting
    callback overload directly in a `new Promise(...)`
    (`scryptWithOptions`), rather than `promisify`. `SCRYPT_MAXMEM_BYTES =
    268_435_456` (256 MiB, per CONTRACT-005 §1's requirement) is passed on
    every call, both hashing and verification.
- **`src/localUsers.ts`** (new module): `LocalUserStore` — `findByUsername`
  (normalized-lowercase lookup), `recordSuccessfulLogin` (resets
  `failed_login_attempts=0, locked_until=NULL`), `recordFailedPassword`
  (one transaction: increments `failed_login_attempts`, and if the new count
  reaches the configured threshold, sets `locked_until = now() + N minutes`
  in the same transaction), and `writeLoginAudit`. Deliberately outside
  `SecretsStore`'s boundary, same reasoning as `src/password.ts`.
- **`src/ipThrottle.ts`** (new module): `createIpThrottle(maxAttempts,
  windowMs)` — an in-memory, single-process, per-source-IP rolling-window
  failure counter, same class of mechanism (and same accepted
  resets-on-restart tradeoff) as `src/oidc.ts`'s `createHandshakeStore`.
- **`src/config.ts`**: rewritten to support CONTRACT-005 §10's conditional
  requirement.
  - `LOCAL_LOGIN` read and normalized (trim + case-fold to `"true"`/`"false"`)
    *before* deciding whether `TENANT_ID`/`CLIENT_ID` are required, per §10's
    explicit ordering requirement. `TENANT_ID`/`CLIENT_ID` are appended to
    the required-variables list only when `LOCAL_LOGIN` does not resolve to
    exactly `"true"` (see "Assumptions and deviations" for the one edge case
    this doesn't unambiguously resolve: `LOCAL_LOGIN` itself missing/invalid).
  - Added `LOCAL_LOGIN` (exactly `"true"`/`"false"` case-insensitively, no
    implicit default — validated the same way `EMERGENCY_ROTATION_TOKEN`'s
    format is) and `LOCAL_USER_ADMIN_TOKEN` (required, ≥32 characters, same
    pattern as `EMERGENCY_ROTATION_TOKEN`) as always-required variables.
  - Added the four optional, validated-if-present, defaulted-if-absent
    brute-force variables (`LOCAL_LOGIN_MAX_FAILED_ATTEMPTS`,
    `LOCAL_LOGIN_LOCKOUT_MINUTES`, `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`,
    `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES`; defaults `10`/`15`/`20`/`5`) via
    a shared `parseOptionalPositiveInteger` helper (base-10, no sign, no
    decimal point, strictly positive — same posture already applied to
    `PORT`).
  - `Config.tenantId`/`clientId` are now `""` rather than `undefined` when
    `LOCAL_LOGIN=true` and the variables are absent (never read/dereferenced
    by any code path in that mode).
- **`src/index.ts`**:
  - `POST /auth/local-login` (`handleLocalLogin`): IP-throttle check first
    (§2 step 1) → body parse/validate (400 if malformed, no audit row) →
    normalized-username lookup → uniform-cost scrypt derivation (real
    verification if found, `deriveDummyHashForTimingParity()` if not,
    regardless of active/locked state) → outcome decided in the exact §2
    step 4 precedence (not-found → locked → disabled → bad-password →
    success) → per-account side effects (`recordFailedPassword` only on
    `bad_password`; `recordSuccessfulLogin` on success; locked/disabled leave
    state untouched) → one best-effort `local_login_audit` row → IP-throttle
    failure recorded for any non-success outcome → response. Success mints
    via the existing `mintSessionToken` and the existing
    `buildSetCookieHeader` (both unmodified, called exactly as CONTRACT-001's
    callback handler already does — CONTRACT-005 §9).
  - `GET /auth/login` and `GET /auth/callback` gated behind
    `config.localLogin === false`; the new route gated behind
    `config.localLogin === true` — both fall through to the existing,
    unmodified generic `404 {"error":"Not found"}` when inert. `GET /health`,
    `GET /.well-known/jwks.json`, and `POST /admin/emergency-rotate-keys` are
    unmodified and ungated, per §7.
  - `readRequestBody` generalized to take an explicit `limitBytes` parameter
    (previously hardcoded to `EMERGENCY_ROTATION_BODY_LIMIT_BYTES`); the
    emergency-rotation call site now passes that constant explicitly, and
    local-login uses its own `LOCAL_LOGIN_BODY_LIMIT_BYTES` (16 KiB, same
    defensive-cap posture as the existing constant, not contract-specified —
    see "Assumptions and deviations"). No behavior change for the
    emergency-rotation path.
  - `createRequestHandler` gained a third parameter, `localUserStore:
    LocalUserStore`; `start()` constructs it via `createLocalUserStore
    (databaseHandle.database)` alongside the existing `secretsStore`.
  - Deliberately **not** implemented (out of this task's scope): `GET
    /auth/local-login` (HTML form, TASK-018) and `/admin/users*` (TASK-016)
    — both currently 404 regardless of `LOCAL_LOGIN`'s value, which is
    expected and unrelated to the mode-switch gating this task implements.
- **`src/verify-offline.ts`**: mechanical fix only — `createRequestHandler`'s
  new required third parameter meant this pre-existing TASK-010 script no
  longer compiled. Added a `createLocalUserStore(handle.database)` call and
  passed it through. No behavior change to the script's own logic; not part
  of this task's assigned scope, but required for `npm run build` to pass at
  all with the new signature.
- **`.env.example`**: documented `LOCAL_USER_ADMIN_TOKEN` and the four
  optional threshold variables (commented out, showing their defaults);
  updated the `TENANT_ID`/`CLIENT_ID`/`LOCAL_LOGIN` comments for the new
  conditional-requirement behavior; changed the example `LOCAL_LOGIN` value
  from `True` to `false` per CONTRACT-005 "Resolved decisions" #7 (the
  recommended/example default is Entra-only).
- **`docs/DEVELOPMENT.md`**: updated the required-variables paragraph, added
  a `LOCAL_USER_ADMIN_TOKEN` paragraph, added a new "Local username/password
  login (CONTRACT-005)" subsection describing the mode switch, the endpoint,
  password hashing, and brute-force protection, and updated the repository
  layout list for the three new `src/` modules.

### Validation performed

This sandbox session permits live socket binding (confirmed directly with a
throwaway `net.createServer().listen(0, "127.0.0.1", ...)` probe before
relying on it, same check TASK-009's session made). All HTTP validation
below therefore used the real compiled service (`dist/index.js`) over a real
loopback socket, not the exported-handler fallback.

- `npm run build`: TypeScript compiled cleanly with no errors, both after
  the initial implementation and again after every subsequent edit
  (including the `src/verify-offline.ts` fix).

- **scrypt `maxmem` requirement** (isolated, outside the HTTP layer):
  ```
  $ node --input-type=module -e '... hashPassword("correct horse battery staple") ...'
  N,r,p,maxmem: 131072 8 1 268435456
  hashPassword ok, elapsedMs= 297 hashLen= 64 saltLen= 16
  verify correct password: true elapsedMs= 313
  verify wrong password: false elapsedMs= 293
  dummy derivation elapsedMs= 313
  ```
  Confirmed the gotcha is real by calling Node's raw `crypto.scrypt` with the
  same `N/r/p` and **no** `maxmem` override:
  ```
  RangeError: Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded
  code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS'
  ```
  This is exactly the failure CONTRACT-005 §1 warns about; `src/password.ts`
  avoids it by always passing `maxmem: 268_435_456`.

- **Per-user salting / no-plaintext-leakage** (direct DB inspection): created
  two users (`alice`, `dave-samepassword`) with the identical password.
  `password_hash`/`password_salt` differed between them
  (`same password_hash across two users with identical password? false`,
  `same salt across two users? false`), and `alice`'s stored hash bytes did
  not contain the plaintext password
  (`alice hash contains plaintext password bytes? false`).

- **End-to-end setup**: fresh scratch `PGLITE_DATA_DIR`, `chmod 700`, seeded
  via `node dist/seed.js --client-secret-file=...` with `LOCAL_LOGIN=true`
  and `TENANT_ID`/`CLIENT_ID` **absent** from the environment — the seed
  script (which calls `loadConfig`) completed successfully:
  ```
  CLIENT_SECRET stored.
  Signing key d4776fc5-4e34-4be9-82ad-e9705ca37210 generated and stored as current.
  EXIT_CODE=0
  ```
  Then inserted `local_users` rows directly via a validation script calling
  `hashPassword` (the admin API doesn't exist yet, per this task's own
  scope note): `alice` (active), `bob-disabled` (`is_active=false`),
  `carol-lockout` and `erin-custom` (active, used for lockout tests below).

- **Live service startup, `LOCAL_LOGIN=true`, `TENANT_ID`/`CLIENT_ID`
  absent**: `node dist/index.js` (all required vars present except
  `TENANT_ID`/`CLIENT_ID`) printed `BTAuthOrchestrator listening on port
  41999` and stayed running — confirmed again standalone with `env -u
  TENANT_ID -u CLIENT_ID ... timeout 1 node dist/index.js`, which printed the
  same startup line and was still running when the timeout's `SIGTERM`
  triggered a clean shutdown (lock file removed afterward, confirmed via
  `ls`).

- **Two-tier response scheme, exact status/body per outcome** (real `curl`
  against the live service):
  - Correct credentials (`alice`): `HTTP/1.1 200 OK`, `Set-Cookie: bt_session=...`,
    body `{"status":"signed_in","username":"alice"}`.
  - Wrong password (`alice`) and unknown username (`nosuchuser`): both
    `HTTP/1.1 401 Unauthorized`, identical body
    `{"error":"Invalid username or password."}`.
  - Disabled (`bob-disabled`): `HTTP/1.1 403 Forbidden`,
    `{"error":"This account has been disabled."}`.
  - Locked (after triggering lockout, see below): `HTTP/1.1 423 Locked`,
    `{"error":"This account is temporarily locked. Try again after
    2026-09-15T23:26:52.304Z."}` — exact ISO 8601 `locked_until`.
  - Malformed body (missing `password`): `HTTP/1.1 400 Bad Request`,
    `{"error":"username and password are required"}`. Also exercised: empty
    body, a JSON array body, invalid JSON, and `username` as a number — all
    four produced the identical 400, and none produced a
    `local_login_audit` row (confirmed by direct row count/content
    inspection before and after).
  - Username normalization: `"  ALICE  "` (mixed case, surrounding
    whitespace) matched the stored `alice` row and succeeded, confirming
    trim + lowercase normalization at lookup time.

- **Token shape and offline verification**: decoded the `Set-Cookie` JWT
  locally — header `{"alg":"RS256","kid":"d4776fc5-..."}`, payload exactly
  `{"sub":"329ee2cd-...","email":"alice@example.invalid","upn":"alice",
  "iat":...,"exp":...,"iss":"https://test-issuer.example.invalid"}` (six
  claims, sorted keys `[email, exp, iat, iss, sub, upn]`, `sub` equal to the
  created user's `id`, `upn` equal to the created user's `username`). Then
  verified it against the **live** `GET /.well-known/jwks.json` using
  `jose`'s `createRemoteJWKSet` + `jwtVerify`: verification succeeded and
  returned the identical header/payload.

- **Lockout, default threshold (`LOCAL_LOGIN_MAX_FAILED_ATTEMPTS=10`,
  `LOCAL_LOGIN_LOCKOUT_MINUTES=15`, both unset — defaults applied)**: 10
  consecutive wrong-password attempts against `carol-lockout` each returned
  `401`; the 11th attempt, using the **correct** password, returned `423`
  naming `locked_until` exactly 15 minutes after the 10th attempt
  (`23:11:52` attempt → `Try again after 2026-09-15T23:26:52.304Z`). A
  further wrong-password attempt during the lockout window returned the
  identical `423` with the **same** `locked_until` (confirming lockout state
  is not extended by attempts made while already locked). Stopped the
  service, directly patched `carol-lockout.locked_until` to one minute in
  the past (simulating the window elapsing — waiting 15 real minutes was
  impractical; documented as a validation technique, not a source change),
  restarted the service, and confirmed the correct password now succeeded
  (`200`) and cleared both fields:
  ```
  post-success row: { username: 'carol-lockout', failed_login_attempts: 0, locked_until: null }
  ```

- **Lockout, configured threshold** (`LOCAL_LOGIN_MAX_FAILED_ATTEMPTS=3`,
  `LOCAL_LOGIN_LOCKOUT_MINUTES=7`): 3 consecutive wrong-password attempts
  against a fresh user (`erin-custom`) locked the account; the 4th attempt
  (correct password) returned `423` naming `locked_until` exactly 7 minutes
  later (`23:12:52` → `2026-09-15T23:19:52.166Z`) — confirming both
  configured values took effect instead of the defaults.

- **Per-source-IP throttle, configured threshold**
  (`LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS=5`,
  `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES=2`, same run as above): the 3
  account-lockout attempts plus one locked-account attempt plus one
  unknown-username attempt (5 failed attempts total from one source IP)
  were followed by a 6th attempt returning `HTTP/1.1 429 Too Many Requests`,
  `{"error":"Too many sign-in attempts. Try again later."}`. A concurrent
  request bearing `X-Forwarded-For: 203.0.113.55` (a different source IP)
  succeeded normally (`200`), confirming the throttle is per-IP, not global.

- **Invalid brute-force `.env` values fail closed at startup** (each tested
  independently): `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS=0`,
  `LOCAL_LOGIN_LOCKOUT_MINUTES=-1`, `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS=abc`,
  and `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES=2.5` each produced
  `Configuration error: invalid environment variable(s): <NAME> (must be a
  positive integer)`, exit code 1.

- **`LOCAL_LOGIN` startup validation and conditional `TENANT_ID`/`CLIENT_ID`
  requirement** (each tested independently, `TENANT_ID`/`CLIENT_ID` unset in
  all these runs):
  - `LOCAL_LOGIN` unset entirely: `Configuration error: missing required
    environment variable(s): LOCAL_LOGIN, TENANT_ID, CLIENT_ID`.
  - `LOCAL_LOGIN=yes` (invalid value): `Configuration error: missing
    required environment variable(s): TENANT_ID, CLIENT_ID; invalid
    environment variable(s): LOCAL_LOGIN (must be exactly "true" or
    "false", case-insensitive)`.
  - `LOCAL_USER_ADMIN_TOKEN` unset: `Configuration error: missing required
    environment variable(s): LOCAL_USER_ADMIN_TOKEN`.
  - `LOCAL_USER_ADMIN_TOKEN` set to 31 characters: `Configuration error:
    invalid environment variable(s): LOCAL_USER_ADMIN_TOKEN (must be at
    least 32 characters)`.
  - `LOCAL_LOGIN=false` with `TENANT_ID`/`CLIENT_ID` unset: `Configuration
    error: missing required environment variable(s): TENANT_ID, CLIENT_ID`
    — unchanged from pre-existing behavior.
  - `LOCAL_LOGIN=true` with `TENANT_ID`/`CLIENT_ID` unset: starts
    successfully (see "Live service startup" above).

- **`LOCAL_LOGIN` gating, both directions, live HTTP**:
  - `LOCAL_LOGIN=true`: `GET /auth/login` → `404 {"error":"Not found"}`;
    `GET /auth/callback?state=x&code=y` → `404 {"error":"Not found"}`;
    `GET /auth/local-login` → `404` (expected — TASK-018's scope, not
    implemented here); `POST /auth/local-login` → live (tested extensively
    above); `GET /health` → `200 {"status":"ok"}`; `GET
    /.well-known/jwks.json` → `200` with keys.
  - `LOCAL_LOGIN=false` (fresh run, `TENANT_ID=validation-tenant
    CLIENT_ID=validation-client`): `POST /auth/local-login` → `404
    {"error":"Not found"}`; `GET /auth/login` → `502 {"...Unable to reach
    the organization's sign-in service..."}` — confirming the route **is
    live** (reached `handleLogin`, attempted a real Entra discovery fetch
    against the fake tenant ID, and failed for the expected
    Entra-unreachable reason per CONTRACT-001, not a 404) rather than
    gated off; `GET /health` → `200`.
  - Confirmed via direct database inspection that the `404` `POST
    /auth/local-login` attempt under `LOCAL_LOGIN=false` wrote **no**
    `local_login_audit` row (row count unchanged across that request).
  - `POST /admin/emergency-rotate-keys` with the correct
    `EMERGENCY_ROTATION_TOKEN` returned `200` in a `LOCAL_LOGIN=true` run,
    confirming CONTRACT-003's endpoint is unaffected by this task's
    changes.

- **Timing-mitigation spot check** (5 samples per outcome, real HTTP,
  `curl -w "%{time_total}"`, same live service instance, same
  `local_users` rows as above):
  ```
  unknown_username:        0.352 0.368 0.325 0.269 0.270 s
  bad_password (alice):    0.307 0.292 0.287 0.287 0.286 s
  disabled (bob-disabled): 0.303 0.289 0.306 0.279 0.284 s
  locked (erin-custom):    0.277 0.296 0.294 0.308 0.285 s
  ```
  All four outcomes cluster in the same ~0.27–0.37 s range (scrypt-dominated
  cost), with unknown_username/bad_password overlapping and
  disabled/locked in the same range — consistent with CONTRACT-005 §2
  step 3's uniform-cost computation running to completion for all four
  causes before the outcome (and thus the response content) diverges. This
  is a small-sample sanity check, not a rigorous statistical timing-attack
  analysis; see "Unresolved risks."

- **No secret/credential/hash leakage**: grepped every server log line
  produced across this entire validation session for the real
  `LOCAL_USER_ADMIN_TOKEN` value, the real `EMERGENCY_ROTATION_TOKEN` value,
  and every plaintext test password used (`correct horse battery staple`,
  `erins-strong-password-3`, `another-strong-password-1`, `yet-another-
  strong-pw-2`) — zero occurrences of any of them. Visually inspected every
  captured HTTP response body across all cases above — none contain
  `password_hash`, `password_salt`, or any password/hashing-parameter value.

- **Clean shutdown / no lock leakage**: every service instance started
  during this validation was stopped via `kill <pid>` (or a `timeout`-
  delivered `SIGTERM`) and confirmed to remove
  `PGLITE_DATA_DIR/.btauthorchestrator.lock` before the next instance was
  started against the same directory; no stale-lock recovery was ever
  needed.

### Acceptance criteria evidence

- [x] "A user created directly in the database... can log in via `POST
  /auth/local-login` and receive a valid `bt_session` cookie." — `alice`,
  `carol-lockout`, and `erin-custom` all logged in successfully via rows
  inserted directly through `hashPassword`, each receiving a `Set-Cookie:
  bt_session=...` that decoded to the correct six claims and verified
  against the live JWKS endpoint.
- [x] "Unknown username and wrong password produce identical 401
  responses; disabled and locked accounts produce their own distinct
  responses." — confirmed exact status codes/bodies for all four outcomes,
  live HTTP, above.
- [x] "Ten consecutive wrong-password attempts lock the account; the
  configured lockout window is honored; a correct password after it passes
  succeeds and clears lockout state." — confirmed at both the default
  threshold (10/15) and a configured threshold (3/7); confirmed the
  simulated-elapsed-window recovery clears `failed_login_attempts`/
  `locked_until`.
- [x] "`LOCAL_LOGIN=true` makes CONTRACT-001's Entra routes fall through to
  generic 404; `LOCAL_LOGIN=false` makes `/auth/local-login` do the same —
  verified both directions." — confirmed live, both directions, above,
  including confirming the `LOCAL_LOGIN=false` case's `GET /auth/login` is
  genuinely live (reaches Entra discovery) rather than merely
  coincidentally also erroring.
- [x] "`LOCAL_LOGIN=true` with `TENANT_ID`/`CLIENT_ID` absent from `.env`
  starts successfully." — confirmed via both `scripts/seed.js` and
  `dist/index.js` directly.

All five of TASK-015's own acceptance criteria are met. Additional
CONTRACT-005 validation-requirements items in this task's scope (brute-force
threshold configurability, IP-throttle behavior, invalid-threshold
startup failures, no-secret-leakage, per-user salting) were also exercised,
per "Validation performed" above.

### Assumptions and deviations

- **`LOCAL_LOGIN` itself missing/invalid and `TENANT_ID`/`CLIENT_ID`
  requiredness.** CONTRACT-005 §10 says configuration loading "reads
  `LOCAL_LOGIN` before evaluating whether `TENANT_ID`/`CLIENT_ID` are
  required," but doesn't state what "required" resolves to when
  `LOCAL_LOGIN` itself fails to resolve to a valid `true`/`false` value (a
  separate, already-fatal startup error on its own). I made the narrowest
  conservative call: treat `TENANT_ID`/`CLIENT_ID` as still required in that
  case, preserving the project's default fail-closed posture rather than
  guessing intent from a value that isn't valid. This only changes the
  aggregated error message's contents in an already-failing startup path
  (the process fails closed either way); it never changes behavior when
  `LOCAL_LOGIN` is validly set. Flagged here rather than silently decided,
  since CONTRACT-005 doesn't explicitly resolve this edge case.
- **IP-throttle "failed attempt" scope.** CONTRACT-005 §3 says the per-IP
  throttle "tracks failed `/auth/local-login` attempts... over a rolling
  window" without enumerating which of the four failure causes count. I
  treated all four non-success outcomes (`unknown_username`, `bad_password`,
  `disabled`, `locked`) as "failed attempts" for this coarse,
  resource-protection counter — reasoning that its purpose (stopping a
  spray across many usernames from one source) is orthogonal to which
  specific per-account outcome each guess produced. A malformed-body 400 is
  explicitly **not** counted (it occurs before the throttle-adjacent
  credential-verification flow even begins reading the body meaningfully —
  consistent with "no user lookup, no hashing" for the throttle check
  itself, which happens first).
- **Order of the IP-throttle check relative to body validation.**
  CONTRACT-005 §2 lists "check the per-source-IP throttle" as step 1 of
  "credential verification, in order, every time," textually before body
  parsing is mentioned. I implemented the throttle check as the literal
  first thing `handleLocalLogin` does, before even attempting to read/parse
  the request body — so a throttled IP gets `429` even for a request that
  would otherwise be a malformed-body `400`. This reading seemed the more
  defensible one (an already-throttled IP gets no further processing of any
  kind) but the contract doesn't explicitly test this specific interleaving.
- **A request with no determinable source IP** (`request.socket.remoteAddress`
  absent and no `X-Forwarded-For`) is bucketed under a fixed `"unknown"` key
  in the IP throttle rather than bypassing it — not expected in normal
  operation (a real TCP socket always has a peer address), but a defensive
  default rather than an unthrottled path.
- **`LOCAL_LOGIN_BODY_LIMIT_BYTES` (16 KiB)** is an implementation judgment
  call, not contract-specified — same posture as the pre-existing
  `EMERGENCY_ROTATION_BODY_LIMIT_BYTES`, which this change generalized
  `readRequestBody` to parameterize on rather than duplicating.
  Exceeding it is treated as the same `400` outcome as any other malformed
  body (never a `500`), since the endpoint's body is load-bearing
  (credentials), unlike the emergency-rotation endpoint's fully-optional
  body.
- **`password_algorithm` allow-list enforcement.** `verifyPassword` throws
  if a row's `password_algorithm` is anything other than `"scrypt"` (this
  task implements only scrypt). No code path in this task's scope can
  create such a row, so this is a defensive assertion, not a designed
  failure mode — but per CONTRACT-005 §8 ("every failure path renders a
  plain JSON error body, never an unhandled exception"), `handleLocalLogin`
  wraps the entire lookup/verify/side-effect/audit sequence (everything
  between body validation and the outcome being decided) in a single
  try/catch that maps any unexpected error — including this guard, and any
  database error from `localUserStore` — to the same generic
  `500 {"error":"Something went wrong signing you in; this has been
  logged."}`, logging the real error server-side only. This was verified by
  re-running the full success/401/403/400 smoke test after adding the
  try/catch to confirm no regression.
- **`src/verify-offline.ts`** required a mechanical one-line fix (passing
  the new `localUserStore` argument) purely to keep `npm run build` passing;
  this is outside TASK-015's assigned scope but unavoidable given
  `createRequestHandler`'s signature change. No behavior change to that
  script.
- Did not touch `scripts/seed.js`/`src/seed.ts` (TASK-017's scope) or
  attempt any `/admin/users*` implementation (TASK-016's scope), per the
  task's explicit exclusions.

### Unresolved risks

- **Timing-mitigation validation is a small-sample spot check (5 samples
  per outcome via `curl`), not a rigorous statistical analysis.** The
  samples show no reliably exploitable difference within this sandbox's
  noise floor, but a determined attacker's timing-attack feasibility over a
  real network path (with its own jitter, but also potentially thousands of
  samples and statistical averaging) was not evaluated. This matches
  CONTRACT-005 §2's own design intent (equal-cost computation) but a formal
  timing-attack audit is a materially larger effort than this task's
  validation window; flagging as an unresolved risk rather than claiming a
  stronger guarantee than what was actually measured.
- **The per-IP throttle and per-account lockout are both in-memory/DB-row
  state with no coordination beyond the single-process constraint the
  wider project already assumes** — unchanged from the existing
  handshake-store precedent, but worth restating: a process restart clears
  the IP-throttle counters (accepted tradeoff, stated in CONTRACT-005 §3),
  while per-account lockout state (`local_users.locked_until`) survives a
  restart since it's persisted.
- **No admin API yet to create/manage local users** (TASK-016) means the
  only way to exercise this endpoint today is direct database insertion via
  `hashPassword`, as this validation did. This is expected per the task's
  own scope note, not a gap in this task's own deliverable, but it does mean
  end-to-end testing without TASK-016/017 requires hand-rolled setup scripts
  each time.

### Documentation updated

- `.env.example`: documented `LOCAL_USER_ADMIN_TOKEN` and the four optional
  brute-force variables (with their defaults, commented out); updated
  `TENANT_ID`/`CLIENT_ID`/`LOCAL_LOGIN` comments for the conditional
  requirement and exact-`"true"`/`"false"` validation; corrected the example
  `LOCAL_LOGIN` value to `false` (CONTRACT-005's recommended default).
- `docs/DEVELOPMENT.md`: updated the required-variables paragraph and
  repository-layout list; added a `LOCAL_USER_ADMIN_TOKEN` paragraph; added
  a new "Local username/password login (CONTRACT-005)" subsection covering
  the mode switch, the endpoint's request/response/failure shape, password
  hashing, and both brute-force-protection layers.

## Review

Not reviewed.
