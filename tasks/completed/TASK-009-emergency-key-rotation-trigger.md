# TASK-009: Emergency key-rotation trigger

Owner role: Implementer
Assigned agent: openai-coder (contract-architect first if the admin action's
authorization shape isn't obvious once scoped)
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-003 (authorization/audit design this task
implemented against); CONTRACT-002 (storage contract this task was
originally scoped against — retired 2026-09-15, see CONTRACT-004, which
codifies this task's as-built `rotateSigningKeyEmergency`/
`recordEmergencyRotationFailure` interface as normative; no code change
resulted from the retirement)
Related ADRs: ADR-001 (contracts are retired by supersession — the policy
under which CONTRACT-002 was retired in favor of CONTRACT-004 because of
this task, see TASK-011 Finding F1)
Dependencies: TASK-008

## Desired outcome

An authenticated administrative action that immediately generates a new
signing key pair, publishes it, and drops the previously current key from
JWKS — invalidating every previously issued session token globally, on
demand, for emergency use (Patrick's requested "kill switch" to force
re-authentication of all users at once).

## Context

This is deliberately a global-only mechanism, not per-user revocation —
Patrick has explicitly accepted that tradeoff (a single departing employee's
access is otherwise bounded by the midnight-expiry rule, up to ~24h) and
will handle finer-grained, per-application revocation needs on an
app-by-app basis later, outside this milestone. This task is independently
reviewable from TASK-008 because its authorization/audit surface (who can
trigger a mass logout of every user in the org) is its own security-critical
decision, distinct from ordinary key storage.

## Scope

### Included

- An authenticated trigger (endpoint or admin command) that generates a new
  RS256 key pair, marks it current, publishes it to JWKS, and removes the
  previously current key from JWKS immediately (no overlap window — this is
  the emergency path, distinct from any future routine-rotation-with-overlap
  design).
- A minimal audit trail (who triggered it, when).

### Excluded

- Routine/scheduled key rotation with an overlap window (future work, not
  this milestone).
- Per-user revocation (explicitly out of scope, per Patrick's decision
  above).

## Plan

1. Define who/what may authenticate to trigger this action (e.g., a
   break-glass admin credential, per NOTES.md §4's per-app break-glass
   pattern) — flag to Patrick if this isn't already obvious from existing
   break-glass design.
2. Implement key generation, immediate JWKS publish of the new key, and
   immediate removal of the old key.
3. Implement a minimal audit log entry for each trigger (who, when).

## Acceptance criteria

- [x] Triggering the action results in a new current key and the old key
      immediately absent from JWKS.
- [x] A token signed under the now-dropped key fails verification
      immediately after rotation (see also TASK-010).
- [x] The trigger requires authentication; the authorization mechanism is
      explicit and documented.
- [x] Each trigger produces an audit record.

## Validation requirements

Mint a token, trigger rotation, confirm the token now fails offline
verification against the refreshed JWKS.

## Risks and assumptions

"Instant" is only as instant as each consuming app's JWKS caching behavior —
not yet a concern with zero consuming apps in this milestone, but must be
stated explicitly in any future consuming-app contract (e.g., CDMS
integration).

## Blocker

None.

## Implementation handoff

Task: TASK-009 — Emergency key-rotation trigger
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
was disconnected this session; Patrick authorized proceeding in his absence)
Date: 2026-09-15

### Changes made

- **`src/database.ts`**: added `emergency_rotation_audit` as a new
  `CREATE TABLE IF NOT EXISTS` block inside the existing `schemaMigration`
  string, alongside `signing_keys` — per this brief's resolution of
  CONTRACT-003 Open question #8 (migration ownership belongs to this task,
  given the project's idempotent-SQL-string "migration" mechanism).
  Columns/constraints match CONTRACT-003's "Interfaces" schema table exactly:
  `id text PRIMARY KEY`, `triggered_at timestamptz NOT NULL DEFAULT now()`,
  `result text NOT NULL CHECK (result IN ('success', 'failure'))`,
  `triggered_by text`, `source_ip text`, `previous_kid text`, `new_kid text`,
  `failure_reason text`.
