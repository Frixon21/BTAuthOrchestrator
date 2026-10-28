# CONTRACT-005: Local username/password login and user management

Status: Approved
Approved by: Patrick
Approved date: 2026-09-15
Related tasks: None yet for a dedicated implementation task covering this
contract as a whole. TASK-006 (CONTRACT-004's bootstrap/seed script) is
referenced because Required behavior §5 extends its idempotent seeding
pattern to also provision the first local user — this contract does not
modify CONTRACT-004's own text, only adds a new seeding step to TASK-006's
script alongside it. This contract was commissioned directly by Patrick in
conversation (2026-09-15) rather than from an existing task file — he decided
live that a permanent local-login path and an HTTP user-admin API are wanted,
and asked for a contract to be drafted directly against that direction. Per
`CLAUDE.md` ("do not begin implementation without an approved task"), a task
file translating this contract into an implementation plan still needs to be
filed and approved before any of this is built; this contract does not itself
authorize implementation.
Related ADRs: ADR-003 (records the architectural decision to add a
permanent local-login path alongside Entra; this contract is its full
behavioral specification).
Supersedes:
Superseded by: CONTRACT-006 for HTTP creation authorization and the prohibition
on self-service registration only; CONTRACT-009 for the self-service
password-change exclusion and browser admin UI exclusion (password-reset
page only); CONTRACT-010 for the browser admin UI exclusion (admin console
at /admin/console); CONTRACT-011 for §4's token-only authorization of
/admin/users* (an active local user's session is also accepted) and §6's actor
recording on admin audit rows; CONTRACT-008 (OQ-8) for §5's input-channel
sentence, in container first-boot mode only; CONTRACT-012 for how
`source_ip` is derived and which address §3's per-IP throttle counts. All
other sections remain in force.

## Purpose

Define, precisely enough to implement without further architectural
decisions, a permanent local username/password login path that mints a
BTAuthOrchestrator session token and cookie byte-identical in shape to
CONTRACT-001's Entra-issued token, plus an HTTP admin API for creating,
listing, updating, and disabling/deleting the local user records this login
path authenticates against.

This exists so the system can be exercised end-to-end — by both automated
tests and real people during testing — without depending on a live,
interactively-driven Entra OIDC flow. Per Patrick's explicit direction, this
is a **permanent** addition that coexists with Entra once Entra work resumes,
built with the same rigor as the rest of this project — not throwaway test
scaffolding, and not a design this contract treats as needing to relitigate
NOTES.md §3's original Entra-vs-local-accounts reasoning. That reasoning
still holds for why Entra is the org's primary identity source; this contract
adds a second, parallel front door for a different purpose (testability), not
a replacement. "Coexists" describes the codebase/capability, not simultaneous
runtime reachability: per Required behavior §7, exactly one of the two login
paths is live in a given running instance at a time, governed by the
`LOCAL_LOGIN` mode switch — this is a permanent *option* the service
supports, not a permanently-simultaneous pair of live front doors.

This contract treats the following as settled, per direct instruction:
- The local-login path must mint the exact same `bt_session` token shape
  CONTRACT-001 defines, via the same `mintSessionToken` function, so nothing
  downstream (JWKS, consuming-app verification) needs to know or care which
  path minted a given token.
- User CRUD is exposed via an HTTP admin API, not a CLI-only tool, for every
  operation except the very first local user's bootstrap provisioning,
  which — per Patrick's later decision, §5 — does extend `scripts/seed.js`.
- Real, non-stub password hashing is required.
- User creation is admin/operator-driven; there is no self-service signup
  flow, consistent with NOTES.md §2's "no external/self-service user"
  constraint.

## Scope

### Included

- Schema for local user records: identity fields satisfying CONTRACT-001's
  claim shape, password hash storage, and an active/disabled flag.
- The password hashing scheme: algorithm, parameters, and storage format.
- The local-login endpoint: request/response shape and failure behavior,
  including which of "unknown user," "wrong password," "disabled," and
  "locked" are distinguishable to the caller (a two-tier scheme — see
  Required behavior §2).
- Brute-force/credential-stuffing protection on the local-login endpoint:
  per-account lockout, a coarse per-source-IP throttle, and a timing-based
  mitigation against username enumeration via response latency.
- The admin CRUD API: endpoints, request/response shapes, and its own
  authorization mechanism (a dedicated bearer credential, distinct from
  CONTRACT-003's `EMERGENCY_ROTATION_TOKEN`).
- How the very first local user is provisioned (the bootstrap
  chicken-and-egg problem).
- An audit trail for local-login attempts and for admin CRUD actions.
- Whether/how this entire capability can be disabled in a given deployment.
- This contract's relationship to CONTRACT-001 (token minting/cookie reuse)
  and CONTRACT-004 (storage conventions, explicitly not reused for password
  hashing; and the `scripts/seed.js` bootstrap extension — see "Interfaces").
- A minimal, unstyled HTML login form (`GET /auth/local-login`), a thin
  client-side wrapper around the JSON `POST /auth/local-login` endpoint with
  no server-side logic of its own — see Required behavior §11.

### Excluded

- Any change to CONTRACT-001's or CONTRACT-004's own text, schema, or
  interfaces. Both are referenced as-is; neither is edited (CONTRACT-004 is
  `Proposed`, not yet approved, and CONTRACT-001 is `Approved` and therefore
  immutable per ADR-001 regardless).
- Self-service signup, password reset via email, "must change password on
  first login," or any invite-link flow — all excluded per NOTES.md §2's
  no-external-user, admin-driven-only framing. Not designed here; flagged in
  Open questions only where the absence is a genuine judgment call.
- Per-user session revocation (killing an already-issued token before its
  natural `exp`). Disabling a local user prevents *future* logins only; an
  already-minted token for that user remains valid until its midnight-local
  expiry, the same accepted bound CONTRACT-001/CONTRACT-003 already establish
  for the Entra path. Immediate global revocation remains CONTRACT-003's
  emergency-rotation "kill switch," unchanged and out of scope here.
- Any browser-rendered **admin** UI. The admin CRUD API remains JSON-only,
  consistent with CONTRACT-003's "no browser-facing admin UI" precedent. (A
  minimal HTML *login* form now exists — see Included above and Required
  behavior §11 — but no equivalent is provided for user administration.)
- Rotating `DB_ENCRYPTION_KEY` or any other concern already scoped to
  CONTRACT-004; this contract adds new tables alongside CONTRACT-004's but
  does not touch its envelope-encryption machinery (see Interfaces for why).
- Migration ownership (which task/tool applies the schema below) — not
  prescribed here, same posture as CONTRACT-003's Open question #8.

## Actors

- **Local test user** — a person (or an automated test harness acting as
  one) authenticating with a username and password instead of interactively
  through Entra. Not synonymous with any Entra identity; a local user record
  and an Entra account are entirely independent, even if the same human holds
  both.
- **User-admin operator** — a human (initially Patrick) who possesses the
  dedicated `LOCAL_USER_ADMIN_TOKEN` credential and uses it to create, list,
  update, or delete local user records via the admin API.
- **BTAuthOrchestrator process** — authenticates local-login attempts,
  authenticates admin-API requests, performs password verification, mints
  session tokens (via CONTRACT-001's existing `mintSessionToken`), and writes
  audit records.
- **CONTRACT-004 storage layer** (indirect actor) — supplies
  `getCurrentSigningKey()`, unchanged, for token minting. This contract's own
  new tables (`local_users`, `local_login_audit`, `local_user_admin_audit`)
  live in the same PGlite database but are not part of CONTRACT-004's
  `SecretsStore` interface — see Interfaces.
- **Consuming apps** (indirect) — unaffected. They verify `bt_session`
  exactly as CONTRACT-001 already defines, with no visibility into or
  dependency on which login path minted a given token.

## Inputs and outputs

**Inputs:**
- `LOCAL_USER_ADMIN_TOKEN` (from `.env`) — the admin API's dedicated bearer
  credential.
- `LOCAL_LOGIN` (from `.env`) — the mode-switch flag governing whether
  `/auth/local-login` or CONTRACT-001's Entra routes are the live login path
  (Required behavior §7). Confirmed by Patrick directly as the canonical
  name (matching the tracked `.env.example`); the real, git-ignored `.env`'s
  `ALLOW_LOCAL` was a stale/mistaken value he will correct separately, not a
  competing canonical name.
- `POST /auth/local-login` request body: `{ "username": string, "password":
  string }`.
- `POST /admin/users`, `PATCH /admin/users/:id` request bodies carrying
  `username`/`email`/`password`/`isActive`/optional `actedBy` fields (see
  Interfaces for exact shapes per endpoint).
- The current RS256 signing key, obtained via CONTRACT-004's
  `getCurrentSigningKey()` — unchanged, same call CONTRACT-001's callback
  handler already makes.

**Outputs:**
- On successful local login: the identical class of response CONTRACT-001's
  callback produces on success — a `bt_session` cookie (via the same
  `mintSessionToken` call and cookie-construction logic) plus a minimal JSON
  confirmation that never includes the token value.
- On admin-API success: a JSON representation of the affected user record
  (id, username, email, active flag, timestamps) — **never** a password hash
  or any hashing parameter.
- Durable audit records for every local-login attempt (success or failure)
  and every admin CRUD action (success or failure), per Required behavior §6.
- On any failure: a clear, generic, non-revealing JSON error response,
  status-coded per the taxonomy in Failure behavior — never a raw exception
  or stack trace, matching CONTRACT-001's and CONTRACT-003's existing
  posture.

## Preconditions

- `LOCAL_USER_ADMIN_TOKEN` is present in `.env`, non-empty, and at least 32
  characters — same format/length rule as CONTRACT-003's
  `EMERGENCY_ROTATION_TOKEN`, and deliberately a **separate** value from it
  (see Required behavior §4 for the least-privilege reasoning). If absent or
  too short, the process fails closed at startup.
- `LOCAL_LOGIN` is present in `.env` and, after trimming and case-folding,
  equals exactly `"true"` or `"false"` — required, like every other variable
  in `config.ts`'s `requiredVariables` list, with **no implicit default**.
  Any other value (missing, empty, or anything other than `true`/`false`
  case-insensitively — e.g. `"1"`, `"yes"`, a typo) fails the process closed
  at startup with a clear, non-secret-revealing error naming the variable,
  the same class of validation `config.ts` already applies to
  `DB_ENCRYPTION_KEY` and `EMERGENCY_ROTATION_TOKEN`. This is a real,
  explicit decision this variable directly controls (per Patrick's own
  framing: "if true, the system uses local username/passwords, otherwise
  Entra required"), not a soft default the way `COOKIE_SECURE`'s value is
  currently only presence-checked, not format-validated, in `config.ts` as
  it exists today — see Required behavior §7's note on this being a slight
  strengthening beyond `COOKIE_SECURE`'s current literal validation.
- A migration adding this contract's three new tables (`local_users`,
  `local_login_audit`, `local_user_admin_audit`; schema in Interfaces) has
  been applied to `PGLITE_DATA_DIR` before either `/auth/local-login` or any
  `/admin/users*` endpoint serves a request.
- CONTRACT-004's storage layer is available and seeded (a current signing key
  exists), since local login mints tokens via the same
  `getCurrentSigningKey()` call CONTRACT-001's path uses.
- BTAuthOrchestrator's origin is served over TLS (TASK-003d), identical to
  CONTRACT-001's and CONTRACT-003's precondition — this endpoint carries a
  human password in a request body and must never be reachable over a plain
  HTTP listener path.
- CONTRACT-004's single-process constraint holds; this contract's in-memory
  per-source-IP throttle (§3) relies on it the same way CONTRACT-001's
  in-memory handshake store does.
- `TENANT_ID` and `CLIENT_ID` are required, non-empty preconditions **only
  when `LOCAL_LOGIN=false`**; when `LOCAL_LOGIN=true` they are not
  preconditions at all and may be absent — see Required behavior §10.
- `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS`, `LOCAL_LOGIN_LOCKOUT_MINUTES`,
  `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`, and
  `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` are **optional** in `.env` — the
  one deliberate exception in this contract to the project's usual
  required-with-no-implicit-default posture. If present, each must parse as
  a positive integer or the process fails closed at startup; if absent, the
  defaults `10`, `15`, `20`, and `5` (respectively) apply silently — see
  Required behavior §3.

## Required behavior

### 1. Schema and password hashing

**Table `local_users`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `crypto.randomUUID()`, generated once at creation, never reused — this is the session token's `sub`. |
| `username` | text, unique, not null | Login identifier; stored and compared lowercase (normalized at write time). Also the session token's `upn` — the closest local equivalent to Entra's `preferred_username`. 3–64 characters, application-validated as lowercase ASCII letters, digits, `.`, `-`, `_`. |
| `email` | text, unique, not null | The session token's `email`. |
| `password_hash` | bytea, not null | scrypt derived key. Stored as plain bytes, **not** further AES-GCM-wrapped — see "Resolved decisions" #1 for why this deliberately does not reuse CONTRACT-004's envelope encryption. |
| `password_salt` | bytea, not null | 16 random bytes, freshly generated per password set/change. |
| `password_algorithm` | text, not null, default `'scrypt'` | Application-validated against a small allow-list, not DB-constrained — same pattern as `signing_keys.algorithm`, so a future algorithm needs no schema change. |
| `password_cost_n` | integer, not null | scrypt `N`. Stored per-row (not just globally) so a future default-parameter change doesn't invalidate existing hashes — see §1's parameter note. |
| `password_block_size_r` | integer, not null | scrypt `r`. |
| `password_parallelization_p` | integer, not null | scrypt `p`. |
| `password_key_length` | integer, not null | Derived key length in bytes. |
| `is_active` | boolean, not null, default `true` | `false` blocks future logins without deleting the record or its audit history. |
| `failed_login_attempts` | integer, not null, default `0` | See §3. |
| `locked_until` | timestamptz, nullable | See §3. |
| `created_at` | timestamptz, not null, default `now()` | |
| `updated_at` | timestamptz, not null, default `now()` | |
| `created_by` | text, nullable | Operator-self-asserted label (`actedBy`), same unverified-attribution caveat as CONTRACT-003's `triggered_by`. |

**Table `local_login_audit`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `crypto.randomUUID()`. |
| `attempted_at` | timestamptz, not null, default `now()` | |
| `username` | text, not null | As submitted, even if it matches no row — useful for spotting enumeration/spray attempts. |
| `result` | text, not null | `'success'` or `'failure'`. |
| `failure_reason` | text, nullable | One of `'unknown_username'`, `'bad_password'`, `'disabled'`, `'locked'`. Populated only on failure. This is intentionally **more granular than the HTTP response** — see §2's enumeration-resistance discussion for why the caller never sees this distinction but an operator inspecting audit rows can. |
| `source_ip` | text, nullable | Best-effort, same extraction convention as CONTRACT-003's `source_ip` (`X-Forwarded-For` first entry, else socket peer address). |

**Table `local_user_admin_audit`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `crypto.randomUUID()`. |
| `occurred_at` | timestamptz, not null, default `now()` | |
| `action` | text, not null | One of `'create'`, `'update'`, `'delete'`, `'auth_failure'`. |
| `target_user_id` | text, nullable | Null if the action failed before an id existed (e.g. bad bearer token, or a create that failed validation). |
| `target_username` | text, nullable | |
| `changed_fields` | text, nullable | Comma-separated field names actually changed by an `update` action (e.g. `"email,isActive"`). Never includes the password value itself. |
| `result` | text, not null | `'success'` or `'failure'`. |
| `failure_reason` | text, nullable | Short category (e.g. `'bad_credential'`, `'not_found'`, `'validation_error'`, `'conflict'`). |
| `actor_label` | text, nullable | Operator-self-asserted `actedBy`, same unverified-attribution caveat as CONTRACT-003. |
| `source_ip` | text, nullable | |

**Password hashing scheme: scrypt (Node's built-in `crypto.scrypt`), not
bcrypt or argon2id.**

Chosen specifically because this project currently has exactly two runtime
dependencies (`@electric-sql/pglite`, `jose`), and every existing
security-sensitive primitive in the codebase (AES-256-GCM in
`secrets.ts`, `timingSafeEqual` in `index.ts`) already uses Node's built-in
`crypto` module rather than a third-party library. `crypto.scrypt` is
memory-hard (unlike bcrypt, which is not, and is generally regarded as more
GPU/ASIC-resistant than bcrypt for equivalent tuning) and requires zero new
dependencies, consistent with this project's established posture. Argon2id
is the more current OWASP first choice, but is unavailable in Node's
standard library and would require adding a native-module dependency purely
for this feature. This was a real tradeoff, and `scrypt` is **confirmed by
Patrick (2026-09-15)** rather than left as an open question — see "Resolved
decisions."

**Parameters** (stored per-row so future changes don't retroactively
invalidate existing hashes):
- `N` (cost factor): `131072` (2^17).
- `r` (block size): `8`.
- `p` (parallelization): `1`.
- Derived key length: `64` bytes.
- Salt: `16` random bytes (`crypto.randomBytes(16)`), fresh per password
  set/change, never reused.

**Implementation note (interoperability requirement, not an implementation
suggestion):** Node's `crypto.scrypt`/`scryptSync` default `maxmem` is 32 MiB
(`32 * 1024 * 1024` bytes). The chosen `N`/`r`/`p` require approximately
`128 * N * r * p` = ~128 MiB, which exceeds that default and will throw
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS` unless an explicit `maxmem` of at least
that size is passed on every call (both hashing and verification). This
contract requires `maxmem` be set to at least `268435456` (256 MiB) on every
scrypt invocation this feature performs, with headroom above the ~128 MiB
minimum. This is stated as a required parameter (like CONTRACT-004's IV/tag
lengths), not an implementation detail, because getting it wrong is an
observable functional failure (every hash operation throws), not a style
choice.

**Storage format:** `password_hash`/`password_salt` as raw `bytea`, with
`password_algorithm`/`password_cost_n`/`password_block_size_r`/
`password_parallelization_p`/`password_key_length` as sibling columns
(rather than a single packed/PHC-style string), matching this project's
existing convention of typed columns over an encoded blob (see
`signing_keys`).

### 2. Local-login endpoint — `POST /auth/local-login`

Request: `Content-Type: application/json`, body `{ "username": string,
"password": string }`. Both fields required, non-empty strings; anything
else is a 400 (malformed request) before any user lookup or hashing occurs.

**Credential verification, in order, every time (see also §3 for lockout
interaction):**

1. Check the per-source-IP throttle (§3). If exceeded, respond 429
   immediately — no user lookup, no hashing.
2. Normalize `username` to lowercase and look up the matching `local_users`
   row.
3. **Regardless of whether a row was found**, perform a password-derivation
   computation of the same cost:
   - If found: derive a candidate hash using the row's stored
     `password_salt`/`password_cost_n`/`password_block_size_r`/
     `password_parallelization_p`/`password_key_length`, and compare to
     `password_hash` via `crypto.timingSafeEqual` (never `===`).
   - If not found: derive against a fixed, non-secret, hardcoded dummy
     salt/password using the same current default parameters (`N=131072,
     r=8, p=1, keylen=64`) new users are created with, so response latency
     for an unknown username is not measurably cheaper than for a known
     username with a wrong password. The exact dummy value is an
     implementation detail (fixed and deterministic, never derived from the
     request), not prescribed further here.
   - **This computation happens even if the row is found but `is_active =
     false` or currently locked** — the outcome is decided only *after* the
     computation completes, so that the disabled/locked/wrong-password/
     unknown-username cases are not distinguishable from each other by
     response timing either.
4. Determine the outcome:
   - Row not found → failure, `failure_reason = 'unknown_username'`.
   - Row found, `locked_until` is non-null and in the future → failure,
     `failure_reason = 'locked'`, regardless of whether the password
     matched. Lockout state is left untouched by this attempt (see §3 — an
     attempt made while already locked never further extends the lockout).
   - Row found, `is_active = false` → failure, `failure_reason =
     'disabled'`, regardless of whether the password matched.
   - Row found, active, not locked, password does not match → failure,
     `failure_reason = 'bad_password'`; increment `failed_login_attempts`
     (see §3).
   - Row found, active, not locked, password matches → success; reset
     `failed_login_attempts = 0` and `locked_until = NULL`.
5. Write one `local_login_audit` row for this attempt (best-effort — see
   Failure behavior for what happens if this write itself fails).
6. Respond.

**Response by outcome — a two-tier scheme, confirmed by Patrick
(2026-09-15), not full-generic-for-everything.** `POST /auth/local-login`'s
HTTP response depends on which of the four outcomes in step 4 applies:

- **Merged/generic (enumeration-resistant):** unknown username and wrong
  password produce the **identical** response — `401`, body
  `{"error":"Invalid username or password."}`. These two remain
  indistinguishable because they are the pair that most directly benefits
  an external attacker (confirming a username exists at all, vs. merely
  continuing to guess its password) — the same "don't reveal which specific
  check failed" posture CONTRACT-001 already applies to ID-token validation
  failures.
- **Disabled account — its own distinct response:** `403`, body
  `{"error":"This account has been disabled."}`.
- **Locked account — its own distinct response, naming the unlock time:**
  `423`, body `{"error":"This account is temporarily locked. Try again
  after <locked_until, ISO 8601>."}`.

**Why disabled/locked get distinct responses while unknown/wrong-password
stay merged.** This is an internal, admin-provisioned tool with no public
signup — the population that can legitimately hit "disabled" or "locked" is
exactly the set of testers/operators who already know their own username
exists, so telling them apart from "you mistyped your password" is more
valuable here than the marginal enumeration resistance given up: a 403/423
response tells a prober only that the *specific username they already
guessed* exists and is currently disabled/locked, not its password, and
per-account lockout (§3) already bounds how many guesses produce that
signal at all. Enumeration resistance for the unknown-vs-wrong-password
pair — the signal an attacker actually needs to make guessing worthwhile —
is unchanged and remains as strict as before.

**This split does not reopen a timing side channel.** The uniform-cost
password-derivation computation in step 3 runs to completion — for all four
outcomes, including disabled and locked — *before* the outcome is decided in
step 4. The two-tier response scheme introduced here only changes what is
sent *after* that already-uniform, already-completed computation; it does
not change when, whether, or how expensively that computation runs. An
attacker measuring response latency still cannot distinguish "unknown
username" from "known username, wrong password" — the pair that still
merges into one response — by timing, because both paths do the same
work before diverging. Disabled and locked are now distinguishable by
response *content* (403/423 vs. 401), which was always a more direct and
intentional signal than timing ever was for those two causes.

**Success response:** `200`, `Content-Type: application/json`, body
`{"status":"signed_in","username":"<username>"}`, and a `Set-Cookie` header
carrying the `bt_session` cookie — see §9 for how this is produced. The token
value never appears in the JSON body.

### 3. Brute-force / credential-stuffing protection

Human-chosen passwords are not high-entropy the way CONTRACT-003's
`EMERGENCY_ROTATION_TOKEN` is (CONTRACT-003 explicitly reasoned that its
bearer token's 32+ random characters make network brute force impractical
and skipped rate-limiting on that basis). That reasoning does not transfer
here, so this contract defines explicit protection rather than silently
omitting it.

**Confirmed by Patrick (2026-09-15): all four thresholds below are
configurable via optional `.env` variables, not hardcoded** — see "Resolved
decisions."

**Per-account lockout.** After `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS` (optional
`.env` variable, default `10`) consecutive failed attempts against a given
`username` (tracked via `local_users.failed_login_attempts`), the account is
locked: `locked_until` is set to `now() + LOCAL_LOGIN_LOCKOUT_MINUTES`
(optional `.env` variable, default `15`) minutes. While `locked_until` is in
the future, every attempt fails with `reason='locked'` (§2) regardless of
the password supplied, and lockout state is **not** further modified by
attempts made during the lockout window (so repeated retries during
lockout cannot indefinitely extend it). Once `locked_until` has passed,
attempts are evaluated normally again; a further wrong password immediately
re-locks (extending `locked_until` again from that point, using whichever
`LOCAL_LOGIN_LOCKOUT_MINUTES` value is configured at the moment of
re-lock), and a correct password succeeds and clears both fields.

**Per-source-IP throttle (secondary defense against spraying across many
usernames from one source, which per-account lockout alone does not stop).**
An in-memory, single-process counter (same class of mechanism, and same
accepted "resets on restart" tradeoff, as CONTRACT-001's in-memory OIDC
handshake store) tracks failed `/auth/local-login` attempts per source IP
over a rolling `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` (optional `.env`
variable, default `5`) minute window. At
`LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS` (optional `.env` variable, default
`20`) failed attempts from one source IP within that window, further
attempts from that IP receive `429` (`{"error":"Too many sign-in attempts.
Try again later."}`) without a user lookup or hashing, until the window
rolls forward. This does not apply to `/admin/users*` — see the reasoning
below.

**Configuration validation for all four variables above.** Each is
**optional** — if absent, the stated default applies silently, with no
startup error. This is a deliberate, narrow exception to this project's
usual "required, with no implicit default" posture for `config.ts`
variables (`COOKIE_SECURE`, `EMERGENCY_ROTATION_TOKEN`, etc.): Patrick
explicitly asked for adjustable-with-sane-defaults here, not
fail-closed-if-unset. If a variable **is** present, it must parse as a
positive integer (base-10, no sign, no decimal point, strictly greater than
zero); if present but unparseable or non-positive, the process fails closed
at startup with a clear, non-secret-revealing error naming the variable —
the same validate-when-present posture `config.ts` already applies to
`PORT`.

**No rate-limiting on the admin API's own bearer credential.** Consistent
with CONTRACT-003's own reasoning for `EMERGENCY_ROTATION_TOKEN`:
`LOCAL_USER_ADMIN_TOKEN` is required to be at least 32 random characters
(Preconditions), making network brute force impractical within any human
timescale. This contract applies the same reasoning CONTRACT-003 applied and
does not add throttling there, for the same reason.

### 4. Admin CRUD API authorization

**A dedicated, separate bearer credential, `LOCAL_USER_ADMIN_TOKEN`, distinct
from `EMERGENCY_ROTATION_TOKEN`.** Provisioned the same way
(`.env`-configured, operator-generated e.g. via `openssl rand -hex 32`, read
directly from `process.env`, never stored in PGlite), and checked the same
way: `Authorization: Bearer <token>`, compared via `crypto.timingSafeEqual`
over equal-length buffers (unequal lengths are an immediate mismatch),
never `===`. On mismatch or malformed header: `401`, generic body
(`{"error":"Unauthorized"}`), does not distinguish missing/malformed/wrong —
identical posture to CONTRACT-003 §2.

**This is deliberately a separate token, not a reuse of
`EMERGENCY_ROTATION_TOKEN`, on least-privilege grounds:** emergency rotation
is a rare, global, maximal-blast-radius action (invalidates every session in
the org instantly); local-user CRUD is a routine, narrow-blast-radius action
(affects only local test accounts, and does not itself invalidate any
existing session). Anyone who can create/disable a test user should not
thereby also be able to trigger a global kill switch, and vice versa —
conflating the two credentials would widen the blast radius of a leak of
either one. This mirrors CONTRACT-003's own reasoning for why an
otherwise-valid `bt_session` cookie must never substitute for
`EMERGENCY_ROTATION_TOKEN`: different trust boundaries get different
credentials. **Confirmed by Patrick (2026-09-15)** — see "Resolved
decisions."

`LOCAL_USER_ADMIN_TOKEN`'s value never appears in any log line, audit
record, response body, or error message, in either the success or failure
path — same posture already required for `EMERGENCY_ROTATION_TOKEN`,
`CLIENT_SECRET`, and `DB_ENCRYPTION_KEY`.

**Error specificity on the admin surface is intentionally different from the
public login surface.** Unlike `/auth/local-login` (§2), authenticated admin
endpoints may return specific error messages (e.g. "a user with that
username already exists," "no such user") without weakening enumeration
resistance in any meaningful way — the caller already holds
`LOCAL_USER_ADMIN_TOKEN` and can already enumerate every user via `GET
/admin/users`. Enumeration resistance only matters on the unauthenticated
surface.

### 5. Bootstrap: provisioning the first local user via `scripts/seed.js`

**Confirmed by Patrick (2026-09-15): the first local user is provisioned by
extending the existing `scripts/seed.js` bootstrap script (CONTRACT-004
§4), not via a post-startup `POST /admin/users` call.** This reverses this
contract's original default (an earlier draft reasoned that since
`LOCAL_USER_ADMIN_TOKEN` needs no prior database seeding — unlike
`CLIENT_SECRET`/the initial signing key, which CONTRACT-001's login flow
needs before its very first request — no seed-script extension was
strictly necessary). Patrick judged pre-staging a local user as part of the
same one-time bootstrap flow more convenient than a separate manual `curl`
step, and low-risk enough to do unconditionally — see "Not conditional on
`LOCAL_LOGIN`" below.

**Extends the existing idempotent "determine what needs seeding" pattern
(CONTRACT-004 §4) with one additional check, rather than introducing a
parallel bootstrap mechanism.** On every invocation, alongside
CONTRACT-004's existing `CLIENT_SECRET`/current-signing-key checks, the
script also checks whether any row exists in `local_users`:

- If at least one `local_users` row already exists: this piece is
  considered already seeded. The script reports this and makes no changes
  to `local_users` — mirroring CONTRACT-004 §4's existing per-piece skip
  behavior for an already-present `CLIENT_SECRET`/current signing key.
- If zero rows exist in `local_users`: the script prompts for a username, an
  email, and a password, using the same input pattern already established
  for `CLIENT_SECRET` — a hidden, not-echoed-to-terminal interactive prompt
  by default, or a one-time, immediately-deleted input file for
  non-interactive/scripted bootstrap (e.g. `--local-user-file=<path>`,
  mirroring `--client-secret-file`'s read-once-then-unlink-or-abort
  behavior). The file's exact format (e.g. one value per line: username,
  then email, then password) is an implementation detail this contract
  does not prescribe further.
- The submitted password is hashed via the **same scrypt code path and
  parameters** (§1) `POST /admin/users` uses — not a separate or
  simplified routine — and the resulting row is inserted with
  `is_active = true`, `failed_login_attempts = 0`, `locked_until = NULL`,
  and `created_by` set to a fixed marker (e.g. `'seed-script'`), since no
  admin-API caller/`actedBy` is involved in this path.

**Not conditional on `LOCAL_LOGIN`.** This seeding step runs regardless of
`LOCAL_LOGIN`'s value — seeding a local user is harmless and low-cost to
pre-stage even in a deployment currently running Entra-only
(`LOCAL_LOGIN=false`): an unused `local_users` row with no matching live
login path is inert, not a security exposure, since `/auth/local-login`
does not consult `local_users` at all while `LOCAL_LOGIN=false` (§7).

**The admin API remains the mechanism for every subsequent local-user
lifecycle action.** `scripts/seed.js` only ever provisions the *first*
local user (exactly as it only ever provisions the *first* `CLIENT_SECRET`/
signing key) — creating additional users, and updating or deleting any of
them (including the one the seed script created), continues to go through
`POST`/`PATCH`/`DELETE /admin/users*` as specified in §4.

### 6. Audit trail

Every `/auth/local-login` attempt (success or failure, per §2) produces
exactly one `local_login_audit` row. Every admin CRUD action — `create`,
`update`, `delete` — and every admin-API authentication failure produces
exactly one `local_user_admin_audit` row, mirroring CONTRACT-003 §4's
"attempt, not just success, is audited" posture. As with CONTRACT-003, "who"
for an admin action is necessarily "the holder of a valid
`LOCAL_USER_ADMIN_TOKEN`, optionally self-identified via `actedBy`" — the
same unverified-attribution limitation CONTRACT-003 already accepts for a
shared static secret, carried forward here rather than re-litigated.

Audit writes are best-effort and must never block the response they
describe: if a `local_login_audit` or `local_user_admin_audit` insert fails
(e.g. database unreachable), the caller's response is not affected, and a
server-side log line records at minimum a timestamp and the attempted
action/result category as a backstop — identical posture to CONTRACT-003's
audit-write failure handling.

No retention/cleanup policy is specified — rows are never deleted by this
contract's own behavior, mirroring CONTRACT-003/CONTRACT-004's stance on
their own audit/history tables. **Explicitly deferred, not silently
dropped:** unlike the rare emergency-rotation trigger, `/auth/local-login`
may be called very frequently by automated test suites, so `local_login_audit`
could grow substantially faster than any existing audit table in this
project. Patrick has confirmed this is deferred to a separate future task,
to be picked up once real testing activity has produced an actual growth
pattern to design a retention policy against — not something this contract
designs preemptively. See Open questions for the one-line pointer to this
deferral.

### 7. Mode-switch flag — `LOCAL_LOGIN`

**Decided by Patrick directly, confirmed in two stages:**

1. *"if true[,] the system uses local username/password[s], otherwise entra
   required. This will keep a local out of date username/password from being
   used to attack the system."*
2. Final confirmation, verbatim: *"LOCAL_LOGIN is a switch. if true only
   local logins are allowed and if false only Entra/Azure type logins are
   allowed."*

This settles both *whether* to gate local login and *how mutually exclusive*
the two paths are: **`LOCAL_LOGIN` is a strict, whole-service mode switch,
not an additive toggle.** Exactly one of the two login paths is live at any
time — never both, never neither. What follows specifies this precisely
enough to implement; it is no longer an open design question.

**When `LOCAL_LOGIN=false` (Entra-only mode):**
- `POST /auth/local-login` is fully inert: a request to that path falls
  through to the same generic `404` ("Not found") response used for every
  other unmatched route, identical to CONTRACT-003's own treatment of a
  wrong-method/wrong-path request to its trigger endpoint. No
  username/password comparison, lockout check, or audit-table read/write of
  any kind occurs — the route is inert, not merely credential-rejecting.
  This directly satisfies Patrick's stated reasoning: a stale or weak local
  credential sitting in `local_users` must not be usable to attack the
  system at all while this mode isn't active.
- `GET /auth/login` and `GET /auth/callback` (CONTRACT-001's Entra routes)
  are live and behave exactly as CONTRACT-001 already specifies, entirely
  unaffected.

**When `LOCAL_LOGIN=true` (local-only mode):**
- `POST /auth/local-login` is live and behaves exactly as §1–§6 and §9
  specify.
- `GET /auth/login` and `GET /auth/callback` become fully inert by the same
  standard as above: a request to either path falls through to the generic
  `404` response used for every other unmatched route — not a distinct
  "Entra disabled" error, so an unauthenticated prober cannot distinguish
  "this route doesn't exist" from "this route exists but is disabled" in
  either direction of the switch. No Entra discovery fetch, no handshake
  entry, no token exchange, no code in CONTRACT-001's required behavior
  executes while inert.

**What this flag does *not* gate, in either state:**
- `GET /.well-known/jwks.json` remains live regardless of `LOCAL_LOGIN`.
  Both login paths mint tokens using the same current signing key
  (CONTRACT-004's `getCurrentSigningKey()`, §9), so consuming apps must
  always be able to verify a `bt_session` token — including one minted
  before a mode switch, or under whichever mode was active when it was
  issued — without needing to know or care which mode the service is
  currently in.
- `POST /admin/emergency-rotate-keys` (CONTRACT-003) is entirely unaffected;
  it has no relationship to this flag.
- `/admin/users*` is **not** gated by `LOCAL_LOGIN` — the admin CRUD API
  remains reachable (subject only to its own `LOCAL_USER_ADMIN_TOKEN` check)
  regardless of this flag's value, so an operator can provision/curate local
  user records whether or not local-login mode is currently active (e.g.
  pre-staging accounts before switching a deployment into local-only mode).
  **Confirmed by Patrick (2026-09-15)** — see "Resolved decisions."

**A consequence worth stating plainly, not left implicit:** in a deployment
running `LOCAL_LOGIN=true`, no one can sign in via Entra at all, including
real staff members who would otherwise use their normal O365 credentials —
that deployment's login surface is entirely local-username/password for as
long as the flag is set that way. This is the direct, intended effect of
Patrick's "switch," not an accepted side effect this contract is working
around.

### 8. Failure responses are never raw errors

Every failure path defined in "Failure behavior" renders a plain JSON error
body — never an unhandled exception, stack trace, or raw framework error —
identical posture to CONTRACT-001 §8 and CONTRACT-003's failure handling.

### 9. Reuse of CONTRACT-001's minting machinery — byte-for-byte, not a
reimplementation

On a successful local login, BTAuthOrchestrator must:

1. Obtain the current signing key via CONTRACT-004's `getCurrentSigningKey()`
   — the exact same call CONTRACT-001's callback handler makes.
2. Call `mintSessionToken({ sub: user.id, email: user.email, upn:
   user.username }, signingKey, config.issuer, now)` — the exact same
   function (`src/tokens.ts`) CONTRACT-001's callback handler calls, with no
   modification to that function's signature or behavior.
3. Build and set the `bt_session` cookie using the identical name, domain,
   `HttpOnly`, `Secure` (governed only by `COOKIE_SECURE`, never `NODE_ENV`),
   `SameSite=Lax`, `Path=/`, and `Expires`/`Max-Age`-matches-`exp` rules
   CONTRACT-001 §7 defines — the same cookie-construction logic CONTRACT-001's
   implementation already uses, not a separate implementation that happens to
   produce a matching shape.

This is the mechanism by which "nothing downstream needs to know or care
which path minted a token" is actually guaranteed, rather than merely
asserted: both paths converge on the same function calls, so any future
change to CONTRACT-001's token/cookie shape automatically applies to this
path too without this contract needing a matching edit.

### 10. Conditional startup requirement — `TENANT_ID`/`CLIENT_ID` required
only when `LOCAL_LOGIN=false`

**Confirmed by Patrick (2026-09-15).** `config.ts`'s validation must treat
`TENANT_ID` and `CLIENT_ID` as required only when `LOCAL_LOGIN=false`. When
`LOCAL_LOGIN=true`, both may be absent or empty in `.env` without failing
startup; if present anyway, they are simply unused, since `GET
/auth/login`/`GET /auth/callback` are inert in that mode (§7), and their
values (if any) are not validated.

**This does not touch CONTRACT-001's own text.** CONTRACT-001 depends on
`TENANT_ID`/`CLIENT_ID` being available *when its routes are reachable*, but
its document does not itself mandate that `config.ts` require them
unconditionally at every process startup regardless of whether those routes
will ever be reached — that unconditional requirement was TASK-007's own
`config.ts` implementation choice, not a requirement CONTRACT-001 states.
Making the requirement conditional on `LOCAL_LOGIN` is therefore a change to
`config.ts`'s existing validation logic, introduced by this contract, not an
edit to CONTRACT-001's approved text — no ADR-001 immutability conflict.

Required behavior:
- At startup, configuration loading reads `LOCAL_LOGIN` before evaluating
  whether `TENANT_ID`/`CLIENT_ID` are required.
- If `LOCAL_LOGIN=false`: `TENANT_ID` and `CLIENT_ID` are required and
  non-empty, exactly as `config.ts` already validates today — unchanged in
  this case, and still fails the process closed at startup if either is
  missing or empty.
- If `LOCAL_LOGIN=true`: `TENANT_ID` and `CLIENT_ID` are **not** required.
  Their absence, or an empty value, is not a startup error. If present with
  a non-empty value anyway (e.g. left over from a prior Entra-enabled
  configuration), the process starts normally and simply never uses them.
- `CLIENT_SECRET` needs no equivalent change: it is read lazily from
  CONTRACT-004's storage only at actual Entra-callback time — never at
  startup, and never at all in a deployment that only ever runs
  `LOCAL_LOGIN=true` — so it was never a startup blocker to begin with.
- `LOCAL_USER_ADMIN_TOKEN` and `LOCAL_LOGIN` itself remain unconditionally
  required regardless of `LOCAL_LOGIN`'s own value (Preconditions); this
  conditional-requirement treatment applies only to `TENANT_ID`/`CLIENT_ID`.

This directly resolves the friction this contract's own motivating goal
otherwise had: a deployment intended purely for `LOCAL_LOGIN=true` testing
can now omit `TENANT_ID`/`CLIENT_ID` from `.env` entirely, with no Entra app
registration required at all to start the process.

### 11. Minimal HTML login form — `GET /auth/local-login`

**Confirmed by Patrick (2026-09-15): a minimal, unstyled HTML login form is
added alongside the JSON API, not instead of it.** `GET /auth/local-login`
serves a minimal HTML page containing a username/password form, live only
when `LOCAL_LOGIN=true` — identical gating to `POST /auth/local-login`
(§7): when `LOCAL_LOGIN=false`, `GET /auth/local-login` falls through to
the same generic `404` response as any unmatched route.

**Exactly one server-side credential-verification code path.** The HTML
page's form submission calls the existing `POST /auth/local-login` JSON
endpoint from client-side JavaScript (e.g. a small inline `fetch()` call),
not a native HTML `<form>` POST with a different content type or target.
The page itself contains no credential-verification logic of its own — it
is purely a client-side convenience wrapper around the one JSON endpoint
specified in §2, so every required behavior, failure taxonomy, brute-force
protection (§3), and audit-trail guarantee (§6) already specified for
`POST /auth/local-login` applies identically regardless of whether a given
request originated from this page's `fetch()` call or a direct API call.
This page introduces no second implementation to keep in sync with §2.

**Rendering:** on a successful `POST` response (§2), the page replaces its
form with a minimal "You're signed in." confirmation on the same page — no
redirect logic is specified or required, consistent with this being an
internal testing convenience rather than a production sign-in UX. On a
failure response, the page renders the JSON body's `error` string directly
next to the form, with no reinterpretation, translation, or embellishment
— the same distinctions specified in §2 apply: unknown-username and
wrong-password render the same generic text; disabled and locked render
their own distinct text, including the locked response's exact unlock
time.

**Deliberately unstyled/minimal**, per NOTES.md's "no UI polish" posture —
this is a functional convenience for a human tester who would otherwise
need `curl`/Postman/a browser devtools `fetch()` call, not a polished
sign-in page. No CSS framework, branding, or responsive design is required
or expected.

## Postconditions and invariants

**Postconditions (true after a successful local login):**
- Exactly one `bt_session` cookie is set, with a value that is a
  well-formed RS256 JWT containing exactly CONTRACT-001 §4's six claims —
  indistinguishable in shape from a token minted via the Entra path.
- The authenticated user's `failed_login_attempts` is `0` and `locked_until`
  is `NULL`.
- Exactly one `local_login_audit` row exists for this attempt with
  `result = 'success'`.

**Postconditions (true after a successful admin CRUD action):**
- `create`: exactly one new `local_users` row exists, with a freshly
  generated `id` never reused from any prior (including deleted) row, and a
  freshly generated `password_salt`.
- `update` (password change): `password_hash`/`password_salt`/parameter
  columns reflect the new password; `failed_login_attempts = 0`,
  `locked_until = NULL`.
- `delete`: the `local_users` row no longer exists; existing
  `local_login_audit`/`local_user_admin_audit` rows referencing that
  username/id are **not** deleted (no foreign key ties them to the user
  row — same "audit history outlives the thing it describes" pattern
  CONTRACT-003's audit table already establishes relative to `signing_keys`).
- Exactly one new `local_user_admin_audit` row exists with
  `result = 'success'`, naming the action and affected user.

**Postconditions (true after a `scripts/seed.js` run, §5):**
- If `local_users` had zero rows before the run: exactly one `local_users`
  row now exists, with `is_active = true`, `failed_login_attempts = 0`,
  `locked_until = NULL`, `created_by = 'seed-script'` (or an equivalent
  fixed marker), and a `password_hash`/`password_salt` produced via the
  same scrypt parameters (§1) `POST /admin/users` uses.
- If `local_users` had one or more rows before the run: no row in
  `local_users` is added, changed, or removed by this step.
- This postcondition holds regardless of `LOCAL_LOGIN`'s value (§5).

**Invariants (always true):**
- `LOCAL_USER_ADMIN_TOKEN` never appears in any log line, audit row,
  response body, or error message.
- No `local_users` row's `password_hash`, `password_salt`, or any password
  parameter ever appears in any HTTP response, from either the login
  endpoint or any admin endpoint.
- Response latency for `unknown_username` and `bad_password` outcomes on
  `/auth/local-login` does not, by construction (§2 step 3), differ in a way
  that trivially distinguishes the two — both remain merged into one `401`
  response. `disabled` and `locked` outcomes are distinguishable from the
  merged pair and from each other, but only via deliberate response content
  (`403`/`423`, §2), never via timing: the same uniform-cost computation
  (§2 step 3) still runs to completion for these two causes as well, before
  the outcome — and therefore the response content — is decided.
- A `local_users.id` value, once generated, is never reused by a different
  row, even after the original row is deleted (§9's `sub` claim depends on
  this for correctness).
- `is_active = false` or a deleted local user never causes an
  already-issued, not-yet-expired `bt_session` token to fail verification —
  that would require CONTRACT-003's emergency rotation, which this contract
  does not trigger automatically.
- A given source IP's failed-attempt count against `/auth/local-login`
  resets only on process restart or the natural rolling-window expiry, never
  mid-window on a single success (a successful login from one IP does not
  clear other IPs' or even that IP's own prior failed-attempt count within
  the window) — this is a coarse, resource-protection control, not a
  precise one.
- **Exactly one of the two login paths is live at any moment, determined
  solely by `LOCAL_LOGIN`: never both, never neither.** `LOCAL_LOGIN=true` ⇒
  `/auth/local-login` live, `GET /auth/login`/`GET /auth/callback` inert
  (generic 404). `LOCAL_LOGIN=false` ⇒ the reverse. `GET
  /.well-known/jwks.json` is live in both states (§7).

## Failure behavior

| Condition | Status | Response body theme |
|---|---|---|
| `LOCAL_USER_ADMIN_TOKEN` missing or under 32 characters at startup | Process fails to start | Clear, non-secret-revealing error naming the missing/invalid variable |
| `LOCAL_LOGIN` missing (not exactly `"true"`/`"false"` case-insensitively) at startup | Process fails to start | Same |
| `LOCAL_LOGIN=false` and a request hits `/auth/local-login` | 404 | Generic "Not found" — identical to any unmatched route; no credential check, lockout check, or audit write occurs |
| `LOCAL_LOGIN=true` and a request hits `GET /auth/login` or `GET /auth/callback` | 404 | Generic "Not found" — identical to any unmatched route; no Entra discovery fetch, handshake entry, or token exchange occurs (§7) |
| `TENANT_ID` or `CLIENT_ID` missing/empty at startup while `LOCAL_LOGIN=false` | Process fails to start | Clear, non-secret-revealing error naming the missing variable(s) — unchanged from `config.ts`'s existing behavior (§10) |
| `TENANT_ID`/`CLIENT_ID` missing/empty at startup while `LOCAL_LOGIN=true` | Not a startup error | Process starts normally; the values are simply unused (§10) |
| Any of `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS`/`LOCAL_LOGIN_LOCKOUT_MINUTES`/`LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`/`LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` present but not a positive integer at startup | Process fails to start | Clear, non-secret-revealing error naming the variable (§3) |
| Any of the four above absent at startup | Not a startup error | The stated default applies silently (§3) |
| `LOCAL_LOGIN=false` and a request hits `GET /auth/local-login` | 404 | Generic "Not found" — identical gating to the JSON endpoint (§7/§11) |
| `/auth/local-login`: missing/empty `username` or `password` | 400 | `{"error":"username and password are required"}` |
| `/auth/local-login`: per-source-IP throttle exceeded | 429 | `{"error":"Too many sign-in attempts. Try again later."}` |
| `/auth/local-login`: unknown username or wrong password | 401 | `{"error":"Invalid username or password."}` — deliberately identical for both causes (§2) |
| `/auth/local-login`: disabled account | 403 | `{"error":"This account has been disabled."}` (§2) |
| `/auth/local-login`: locked account | 423 | `{"error":"This account is temporarily locked. Try again after <locked_until, ISO 8601>."}` (§2) |
| `/auth/local-login`: signing-key retrieval or token minting fails after successful credential verification | 500 | `{"error":"Something went wrong signing you in; this has been logged."}` |
| `/admin/users*`: `Authorization` header missing, malformed, or not matching `LOCAL_USER_ADMIN_TOKEN` | 401 | `{"error":"Unauthorized"}`; a `local_user_admin_audit` row with `action='auth_failure'` is written (best effort) |
| `/admin/users*`: malformed JSON body, or a required field missing/wrong type | 400 | Specific validation message naming the field (admin-only surface — see §4) |
| `POST /admin/users`: `username` or `email` already exists | 409 | `{"error":"A user with that username already exists."}` (or the email-specific variant) |
| `PATCH /admin/users/:id`: new `email` collides with another user | 409 | `{"error":"A user with that email already exists."}` |
| `GET/PATCH/DELETE /admin/users/:id`: no such `id` | 404 | `{"error":"No such user."}` |
| Any admin-API database error | 500 | `{"error":"Unable to complete the request."}`; a `local_user_admin_audit` row with `result='failure'` is written if the database is reachable enough to accept it, else a server-side log-line backstop (timestamp + action + failure category only) |
| `local_login_audit` or `local_user_admin_audit` insert fails on any path | Does not affect the caller's response | Server-side log-line backstop (timestamp, action/result category only — never a credential or password value) |

## Interfaces

**HTTP endpoints:**

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/local-login` | None (public, subject to §3's throttling) | Verifies username/password; on success, mints and sets `bt_session` exactly as CONTRACT-001 §4–§7 define. Live only when `LOCAL_LOGIN=true`; otherwise falls through to generic 404 (§7). |
| `GET /auth/local-login` | None (public) | Serves the minimal HTML login form (§11), a thin client-side wrapper around the JSON endpoint above. Live only when `LOCAL_LOGIN=true`; otherwise falls through to generic 404 — identical gating to the JSON endpoint (§7/§11). |
| `GET /auth/login`, `GET /auth/callback` (CONTRACT-001, referenced not redefined) | Per CONTRACT-001 | Live only when `LOCAL_LOGIN=false`; otherwise fall through to generic 404 (§7) — this contract adds this new reachability condition on top of CONTRACT-001's existing routes without editing CONTRACT-001's own document. |
| `POST /admin/users` | `Authorization: Bearer <LOCAL_USER_ADMIN_TOKEN>` | Create a local user. Body: `{ "username": string, "email": string, "password": string, "actedBy"?: string }`. `201` on success with the created user's public fields. |
| `GET /admin/users` | Same | List all local users (no pagination in this milestone — see Scope > Excluded). `200` with `{ "users": [...] }`, never including password material. |
| `GET /admin/users/:id` | Same | Fetch one local user by id. `200` or `404`. |
| `PATCH /admin/users/:id` | Same | Update `email`, `password`, and/or `isActive` (at least one required). Body may include `actedBy`. Username is **not** renamable via this endpoint (confirmed by Patrick — see "Resolved decisions") — delete and recreate instead. `200` with the updated record. |
| `DELETE /admin/users/:id` | Same | Hard-deletes the `local_users` row. `200` with `{"status":"deleted","id":string,"username":string}`. Audit history referencing this user is retained (Postconditions). |

All admin responses include `Cache-Control: no-store`, matching CONTRACT-003's
posture for security-sensitive JSON responses.

**Schema:** see Required behavior §1 for the full `local_users`,
`local_login_audit`, and `local_user_admin_audit` table definitions.

**Interface to CONTRACT-001:** this contract's local-login path is, by
construction (§9), a second caller of CONTRACT-001's existing
`mintSessionToken` function and existing cookie-construction logic — it does
not reimplement, extend, or modify anything CONTRACT-001 defines. CONTRACT-001's
own document is not edited (it is `Approved`; ADR-001 forbids editing it in
place regardless). No new claim, signing algorithm, expiry rule, or cookie
attribute is introduced by this contract.

Separately, per §7, this contract imposes a new **reachability** condition
on CONTRACT-001's own `GET /auth/login`/`GET /auth/callback` routes —
they are live only when `LOCAL_LOGIN=false`. This is an additional external
gating condition layered on top of CONTRACT-001 (analogous to how a reverse
proxy or firewall rule could make a route unreachable without the
underlying contract's text changing), not a change to what those routes do
or require when they *are* reachable — CONTRACT-001's own required
behavior, preconditions, and failure taxonomy for those routes are
unmodified and apply exactly as written whenever `LOCAL_LOGIN=false` makes
them live. `GET /.well-known/jwks.json` is explicitly excluded from this
gating and remains live in both modes (§7).

**Interface to CONTRACT-004:** this contract's local-login path consumes
`getCurrentSigningKey()` exactly as CONTRACT-001's callback handler already
does — no change to that function or to CONTRACT-004's `SecretsStore`
interface. This contract's own new tables (`local_users`,
`local_login_audit`, `local_user_admin_audit`) live in the same PGlite
database as CONTRACT-004's `secrets`/`signing_keys`/(CONTRACT-003's)
`emergency_rotation_audit` tables but are **not** part of CONTRACT-004's
envelope-encryption module boundary. This is a deliberate distinction, not
an oversight: CONTRACT-004's `encryptValue`/`decryptValue` machinery exists
to protect **reversible** secrets (`CLIENT_SECRET`, private signing keys)
that the process must later decrypt back to plaintext to use. Password
hashes are the opposite — deliberately one-way and never decrypted, only
compared — so reusing AES-GCM envelope encryption on top of an already
one-way hash would add complexity (a dependency on `DB_ENCRYPTION_KEY` for a
value that doesn't need it) without a corresponding security benefit. See
"Resolved decisions" #1.

Additionally, per Required behavior §5, this contract extends TASK-006's
`scripts/seed.js` (CONTRACT-004 §4's bootstrap script) with one new,
additional idempotent seeding step for the first `local_users` row. This is
an extension to that script's implementation, not an edit to CONTRACT-004's
own document: CONTRACT-004 defines the `CLIENT_SECRET`/signing-key seeding
steps for a table CONTRACT-004 itself owns; this contract adds a sibling
step to the same script for `local_users`, a table CONTRACT-004 does not
define or depend on.

**No interface to CONTRACT-003.** This contract does not read, set, or
depend on `EMERGENCY_ROTATION_TOKEN`, and `LOCAL_USER_ADMIN_TOKEN` grants no
authority over emergency rotation or vice versa (§4).

## UX expectations

A minimal, unstyled HTML login form exists (`GET /auth/local-login`, §11) —
this is the one deliberate exception to CONTRACT-001's "no UI polish" and
CONTRACT-003's "no browser-facing admin UI" precedents, which otherwise
still hold in full: no admin UI is provided or required (Scope > Excluded).
The minimum bar that does apply:

- Every JSON error response is a small, flat object with a single `error`
  string — legible to a human reading raw JSON (e.g. via `curl`), free of
  stack traces or raw database error text.
- On the public `/auth/local-login` surface, unknown-username and
  wrong-password are deliberately presented identically to the caller
  (`401`); disabled and locked accounts each get their own distinct
  status/message (`403`/`423`) — this two-tier split is a stated
  requirement (§2), not an inconsistency.
- On the authenticated `/admin/users*` surface, error messages may be
  specific (e.g. naming which field failed validation, or that a username
  already exists) since the caller already holds `LOCAL_USER_ADMIN_TOKEN`.
- Success responses never include a password, password hash, or the session
  token value in their body, matching CONTRACT-001's "success response...
  must not expose the token value" posture.
- The `GET /auth/local-login` HTML form (§11) is deliberately unstyled and
  minimal — a functional convenience for a human tester, not a polished
  sign-in page. It renders the same `error` text the JSON endpoint returns
  (§2), with no separate wording of its own, and shows a minimal "You're
  signed in." confirmation on success, on the same page, with no redirect.

## Validation requirements

- Creating a user via `POST /admin/users`, then logging in via
  `POST /auth/local-login` with the same credentials, results in a
  `bt_session` cookie whose JWT decodes to exactly CONTRACT-001's six claims,
  with `sub` equal to the created user's `id`, `email` equal to the created
  user's `email`, and `upn` equal to the created user's `username`.
- The resulting token verifies successfully against
  `/.well-known/jwks.json` using the same offline verification approach
  CONTRACT-001's own validation requirements describe — confirming
  indistinguishability from an Entra-minted token.
- An unknown username and a known username with the wrong password both
  produce the identical `401` status and body.
- A known username on a disabled account produces the distinct `403`
  ("This account has been disabled.") — different from both the `401` pair
  and from the locked response.
- A known username on a locked account produces the distinct `423`,
  naming the exact `locked_until` timestamp in the message.
- Measuring response latency across repeated attempts for "unknown
  username" vs. "known username, wrong password" shows no reliably
  exploitable difference (confirms §2 step 3's timing mitigation for the
  pair that remains merged).
- Measuring response latency for the disabled and locked cases shows they
  take approximately the same time as the merged 401 pair (confirming the
  uniform-cost computation still runs for these two causes, even though
  their response content is now intentionally distinct — §2).
- With all four brute-force `.env` variables absent, ten consecutive
  wrong-password attempts against one account lock it (default
  `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS=10`); the eleventh attempt (even with the
  correct password) fails with the distinct `423` locked response while
  `locked_until` is in the future; after the default 15-minute
  `locked_until` passes, the correct password succeeds and clears both
  lockout fields.
- With all four brute-force `.env` variables absent, twenty-one failed
  attempts from one source IP within the default 5-minute window produce a
  `429` on the next attempt (default `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS=20`),
  regardless of which username is targeted; a request from a different
  source IP in the same window is unaffected.
- Setting `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS=3`: confirm lockout now triggers
  after 3 consecutive failures instead of the default 10.
- Setting `LOCAL_LOGIN_LOCKOUT_MINUTES`, `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS`,
  and `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` each to a non-default,
  positive-integer value: confirm the corresponding threshold/window changes
  accordingly.
- Setting any of the four brute-force `.env` variables to a non-positive or
  non-numeric value (e.g. `0`, `-1`, `"abc"`): confirm the process fails to
  start with a clear error naming the specific variable.
- `LOCAL_LOGIN=false`: confirm `POST /auth/local-login` returns the
  same `404` body as an arbitrary unmatched route, that no
  `local_login_audit` row is written for the attempt, that `GET
  /auth/login`/`GET /auth/callback` behave exactly per CONTRACT-001, and
  that `/admin/users*` remains reachable with a valid
  `LOCAL_USER_ADMIN_TOKEN`.
- `LOCAL_LOGIN=true`: confirm `GET /auth/login` and `GET /auth/callback`
  both return the same generic `404` body as an arbitrary unmatched route
  (no discovery fetch, no handshake entry created), that `POST
  /auth/local-login` behaves per §1–§6/§9, and that `GET
  /.well-known/jwks.json` remains reachable and unaffected in both states.
- `LOCAL_USER_ADMIN_TOKEN` unset or under 32 characters: confirm the process
  fails to start.
- A deployment with `LOCAL_LOGIN=true` and `TENANT_ID`/`CLIENT_ID` entirely
  absent from `.env` starts successfully (§10).
- A deployment with `LOCAL_LOGIN=false` and `TENANT_ID` or `CLIENT_ID`
  missing/empty fails to start, exactly as `config.ts` requires today (§10).
- A request to any `/admin/users*` endpoint with a missing, malformed, or
  incorrect `Authorization` header: confirm `401` and a
  `local_user_admin_audit` row with `action='auth_failure'`.
- A request to `/admin/users*` bearing only a valid `bt_session` cookie (no
  `Authorization` header): confirm `401` — a signed-in session never
  substitutes for `LOCAL_USER_ADMIN_TOKEN`, mirroring CONTRACT-003's
  equivalent validation requirement for `EMERGENCY_ROTATION_TOKEN`.
- `DELETE /admin/users/:id` followed by inspecting `local_login_audit`:
  confirm prior audit rows referencing that username remain intact.
- Directly inspecting `local_users.password_hash`/`password_salt` after
  creation: confirm the value is not the plaintext password or any
  recognizable encoding of it, and that two users given the same password
  have different `password_hash` values (proving per-user salting).
- Running `scripts/seed.js` against a database with zero `local_users` rows
  results in exactly one new row, hashed via the same scrypt code path and
  parameters `POST /admin/users` uses; running it again afterward reports
  this piece already seeded and makes no further change to `local_users`
  (§5).
- Running `scripts/seed.js` with `LOCAL_LOGIN=false`: confirm the
  `local_users` seeding step still runs (not conditional on `LOCAL_LOGIN`,
  §5).
- `GET /auth/local-login` with `LOCAL_LOGIN=true`: confirm the page loads,
  submitting valid credentials via the rendered form results in the same
  `bt_session` cookie a direct `POST /auth/local-login` call would produce
  and a minimal "You're signed in." confirmation on the same page;
  submitting invalid credentials shows the corresponding `401`/`403`/`423`
  error text inline, unchanged from the JSON endpoint's own text (§11).
- `GET /auth/local-login` with `LOCAL_LOGIN=false`: confirm the same generic
  `404` response as any unmatched route (§11).
- Confirm no HTTP response, at any endpoint this contract defines, ever
  contains `password_hash`, `password_salt`, `LOCAL_USER_ADMIN_TOKEN`, or a
  raw stack trace.

## Open questions

Patrick has reviewed and decided every substantive item originally raised
here across two rounds of feedback (password hashing algorithm,
admin-token separation, enumeration messaging, the `TENANT_ID`/`CLIENT_ID`
startup requirement, configurable brute-force thresholds, the
`scripts/seed.js` bootstrap path, the HTML login form, admin-API gating,
and username rename) — all of those are now recorded in "Resolved
decisions" below, not here. One item remains, an explicit deferral (not a
decision point):

1. **Retention/cleanup for `local_login_audit` is explicitly deferred to a
   separate future task** (TASK-014, filed in `tasks/proposed/`), to be
   picked up once real testing activity has produced an actual growth
   pattern to design a retention policy against — not something this
   contract designs preemptively. This contract's own scope stops at
   flagging the deferral (§6).

Whether this decision warrants its own ADR is resolved: see
[ADR-003](../decisions/ADR-003-local-login-alongside-entra.md), header
"Related ADRs." No task file exists yet for this contract's own
implementation — see header; per CLAUDE.md, implementation cannot begin
without an approved task, and this contract alone does not authorize
building anything.

## Resolved decisions

Items 1–7 below are judgment calls I made because no prior document settled
them, which I judged low-risk/easily-reversible enough to state as default
required behavior rather than list as open questions. Items 8–16 are
Patrick's own direct confirmations of items that *were* originally listed as
open questions in an earlier draft of this contract (across two rounds of
feedback). All remain changeable on review like anything else in a
`Proposed` contract.

1. **Password hashes are stored as plain `bytea`, not further wrapped in
   CONTRACT-004's AES-GCM envelope encryption.** A one-way hash does not
   need to be decrypted back to a usable value the way `CLIENT_SECRET` or a
   private signing key does; the hash's own one-wayness is the protection.
   Wrapping it in AES-GCM would add a dependency on `DB_ENCRYPTION_KEY` for
   no corresponding security benefit. See Interfaces > "Interface to
   CONTRACT-004."
2. **Table names** — `local_users`, `local_login_audit`,
   `local_user_admin_audit` — my own naming choices, easy to change without
   other consequence, flagged only because naming is otherwise silently
   locked in once implemented (same caveat CONTRACT-003 stated about its own
   endpoint path).
3. **Endpoint paths** (`/auth/local-login`, `/admin/users*`) — likewise my
   own naming choices, chosen to sit naturally alongside CONTRACT-001's
   `/auth/*` and CONTRACT-003's `/admin/*` namespaces.
4. **Username format** (lowercase, 3–64 chars, limited character set,
   case-insensitive storage/comparison) and **minimum password length (12
   characters, no additional complexity rule)** — reasonable, NIST-aligned
   defaults, not derived from any stated requirement. Complexity rules
   beyond length are deliberately not imposed, consistent with current
   password-guidance best practice.
5. **`kid`/`id`-style identifier generation** — `crypto.randomUUID()` for
   `local_users.id` and every audit table's `id`, matching this project's
   existing convention everywhere else (`signing_keys.kid`,
   `emergency_rotation_audit.id`).
6. **No pagination on `GET /admin/users`** — reasonable for a small internal
   testing population; would need revisiting if the user count grows large,
   but not designed preemptively here.
7. **`LOCAL_LOGIN`'s recommended/example default is `false` (Entra-only
   mode)** — this was an open question in an earlier draft of this contract;
   it is now settled by inspection of the tracked `.env.example`, which
   already sets `LOCAL_LOGIN=False`, and by Patrick's own framing ("otherwise
   Entra required") treating Entra-only as the ordinary/expected state. A
   fresh deployment therefore starts in Entra-only mode unless an operator
   deliberately opts into local-only mode.
8. **Password hashing algorithm: `scrypt` (Node built-in), not argon2id or
   bcrypt.** Confirmed by Patrick (2026-09-15). No behavior change from the
   original draft — Required behavior §1 already specified `scrypt` with
   the stated parameters; this closes out the tradeoff that section's
   original text left open.
9. **A separate `LOCAL_USER_ADMIN_TOKEN`, distinct from
   `EMERGENCY_ROTATION_TOKEN`, on least-privilege grounds.** Confirmed by
   Patrick (2026-09-15). No behavior change — Required behavior §4 already
   specified this.
10. **Enumeration messaging: a two-tier scheme, not full-generic-for-
    everything.** Confirmed by Patrick (2026-09-15). Unknown username and
    wrong password remain merged into one generic `401` response
    (`{"error":"Invalid username or password."}`); disabled accounts get a
    distinct `403` (`{"error":"This account has been disabled."}`); locked
    accounts get a distinct `423`, naming the exact `locked_until` timestamp
    (`{"error":"This account is temporarily locked. Try again after
    <locked_until>."}`). This **is** a behavior change from the original
    draft (which merged all four causes) — see Required behavior §2, the
    Failure behavior table, and Validation requirements for the updated
    specification, including the explicit reasoning for why this does not
    reopen the timing side channel §2 step 3's uniform-cost computation
    exists to close.
11. **`TENANT_ID`/`CLIENT_ID` are required only when `LOCAL_LOGIN=false`.**
    Confirmed by Patrick (2026-09-15). This **is** a new, additional
    required-behavior item (not present in the original draft, which left
    it as an open question) — see Required behavior §10, Preconditions,
    the Failure behavior table, and Validation requirements. This changes
    `config.ts`'s validation logic (a TASK-007 implementation choice), not
    CONTRACT-001's own approved text — see §10 for why no ADR-001
    immutability conflict arises.
12. **Lockout/throttle thresholds are configurable via optional `.env`
    variables, not hardcoded.** Confirmed by Patrick (2026-09-15). This
    **is** a behavior change from the original draft (which hardcoded `10`/
    `15`/`20`/`5`) — see Required behavior §3, Preconditions, Interfaces
    (Inputs), the Failure behavior table, and Validation requirements. Final
    variable names and defaults: `LOCAL_LOGIN_MAX_FAILED_ATTEMPTS` (default
    `10`), `LOCAL_LOGIN_LOCKOUT_MINUTES` (default `15`),
    `LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS` (default `20`), and
    `LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` (default `5`). Each is
    optional (validated-if-present, silently defaulted-if-absent) — the one
    deliberate exception in this contract to the project's usual
    required-with-no-implicit-default posture, per Patrick's explicit
    request for adjustable-with-sane-defaults rather than
    fail-closed-if-unset.
13. **The first local user is bootstrapped via `scripts/seed.js`, not
    `POST /admin/users`.** Confirmed by Patrick (2026-09-15), reversing this
    contract's original default. This **is** a behavior change — see
    Required behavior §5 (rewritten, not appended to), the new
    Postconditions group for a `scripts/seed.js` run, Interfaces > "Interface
    to CONTRACT-004," the header's "Related tasks," and Validation
    requirements. Runs unconditionally (not gated by `LOCAL_LOGIN`) and uses
    the same scrypt hashing path as the admin API.
14. **A minimal, unstyled HTML login form is added at `GET
    /auth/local-login`, alongside the JSON API.** Confirmed by Patrick
    (2026-09-15). This **is** a behavior change — see Required behavior §11
    (new), Scope (moved from Excluded to Included), Interfaces (new HTTP
    endpoint row), the Failure behavior table, UX expectations, and
    Validation requirements. The form is a pure client-side wrapper around
    the existing `POST /auth/local-login` endpoint — no second
    credential-verification code path is introduced.
15. **The admin CRUD API (`/admin/users*`) remains ungated by
    `LOCAL_LOGIN`.** Confirmed by Patrick (2026-09-15). No behavior change —
    Required behavior §7 already specified this; only the "flagged as a
    judgment call" framing there is updated to reflect confirmation.
16. **No username rename via `PATCH` — only `email`/`password`/`isActive`
    are updatable.** Confirmed by Patrick (2026-09-15). No behavior change —
    Interfaces already specified this; only the "see Open questions"
    cross-reference there is updated to point to this confirmation.