- **`src/secrets.ts`**: added two new `SecretsStore` methods (additive only;
  no existing exported function signature changed), per this brief's
  resolution of CONTRACT-003 Open question #7 (atomicity):
  - `rotateSigningKeyEmergency(newKey: SigningKeyInput, audit: { triggeredBy: string | null; sourceIp: string | null }): Promise<{ previousKid: string | null; newKid: string }>`
    — a single `database.transaction(...)` call (mirroring `insertSigningKey`'s
    existing pattern) that reads the current `signing_keys` row if one
    exists, updates it to `status = 'revoked', revoked_at = now()`, inserts
    the new row as `status = 'current'`, and inserts one
    `result = 'success'` row into `emergency_rotation_audit` — all inside
    the same transaction, so a committed rotation and its audit row can
    never diverge. If any step fails, the whole transaction rolls back: no
    partial `signing_keys` row, no phantom audit row.
  - `recordEmergencyRotationFailure(input: { triggeredBy: string | null; sourceIp: string | null; failureReason: string }): Promise<void>`
    — a separate, non-transactional insert of a `result = 'failure'` audit
    row, used for the two cases that have no rotation to couple
    atomically: bad-credential attempts (no rotation was ever attempted),
    and a rotation attempt whose transaction above just rolled back (there
    is nothing left to be atomic with at that point). This deviates in one
    respect from the brief's example signature (`rotateSigningKeyEmergency(input, audit)`
    with `audit.result: 'success' | 'failure'`): since `rotateSigningKeyEmergency`
    only ever runs the actual rotation, every row it writes is
    unconditionally `result = 'success'` (if it wrote anything, the
    transaction committed); a `result = 'failure'` row is structurally a
    different, non-transactional write, so I split it into its own function
    rather than overloading one function with a result branch that could
    never actually take the `'failure'` path internally. Documented here
    per the brief's "exact naming/shape is your call" allowance.
  - Both use `crypto.randomUUID()` for the audit row's `id`, matching
    CONTRACT-002's existing `kid`-generation convention (no dependency on a
    Postgres UUID extension).
- **`src/config.ts`**: added `EMERGENCY_ROTATION_TOKEN` as the eighth
  required variable, following `SERVICE_ISSUER`'s exact pattern from
  TASK-012 (same whitespace-aware missing-value validation, same aggregated
  configuration-error format). Added a length check (must be at least 32
  characters when present and non-empty) mirroring `DB_ENCRYPTION_KEY`'s
  format-validation pattern, with an error message naming only the variable
  and the requirement, never the value. `Config.emergencyRotationToken` is
  populated from `environment.EMERGENCY_ROTATION_TOKEN!.trim()`.
- **`.env.example`**: documented `EMERGENCY_ROTATION_TOKEN` with its
  purpose, minimum length, and `openssl rand -hex 32` provisioning guidance.
- **`src/index.ts`**: added `POST /admin/emergency-rotate-keys`:
  - `extractBearerToken`: parses `Authorization: Bearer <token>`
    case-sensitively with exactly one space; any other shape (missing
    header, wrong scheme, extra/missing space, empty token) returns `null`.
  - `constantTimeTokenMatches`: compares UTF-8 byte buffers via
    `crypto.timingSafeEqual`; unequal lengths are treated as an immediate
    mismatch without calling `timingSafeEqual` on them (per CONTRACT-003
    §2's exact wording — `timingSafeEqual` itself throws on length
    mismatch, so this check is also a correctness requirement, not just a
    hardening nicety).
  - `readRequestBody`: buffers the request body up to a 16 KiB cap
    (`EMERGENCY_ROTATION_BODY_LIMIT_BYTES`; not specified by CONTRACT-003 —
    a narrow implementation judgment call, see "Assumptions and
    deviations"), then `extractTriggeredBy` parses it as JSON and returns
    the `triggeredBy` field only if it is a non-empty string; any other
    shape (missing body, invalid JSON, non-string/empty field, oversized
    body) yields `null` and is never treated as a request failure, per
    CONTRACT-003's Failure behavior table.
  - `extractSourceIp`: first `X-Forwarded-For` entry if present and
    non-empty, otherwise `request.socket.remoteAddress`.
  - `handleEmergencyRotateKeys`: reads the body and source IP first (so
    `triggeredBy`/`sourceIp` are available for the audit row on every code
    path, including auth failures), then checks the bearer token. On
    mismatch: writes a `bad_credential` failure audit row (best effort, via
    `writeEmergencyRotationFailureAudit`) and returns `401
    {"error":"Unauthorized"}`. On match: generates a fresh 2048-bit RSA key
    pair in-process (same `generateKeyPair`/PKCS8-private/SPKI-public shape
    `scripts/seed.js`/`src/seed.ts` already uses), assigns a fresh `kid` via
    `crypto.randomUUID()`, calls `rotateSigningKeyEmergency`, and on success
    returns `200 {"status":"rotated","previousKid","newKid","rotatedAt"}`
    with `rotatedAt` captured immediately after the store call resolves (as
    close to actual commit time as observable from the caller). On any
    failure from key generation or `rotateSigningKeyEmergency` (caught as
    one block, matching CONTRACT-003's Failure behavior table row that
    groups both under one 500-class outcome), logs the error server-side,
    writes a `rotation_error` failure audit row (best effort), and returns
    generic `500 {"error":"Unable to complete emergency rotation"}` — never
    a stack trace or raw DB error.
  - `writeEmergencyRotationFailureAudit`: wraps
    `recordEmergencyRotationFailure` in a try/catch; on failure, never
    blocks or alters the HTTP response already being returned, and instead
    emits a `console.error` backstop log line containing only a timestamp
    and the failure-reason category — never the credential value, a raw DB
    error containing secret material, or a stack trace.
  - Route dispatch: `request.method === "POST"` and the path (query string
    stripped, mirroring the existing `/auth/callback` path-matching
    convention) equal to `/admin/emergency-rotate-keys`, added immediately
    before the final generic-404 fallback so every other method/path
    combination (including `GET /admin/emergency-rotate-keys`) falls
    through to the existing, unmodified `404 {"error":"Not found"}`
    response — never a distinct "wrong method" response that would confirm
    the endpoint's existence to an unauthenticated prober.
  - Response headers for every code path from this endpoint (200/401/500)
    include `Cache-Control: no-store`. CONTRACT-003's Interfaces section
    states this explicitly only for the 200 response; I applied it to the
    401/500 responses too for consistency with the endpoint's overall
    "security-sensitive, never-cache" posture (matching the JWKS endpoint's
    existing treatment) — flagged as a judgment call, not a deviation from
    anything the contract requires elsewhere.
- No changes to `src/tokens.ts`, `src/oidc.ts`, the OIDC login/callback
  flow, or any JWKS/signing internals beyond the additive `SecretsStore`
  methods above — all explicitly out of TASK-009/CONTRACT-003's scope and
  left untouched.
- Updated `docs/DEVELOPMENT.md` (see "Documentation updated").

### Validation performed

All validation below was run in this sandbox session, which — like
TASK-007's session and unlike TASK-008/012's — permitted live socket
binding (confirmed directly with a throwaway `net.createServer().listen()`
probe before relying on it). All checks therefore used the real compiled
service over a real HTTP socket, not just the exported handler function.

- `npm run build`: TypeScript compiled cleanly with no errors, both after
  the initial implementation and again after all subsequent edits.
- **Startup fail-closed behavior** (fresh scratch `PGLITE_DATA_DIR`,
  seeded once via `node dist/seed.js --client-secret-file=...` with a
  freshly generated 64-hex-character `DB_ENCRYPTION_KEY` and
  `EMERGENCY_ROTATION_TOKEN`):
  - `EMERGENCY_ROTATION_TOKEN` unset (all other required vars present):
    `Configuration error: missing required environment variable(s):
    EMERGENCY_ROTATION_TOKEN`, exit code 1.
  - `EMERGENCY_ROTATION_TOKEN` set to 31 characters: `Configuration error:
    invalid environment variable(s): EMERGENCY_ROTATION_TOKEN (must be at
    least 32 characters)`, exit code 1.
  - `EMERGENCY_ROTATION_TOKEN` set to exactly 32 characters: service started
    and printed `BTAuthOrchestrator listening on port 41901`; a `SIGTERM`
    produced a clean shutdown with the process lock file removed
    afterward — confirming the boundary is inclusive (>= 32, not > 32) and
    that adding this eighth required variable didn't disturb the existing
    shutdown path.
- **Live HTTP validation** against the real compiled service
  (`dist/index.js`) on `127.0.0.1:41901`, real `curl`/`fetch` requests, a
  real 64-hex-character `EMERGENCY_ROTATION_TOKEN`:
  - Correct token, JSON body `{"triggeredBy":"patrick-manual-test"}`:
    `HTTP/1.1 200 OK`, `Cache-Control: no-store`, body
    `{"status":"rotated","previousKid":"3f1cf645-...","newKid":"b0ec31fd-...","rotatedAt":"2026-09-15T18:18:58.667Z"}`
    (`previousKid` matched the seeded key exactly).
  - Wrong token (correct length, wrong value), missing `Authorization`
    header, and malformed scheme (`Authorization: bearer <token>`,
    lowercase) each returned `HTTP/1.1 401 Unauthorized`,
    `Cache-Control: no-store`, identical generic body
    `{"error":"Unauthorized"}` — confirming the response does not
    distinguish which check failed.
  - `GET /admin/emergency-rotate-keys` (correct path, wrong method) and
    `POST /admin/not-a-real-path` (wrong path) both returned the existing,
    unmodified `HTTP/1.1 404 Not Found` / `{"error":"Not found"}` — no
    distinct "wrong method" response.
  - Minted a real `bt_session` cookie via `mintSessionToken` against the
    seeded current key (same technique as TASK-008/012's validation),
    presented it alone as `Cookie: bt_session=<jwt>` with **no**
    `Authorization` header: `HTTP/1.1 401 Unauthorized` — confirming a
    valid session cookie never substitutes for the dedicated credential.
  - Decoded that same pre-rotation token's JWT header (`{"alg":"RS256",
    "kid":"3f1cf645-7852-46ad-906a-0e1582fb7328"}`), fetched the live
    `/.well-known/jwks.json` after the rotation above, and confirmed the
    response's `keys` array contained only the new `kid`
    (`b0ec31fd-f208-4bb3-b73f-d46e57bef3c1`) — the old `kid` was absent.
  - Verified this offline-verification failure directly with `jose`:
    `createRemoteJWKSet` against the live JWKS endpoint plus `jwtVerify` on
    the pre-rotation token threw `JWKSNoMatchingKey: no applicable key
    found in the JSON Web Key Set` — the exact "fails verification
    immediately" outcome CONTRACT-003/TASK-009 require.
  - Two further successful triggers: one with **no** request body
    (`triggeredBy` omitted) and one with `{"triggeredBy": 12345}` (a
    non-string value) — both returned `200` and rotated correctly,
    confirming a malformed/absent `triggeredBy` is never treated as a
    request failure.
  - **Concurrency**: fired two authenticated `POST` requests
    simultaneously (`triggeredBy: "concurrent-a"` / `"concurrent-b"`).
    Both returned `200`. Response B's `newKid` exactly equaled response
    A's `previousKid` (`05ea0eee-...`), proving the two rotations were
    serialized into two consecutive, correctly chained transactions rather
    than corrupting state; the post-test `/.well-known/jwks.json` contained
    exactly one key, matching A's `newKid`.
  - Grepped the full server log across this entire session (startup
    through all requests above) for the real `EMERGENCY_ROTATION_TOKEN`
    value: zero occurrences. The log contained only the startup line — no
    `console.error` output at all, since none of the exercised failure
    paths in this section involved a server-side error (bad-credential
    failures don't call `console.error`, only the audit write).
  - Stopped the service cleanly (`SIGTERM`, lock file removed) and
    inspected `PGLITE_DATA_DIR` directly with a throwaway PGlite
    connection: `signing_keys` had exactly one `status = 'current'` row
    (the final key from the concurrency test) and five `status = 'revoked'`
    rows, every one with `revoked_at` populated and `retired_at` null (no
    key ever passed through `retired`). `emergency_rotation_audit`
    contained exactly 9 rows: 4 `result = 'failure'` (wrong token, missing
    header, malformed scheme, valid-cookie-only — all `failure_reason:
    'bad_credential'`, all `triggered_by: null`, all `source_ip:
    '::ffff:127.0.0.1'`) and 5 `result = 'success'` rows whose
    `previous_kid`/`new_kid` chain exactly matched every rotation performed
    above, `triggered_by` stored verbatim (`'patrick-manual-test'`,
    `'concurrent-a'`, `'concurrent-b'`) or `null` (omitted/non-string
    cases) as expected, and no row containing the credential value.
  - Grepped `src/config.ts` and `src/index.ts` for every use of
    `emergencyRotationToken`/`EMERGENCY_ROTATION_TOKEN`: the value is used
    only inside `constantTimeTokenMatches` (never interpolated into a
    string, log, or response) and the startup length-check error message
    names only the variable and the length requirement, never the value.
- **Failure-backstop paths** (not exercisable via the live service alone,
  since they require simulating database unreachability): built a
  standalone harness (`node`'s `createServer`/`createRequestHandler`
  directly, per the TASK-008/012 exported-handler-testing precedent) with
  three stub `SecretsStore` implementations, each hit with a real `fetch`
  request over a real loopback socket:
  1. `rotateSigningKeyEmergency` throws (simulated rotation failure) while
     `recordEmergencyRotationFailure` succeeds: `500
     {"error":"Unable to complete emergency rotation"}`;
     `recordEmergencyRotationFailure` was called with
     `{"triggeredBy":null,"sourceIp":"127.0.0.1","failureReason":"rotation_error"}`;
     the one logged line contained the internal error message but not the
     credential value.
  2. Both `rotateSigningKeyEmergency` and `recordEmergencyRotationFailure`
     throw (simulated fully-unreachable database): the HTTP response was
     still returned promptly as `500
     {"error":"Unable to complete emergency rotation"}` (not blocked/hung
     on the failed audit write), and a backstop `console.error` line was
     emitted: `Emergency rotation audit write failed; log-line backstop:
     timestamp=2026-09-15T18:20:14.376Z failureReason=rotation_error: ...`
     — timestamp and category only, no credential value.
  3. Bad credential (wrong token) with `recordEmergencyRotationFailure`
     throwing: the response was still `401 {"error":"Unauthorized"}` (not
     blocked), with the same shape of backstop log line
     (`failureReason=bad_credential`).
- No test command exists in `package.json` beyond `build`; validation was
  therefore performed via the live service, the standalone stub harness
  above, and direct PGlite inspection, matching this project's established
  (TASK-007/008/012) validation methodology.

### Acceptance criteria evidence

- **New current key, old key immediately absent from JWKS: met.** Shown
  directly above — the pre-rotation `kid` was present in the JWT header but
  absent from the post-rotation live JWKS response.
- **Token signed under the dropped key fails verification immediately:
  met.** Direct `jose` `jwtVerify` against the live post-rotation JWKS threw
  `JWKSNoMatchingKey`.
- **Trigger requires authentication; mechanism explicit and documented:
  met.** `EMERGENCY_ROTATION_TOKEN` bearer credential, constant-time
  compared, distinct from `bt_session` (explicitly confirmed insufficient
  above); documented in `docs/DEVELOPMENT.md` and this handoff.
- **Each trigger produces an audit record: met.** Every one of the 9
  triggers exercised against the live service produced exactly one
  `emergency_rotation_audit` row with the correct `result`, and the three
  stub-harness failure scenarios confirmed the log-line backstop fires when
  the audit write itself cannot be performed.

### Assumptions and deviations

- **`rotateSigningKeyEmergency`/`recordEmergencyRotationFailure` split into
  two functions**, rather than the brief's one-function example signature
  with a `result: 'success' | 'failure'` audit parameter. See "Changes
  made" above for the reasoning: `rotateSigningKeyEmergency` performs an
  actual rotation and, being one transaction, can only ever produce a
  `'success'` row if it produces one at all; a `'failure'` row belongs to a
  structurally different, non-transactional write. This is the "exact
  naming/shape is your call" allowance the brief explicitly grants, not an
  unrequested architecture change.
- **16 KiB request-body cap** (`EMERGENCY_ROTATION_BODY_LIMIT_BYTES`) for
  the optional `{"triggeredBy"?: string}` body. Not specified by
  CONTRACT-003; chosen to avoid buffering an unbounded body in memory
  before authentication is even checked, while being far larger than any
  realistic `triggeredBy` label needs. An oversized body degrades to
  `triggeredBy: null` (logged server-side) rather than rejecting the
  request outright — consistent with CONTRACT-003's "never rejected or
  treated as a failure" instruction for this field.
- **`Cache-Control: no-store` applied to the 401/500 responses**, not just
  the 200 CONTRACT-003 explicitly names. Judgment call favoring consistency
  with this endpoint's overall non-cacheable, security-sensitive posture
  (mirroring the JWKS endpoint's existing treatment); flagged since the
  contract text only obligates it for the success case.
- **`rotation_error` used as the single `failure_reason` category** for
  both key-generation failures and `rotateSigningKeyEmergency` failures,
  matching CONTRACT-003's Failure behavior table, which groups "Key
  generation or `rotateSigningKey` fails" as one row/outcome rather than
  itemizing them separately.
- **Body/source-IP extraction happens before the credential check**, so
  `triggeredBy`/`source_ip` are available on the audit row even for a
  failed-authentication attempt. CONTRACT-003's schema table documents
  `triggered_by`/`source_ip` generically (not "success-only"), and its own
  framing of "who" ("the holder of a valid token, from this source
  address, optionally self-identified") reads as applying to every
  attempt, not just successful ones; this was a plausible-but-not-fully-
  explicit reading and is flagged here rather than assumed silently.
- **`rotatedAt` in the success response is captured immediately after
  `rotateSigningKeyEmergency` resolves**, not before key generation begins,
  so it stays as close as observable to the actual DB commit time (the
  `emergency_rotation_audit.triggered_at` column's own `DEFAULT now()` is
  the authoritative timestamp; the response field is a convenience mirror
  of it, not re-derived from it).
- No product behavior or validation deviates from CONTRACT-003's other
  stated decisions (concurrent-trigger handling, no rate limiting, no
  network-topology control, no credential-rotation mechanism, TLS left to
  TASK-003d/Caddy) — all implemented/left exactly as the contract specifies
  or explicitly excludes.

### Unresolved risks

- **TLS-only exposure (CONTRACT-003's Preconditions and Validation
  requirements' final bullet) was not independently re-verified by this
  task** — TASK-003d (Caddy/TLS provisioning) is a separate, still-`approved`
  task in this milestone; this endpoint carries the same TLS-only
  requirement CONTRACT-001 already imposes on `/auth/login`/`/auth/callback`,
  and no code in this change opens any new plain-HTTP listener path. Once
  TASK-003d is implemented, confirming this endpoint is unreachable over a
  non-TLS path is a one-line addition to that task's own validation, not a
  gap introduced here.
- **The twelve Open questions CONTRACT-003 itself lists remain genuinely
  open** (single shared token vs. named tokens, no rate limiting/lockout,
  no network-topology restriction, no alerting, etc.) — none of them
  blocked implementation since the contract's "Required behavior"/"Failure
  behavior" sections already resolve exactly what this task needed to
  build, but they were not re-litigated or silently resolved by this
  implementer and remain Patrick's to decide as fast-follows if desired.
- No other unresolved risks identified from implementation and validation
  performed. Independent review and human acceptance remain pending.

### Documentation updated

- `docs/DEVELOPMENT.md`: documented `EMERGENCY_ROTATION_TOKEN` (purpose,
  minimum length, provisioning guidance, fail-closed startup behavior) and
  `POST /admin/emergency-rotate-keys` (authentication mechanism, atomic
  rotation/audit behavior, success/failure response shapes, the
  `triggeredBy` field's non-authoritative nature, and concurrent-trigger
  behavior).
- `.env.example`: added `EMERGENCY_ROTATION_TOKEN` with inline guidance.

## Review

Not reviewed.
