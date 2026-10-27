# CONTRACT-003: Emergency key-rotation authorization

Status: Approved
Approved by: Patrick
Approved date: 2026-09-14
Related tasks: TASK-009 (consumes this contract; Plan step 1 requests exactly
this design), CONTRACT-002 (storage/rotation interface this contract builds
on — `rotateSigningKey`), CONTRACT-001 (defines the `bt_session` cookie this
contract's mechanism deliberately does **not** accept as a credential)
Related ADRs: none
Superseded by: CONTRACT-010 for the "UX expectations" statement that no
browser-facing UI is provided for the emergency rotation trigger only. All
other sections remain in force.

## Purpose

Define, precisely enough for TASK-009's implementer to build against without
further architectural decisions, how an administrator authenticates to
BTAuthOrchestrator itself to trigger the emergency global key-rotation ("kill
switch") action: the credential mechanism, how it is provisioned and
checked, the atomicity/no-overlap guarantees the trigger must uphold, the
minimal audit trail it must produce, and its failure behavior.

This contract treats TASK-009's own Context section as settled and does not
relitigate it: this is deliberately a global-only, no-overlap-window
mechanism; per-user revocation is out of scope; a departing employee's
worst-case exposure is otherwise bounded by CONTRACT-001's midnight-expiry
rule. This contract also does not relitigate NOTES.md §4/§5's still-open
"centralized vs. per-app break-glass admin" question — that question is
about the broader rollout across future consuming apps. This contract's
scope is narrower: how an admin authenticates to trigger **BTAuthOrchestrator's
own** emergency rotation, independent of how any consuming app later handles
its own break-glass path.

No existing admin-authentication mechanism exists to reuse. Confirmed by
inspection of `src/` (no `admin`-related module, no credential-check code
path beyond CONTRACT-002's `SecretsStore`), `.env.example` (no reserved
admin-credential variable), and `tasks/completed/` (TASK-008 implemented only
the JWKS/signing path; no task has implemented `rotateSigningKey` or
`revokeKey` yet — `src/secrets.ts` currently exposes only `encryptValue`,
`decryptValue`, `setSecret`, `insertSigningKey`, `getCurrentSigningKey`, and
`listPublishableSigningKeys`). NOTES.md's only description of a working
break-glass mechanism is CDMS's own local username/password fallback admin
login — a different codebase, gating a different action (logging into CDMS
itself), not something this contract can call into or assume implementation
details of beyond the pattern it illustrates (an always-available,
`.env`-configured credential, independent of the primary SSO path).

## Scope

### Included

- The actor(s) permitted to trigger TASK-009's emergency rotation action.
- The concrete authentication mechanism: what the credential is, how it is
  provisioned/stored, and how a request is checked against it.
- Preconditions, postconditions, and invariants for the trigger, including
  atomicity (no overlap window) and behavior under concurrent trigger
  attempts.
- The minimal audit trail TASK-009 requires (who, when), its storage
  location, and the guarantee that a rotation and its audit record never
  diverge (no un-audited rotation; no "phantom" audit record for a rotation
  that didn't happen).
- Failure behavior: bad/missing credential, misconfiguration at startup,
  concurrent triggers, and downstream rotation failure.
- The HTTP interface this action is exposed through.

### Excluded

- Routine/scheduled key rotation with an overlap window (future work, not
  this milestone — CONTRACT-002's `retired` status already supports it
  without a schema redesign, but no trigger for it exists or is designed
  here).
- Per-user revocation (explicitly out of scope, per TASK-009's own Context
  section and Patrick's prior decision).
- The broader centralized-vs-per-app break-glass rollout question (NOTES.md
  §5), including CDMS's own break-glass admin design or any future
  consuming-app's break-glass path — this contract governs only
  BTAuthOrchestrator's own emergency-rotation trigger.
- Any general-purpose admin UI, admin session/login system, or role
  management. This credential authorizes exactly one action and must not be
  treated as, or evolved into, a general admin credential without a fresh
  authorization design.
- Rate limiting, lockout, or brute-force throttling on the trigger endpoint
  (see Open questions).
- Alerting/notification (e.g. Slack, email) on trigger (see Open questions).
- Network-topology controls (e.g. VPN-only/firewall restriction on the
  endpoint) beyond the credential check itself (see Open questions).
- Rotating or revoking the emergency-rotation credential itself once
  provisioned (see Required behavior and Open questions).
- The PGlite migration that adds this contract's audit table — this
  contract specifies the schema; which task file applies the migration is
  not prescribed here (see Open questions).

## Actors

- **Emergency-rotation administrator** — a human (initially Patrick, and
  any other individual he explicitly entrusts with the credential) who
  possesses the dedicated credential this contract defines. Not
  synonymous with "any staff member who can sign in via Entra" — an
  ordinary, valid `bt_session` cookie/session grants no authority to
  trigger this action (see Required behavior).
- **BTAuthOrchestrator process** — checks the presented credential, performs
  key generation, invokes CONTRACT-002's rotation interface, and writes the
  audit record.
- **CONTRACT-002 storage layer** (indirect actor) — supplies
  `rotateSigningKey` and the signing-key schema this action mutates; this
  contract adds a new audit table alongside it (see Interfaces).
- **Reverse proxy (Caddy, per TASK-003d)** — terminates TLS in front of this
  endpoint, same as CONTRACT-001's `/auth/login`/`/auth/callback`; this
  contract requires the same TLS-only exposure (see Preconditions).

## Inputs and outputs

**Inputs:**
- `EMERGENCY_ROTATION_TOKEN` (from `.env` / process environment) — the
  dedicated credential; see "Required behavior" for format and provisioning.
- An HTTP `POST` request to the trigger endpoint, carrying an `Authorization:
  Bearer <token>` header and an optional JSON body `{ "triggeredBy":
  "<free text>" }`.
- A freshly generated RS256 key pair, generated in-process by this action's
  own code at trigger time (per CONTRACT-002's "Interface to TASK-009" —
  key generation is this action's own responsibility, using the same
  2048-bit RSA / PKCS8-PEM-private / SPKI-PEM-public shape CONTRACT-002's
  bootstrap uses).

**Outputs:**
- On success: an HTTP 200 response confirming rotation, naming the new and
  previous `kid` (public, non-secret identifiers already destined for
  JWKS — not a disclosure).
- On failure: a generic, non-revealing HTTP error response (401-class for
  credential failures, 500-class for internal/rotation failures).
- A durable audit record for every trigger attempt, success or failure (see
  "Required behavior" and "Interfaces").
- The side effects already defined by TASK-009/CONTRACT-002: a new
  `signing_keys` row with `status = 'current'`; the previously current row
  transitioned directly to `status = 'revoked'` (no `retired` intermediate
  state); JWKS immediately reflecting only the new key.

## Preconditions

- `EMERGENCY_ROTATION_TOKEN` is present in `.env` before the process starts,
  is non-empty, and is at least 32 characters. If absent or too short, the
  process must fail closed at startup — see Failure behavior. (Format is
  intentionally looser than `DB_ENCRYPTION_KEY`'s exact-hex/32-byte
  requirement, since this value is compared as an opaque bearer credential,
  not decoded into an AES key — see Open questions #4.)
- CONTRACT-002's storage layer is available and seeded: exactly one
  `signing_keys` row has `status = 'current'` before this action is ever
  successfully triggered (CONTRACT-002's own invariant).
- A migration adding this contract's `emergency_rotation_audit` table (see
  Interfaces > Schema) has been applied to `PGLITE_DATA_DIR` before this
  endpoint serves any request. This contract defines the schema; it does
  not own or assign the migration task (see Open questions #8).
- BTAuthOrchestrator's origin is served over TLS (TASK-003d), identical to
  CONTRACT-001's precondition for `/auth/login`/`/auth/callback`. This
  endpoint carries a bearer credential in a header and must never be
  reachable over a plain-HTTP listener path — a credential sent over
  unencrypted HTTP is interceptable on the network path to the host.
- CONTRACT-002's single-process constraint holds (already a precondition of
  the storage layer this action depends on).

## Required behavior

### 1. Credential: a dedicated, shared bearer token — not a per-user session

**Decision: a single, long, random, `.env`-configured shared secret,
`EMERGENCY_ROTATION_TOKEN`, distinct from and unrelated to any Entra
identity, `bt_session` cookie, or `CLIENT_SECRET`.** Provisioned by the
operator (e.g. via `openssl rand -hex 32`, non-normative guidance, matching
the pattern already established for `DB_ENCRYPTION_KEY`), written into
`.env`, and read directly from `process.env` at startup — the same
mechanism class `config.ts` already uses for every other required
environment value. It is **not** stored in PGlite: unlike `CLIENT_SECRET`
(a CONTRACT-002-managed application secret retrieved routinely at login
time), this credential exists only to gate one rare, high-consequence
action, and keeping it in `.env` avoids any dependency between "can I
authenticate this trigger" and "is PGlite reachable/decryptable" beyond
what the trigger's own effect already requires. See Open questions #1–#3
for the alternatives considered and rejected.

This credential is deliberately **not** an Entra-issued or
BTAuthOrchestrator-minted session token, and an otherwise-valid `bt_session`
cookie (CONTRACT-001) grants **no** authority to trigger this action under
any circumstance. This is intentional, not an oversight: gating a mass
global-logout action behind the very session mechanism it might need to
invalidate (e.g. an incident where the concern is a compromised Entra
account or compromised laptop) would be circular, and conflating it with
"any signed-in staff member" is a materially different (much broader) trust
boundary than TASK-009's "who can trigger a mass logout of every user in
the org" framing calls for.

### 2. Request authentication

On every request to the trigger endpoint (see Interfaces):

1. Read the `Authorization` header. It must be present and match exactly
   the scheme `Bearer <token>` (case-sensitive `Bearer`, exactly one space).
   Any other or missing value is an authentication failure.
2. Compare the extracted token against `EMERGENCY_ROTATION_TOKEN` using a
   constant-time comparison (e.g. Node's `crypto.timingSafeEqual` over
   equal-length UTF-8 byte buffers; unequal lengths are treated as an
   immediate mismatch without a data-dependent comparison of contents) —
   never a `===`/`==` string comparison, to avoid a timing side channel on
   a long-lived, high-value shared secret.
3. On mismatch or malformed header, authentication fails (see Failure
   behavior) — the response does not distinguish "missing header" from
   "wrong token" from "malformed scheme."

The credential value itself must never appear in any log line, audit
record, response body, or error message, in either the success or failure
path — same posture CONTRACT-002 already requires for `DB_ENCRYPTION_KEY`
and `CLIENT_SECRET`.

### 3. Rotation, atomically, no overlap window

On successful authentication:

1. Generate a fresh RS256 key pair in-process (2048-bit RSA, PKCS8 PEM
   private key, SPKI PEM public key — the same parameters CONTRACT-002's
   bootstrap and rotation interface already assume; this contract does not
   re-specify key-generation parameters).
2. Assign a fresh `kid` via `crypto.randomUUID()`, consistent with
   CONTRACT-002's existing `kid` generation scheme.
3. Call CONTRACT-002's `rotateSigningKey({ newKid, algorithm: 'RS256',
   publicKeyPem, privateKeyPem, previousKeyDisposition: 'revoke' })`. This
   is the emergency path: the previously current key transitions directly
   to `revoked`, never passing through `retired`, and is immediately
   excluded from `listPublishableSigningKeys()`/JWKS — no overlap window,
   matching TASK-009's Scope.
4. Persist an audit record of this attempt (see §4) that never diverges
   from whether the rotation in step 3 actually committed — see
   "Postconditions and invariants" for the exact atomicity requirement, and
   Open questions #7 for the implementation-composition question this
   raises against CONTRACT-002's current interface shape.
5. Respond 200 with the new and previous `kid` values and the rotation
   timestamp.

### 4. Minimal audit trail

Every trigger **attempt** — successful or failed — produces exactly one row
in a new table, `emergency_rotation_audit` (schema in "Interfaces"),
recording at minimum: when the attempt occurred, whether it succeeded, an
operator-self-asserted (not verified) label if supplied, a best-effort
source IP, and — for successful attempts — the previous and new `kid`.
"Who" in this design is necessarily "the holder of a valid
`EMERGENCY_ROTATION_TOKEN`, from this source address, optionally
self-identified as `<triggeredBy>`" — a shared static secret cannot provide
cryptographically verified per-individual attribution without a heavier
mechanism. This limitation is real and is called out explicitly in Open
questions #2 rather than silently accepted.

Failed authentication attempts are also recorded (`result = 'failure'`), to
give the operator a way to notice a pattern of guesses against the
credential, even though no lockout/throttling is implemented in this
version (see Open questions #9).

If the audit-table write itself cannot be performed (e.g. PGlite
unreachable) on a failure path, the process must still emit a server-side
log line recording at minimum a timestamp and failure category (never the
credential value or any secret material) as a backstop — see Failure
behavior.

### 5. Concurrent trigger attempts

No lock, dedup window, or rejection is applied to concurrent authenticated
trigger requests. Each authenticated request independently generates its
own key pair and calls `rotateSigningKey`; CONTRACT-002's existing
transactional guarantee (exactly one `current` row, always) serializes
concurrent calls at the database level. The practical effect of two
near-simultaneous triggers is two consecutive rotations — the second
immediately revokes the key the first just made current — which is
correct, not an error: the end state (a fresh current key, every previously
issued token invalidated) is the intended outcome regardless of how many
authenticated triggers contributed to reaching it. Both attempts succeed
and both produce a `result = 'success'` audit row. See Open questions #6
for the alternative (reject the second with 409) considered and rejected.

### 6. Rotating the credential itself

This contract defines no in-app mechanism to rotate or revoke
`EMERGENCY_ROTATION_TOKEN`. If it is ever suspected compromised, the
operator edits `.env` and restarts the process — the same manual-edit
posture CONTRACT-002 already accepts for `DB_ENCRYPTION_KEY` re-keying
(full reset, not live rotation). A restart briefly makes the trigger
endpoint unavailable (consistent with any other config change); this is
accepted, not a gap this contract is expected to close.

## Postconditions and invariants

**Postconditions (true after a successful trigger):**
- Exactly one `signing_keys` row has `status = 'current'` (the newly
  generated key); the immediately prior current key now has
  `status = 'revoked'` and a populated `revoked_at`.
- `listPublishableSigningKeys()`/JWKS no longer includes the previous key
  from the moment `rotateSigningKey` commits.
- Exactly one new row exists in `emergency_rotation_audit` with
  `result = 'success'`, correctly naming the previous and new `kid`.

**Invariants (always true):**
- `EMERGENCY_ROTATION_TOKEN` never appears in any log line, audit row,
  response body, or error message.
- A successful key rotation (a committed `rotateSigningKey` call from this
  action) and a `result = 'success'` audit row always occur together —
  never one without the other. If this cannot be guaranteed atomically at
  the database level with the exact composition of CONTRACT-002's current
  `rotateSigningKey` function, that is a real implementation question this
  contract does not resolve unilaterally — see Open questions #7.
- No signing-key transition other than `current → revoked` is produced by
  this action (this action never sets `retired`; that status is reserved
  for future routine rotation).
- An otherwise-valid `bt_session` cookie, by itself, never authorizes this
  endpoint.
- `PGLITE_DATA_DIR`'s single-process and permission invariants (CONTRACT-002)
  continue to hold; this contract introduces no new process or storage
  location.

## Failure behavior

| Condition | Required behavior |
|---|---|
| `EMERGENCY_ROTATION_TOKEN` missing or shorter than 32 characters at process startup | Fail closed before serving any request — same posture as `DB_ENCRYPTION_KEY`. Clear, non-secret-revealing error naming the missing/invalid variable. |
| `Authorization` header missing, malformed, or not matching `EMERGENCY_ROTATION_TOKEN` | 401-class response, generic body (e.g. `{"error":"Unauthorized"}`); does not reveal which specific check failed. An audit row with `result = 'failure'` is written (best effort — see below). |
| Audit-row write fails on a failure path (e.g. database unreachable) | Do not block the 401/500 response on this write. Emit a server-side log line as a backstop (timestamp, failure category only — no secret material). Never surface this internal detail to the caller. |
| Key generation or `rotateSigningKey` fails after successful authentication (e.g. database unreachable, transaction failure) | 500-class response, generic body (e.g. `{"error":"Unable to complete emergency rotation"}`), never a stack trace or raw DB error. No partial `signing_keys` row is left (CONTRACT-002's own transactional guarantee). A `result = 'failure'` audit row is written if the database is reachable enough to accept it; if not, the log-line backstop above applies. |
| Two or more authenticated trigger requests arrive concurrently | Not an error — see Required behavior §5. Each is processed independently; the database serializes the underlying transactions. |
| A request to the trigger endpoint with a wrong HTTP method or wrong path | Falls through to the existing generic 404 "Not found" response already used for every other unmatched route (`src/index.ts`) — this deliberately does not distinguish "endpoint exists, wrong method" from "no such endpoint," avoiding confirming the endpoint's existence to an unauthenticated prober. |
| Request body's optional `triggeredBy` field is missing, empty, or not a string | Stored as `null` in the audit row. Never rejected or treated as a failure — this field is a convenience label only, never part of the authorization decision. |

## Interfaces

**HTTP endpoint:**

| Method & path | Purpose |
|---|---|
| `POST /admin/emergency-rotate-keys` | Authenticates via `Authorization: Bearer <EMERGENCY_ROTATION_TOKEN>`; on success, performs the rotation in Required behavior §3 and returns the result. |

Request body (optional, JSON): `{ "triggeredBy"?: string }` — free text,
unverified, echoed into the audit row only.

Success response (200): `{ "status": "rotated", "previousKid": string |
null, "newKid": string, "rotatedAt": "<ISO 8601>" }`. Response includes
`Cache-Control: no-store`, consistent with the JWKS endpoint's existing
posture toward this kind of security-sensitive, never-cache response.

Failure responses: 401-class per "missing/invalid credential" above;
500-class per "internal/rotation failure" above. Neither ever includes the
credential value, private key material, or a raw stack trace, matching
CONTRACT-001's existing "failure responses are never raw errors" posture.

**Schema — new table `emergency_rotation_audit`:**

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | Application-generated `crypto.randomUUID()`, matching CONTRACT-002's `kid`-generation convention (no dependency on a Postgres UUID/crypto extension). |
| `triggered_at` | timestamptz, not null, default now() | |
| `result` | text, not null | Exactly `'success'` or `'failure'`. |
| `triggered_by` | text, nullable | Operator-self-asserted label from the request body. Never verified; never used in the authorization decision. |
| `source_ip` | text, nullable | Best-effort. The proxy-forwarded original client address (e.g. first `X-Forwarded-For` entry) where the request arrives via the configured reverse proxy (TASK-003d); otherwise the raw socket peer address. Audit metadata only — never used in the authorization decision, so a spoofed value carries no privilege-escalation risk, only reduced audit fidelity. |
| `previous_kid` | text, nullable | Null if authentication failed before a rotation was attempted. |
| `new_kid` | text, nullable | Null unless `result = 'success'`. |
| `failure_reason` | text, nullable | Short, non-secret-revealing category (e.g. `'bad_credential'`, `'rotation_error'`). Populated only when `result = 'failure'`. |

Rows are never deleted or modified by this contract's own behavior — no
retention/cleanup policy is required (mirrors CONTRACT-002's stance on
`signing_keys` history).

**Interface to CONTRACT-002:** this action calls
`rotateSigningKey({ newKid, algorithm: 'RS256', publicKeyPem, privateKeyPem,
previousKeyDisposition: 'revoke' })`, exactly as CONTRACT-002's own
"Interface to TASK-009" section anticipates. This contract does not modify
CONTRACT-002's interface; see Open questions #7 for the open question this
raises about atomically composing that call with the audit-row write.

**No new interface to CONTRACT-001.** This action does not read, set, or
depend on the `bt_session` cookie in any way.

## UX expectations

No browser-facing admin UI is provided or required in this milestone
(consistent with CONTRACT-001's "no admin UI" exclusion and this being a
deliberately rare, break-glass-style action, not routine admin tooling).
The operator is expected to trigger this endpoint with `curl` or an
equivalent HTTP client capable of setting a bearer header — from any device
with network access to the host (a laptop, or a phone with a terminal app),
not necessarily one with SSH/shell access to the host itself. A minimal
HTML trigger page, if ever wanted, is out of scope here (see Open
questions #1 for the alternative CLI-only design considered and rejected,
which would have required host shell access instead).

## Validation requirements

- Trigger with a correct token: confirm 200 with populated `previousKid`/
  `newKid`; confirm exactly one new `signing_keys` row with
  `status = 'current'`; confirm the previous row transitions directly to
  `status = 'revoked'` with no intermediate `retired` state; confirm a
  token minted under the now-revoked key fails JWKS-based verification
  immediately; confirm exactly one new `result = 'success'` audit row,
  correctly naming both kids.
- Trigger with a missing, malformed, or incorrect `Authorization` header:
  confirm 401-class response with a generic body; confirm no `signing_keys`
  row is inserted or altered; confirm a `result = 'failure'` audit row is
  written (or the log-line backstop fires if the database is made
  unreachable for this test).
- Start the process with `EMERGENCY_ROTATION_TOKEN` unset or under 32
  characters: confirm the process fails to start, mirroring
  `DB_ENCRYPTION_KEY`'s existing startup-validation behavior.
- Present a valid `bt_session` cookie alone (no `Authorization` header) to
  the trigger endpoint: confirm 401 — a signed-in session never
  substitutes for the dedicated credential.
- Fire two authenticated trigger requests concurrently: confirm exactly one
  `current` row exists afterward, two `result = 'success'` audit rows
  exist, and no corrupted/partial `signing_keys` row is left.
- Inspect logs and audit rows after both a success and a failure trigger:
  confirm `EMERGENCY_ROTATION_TOKEN`'s value never appears anywhere.
- Supply and omit the optional `triggeredBy` field across two triggers:
  confirm it is stored verbatim when present and `null` when absent, and
  confirm an arbitrary/incorrect value in this field has no effect on
  whether the request is authorized.
- Attempt the endpoint over a non-TLS path (if reachable in a test
  environment) and confirm the deployment topology (Caddy/TLS-only
  exposure) prevents this, per Preconditions.

## Open questions

Patrick has not yet reviewed this contract. Every judgment call below is a
genuine decision point, not settled by existing project documentation, and
is flagged here rather than buried in prose so it can be approved, amended,
or rejected quickly.

1. **HTTP endpoint + shared bearer token, vs. a CLI script gated by host
   shell access (mirroring `scripts/seed.js`).** I chose the HTTP endpoint
   because (a) TASK-009 explicitly frames this as Patrick's "kill switch,"
   which reads as something one should be able to trigger quickly from
   wherever one happens to be, not only from a terminal already
   SSH'd into the host, and (b) NOTES.md's own break-glass precedent
   (CDMS's fallback admin) is itself HTTP-reachable, not CLI-only. The
   tradeoff: a CLI script gated purely by host shell access would need no
   new secret to manage/leak at all (SSH access is already the trust
   boundary the bootstrap script relies on) and would avoid putting a
   bearer credential on the network, even over TLS. If Patrick expects to
   only ever trigger this from a host he's already SSH'd into, the CLI
   design is simpler and has less exposed surface — worth an explicit
   choice rather than my default.

2. **A single shared token vs. multiple named tokens (one per trusted
   admin).** I chose a single shared `EMERGENCY_ROTATION_TOKEN` for
   simplicity, but this means the audit trail's "who" can only ever be a
   self-asserted, unverified `triggeredBy` label — anyone possessing the
   token is indistinguishable from anyone else who does. If Patrick
   anticipates ever sharing this capability with a second person (a
   backup on-call engineer, say) and wants real attribution or the
   ability to revoke one person's access without changing everyone's
   credential, a small named-token scheme (e.g.
   `EMERGENCY_ROTATION_TOKENS=patrick:<token1>,backup:<token2>`) is only
   slightly more complex and directly solves this. I did not choose it by
   default because today there is exactly one intended holder (Patrick).

3. **Credential storage: `.env` plaintext vs. CONTRACT-002's encrypted
   `secrets` table.** I chose `.env`, matching `DB_ENCRYPTION_KEY`'s
   treatment, because this credential's entire purpose is independent of
   whether PGlite is currently readable, and storing it in PGlite would
   require extending the bootstrap/seed flow (or a new one-time
   provisioning step) purely to seed it. Reasonable, but worth confirming
   given CONTRACT-002 already provides an encrypted-storage primitive this
   could have used instead, at the cost of a small bootstrap addition.

4. **Token format: minimum 32 characters, no fixed encoding**, unlike
   `DB_ENCRYPTION_KEY`'s exact 64-hex-character requirement. I loosened
   this because the token is compared as an opaque bearer value, not
   decoded into an AES key, so there's no cryptographic reason to fix its
   encoding — but the exact minimum-length threshold (32) is my own
   arbitrary choice, not derived from any stated requirement.

5. **Endpoint path (`POST /admin/emergency-rotate-keys`) and response
   shape** are both my own naming choices, easy to change without any
   other consequence — flagged only because naming is otherwise silently
   locked in once implemented.

6. **Concurrent triggers are allowed to both succeed (two consecutive
   rotations) rather than having the second rejected (e.g., 409).** I
   judged "allow both" simpler and strictly safer than adding a
   lock/rejection path for what should be an exceedingly rare race in
   practice — but if Patrick wants a hard guarantee of "exactly one
   rotation per human-perceived kill-switch press," an explicit advisory
   lock with a 409 response on the loser is the alternative.

7. **Atomicity between the audit-row write and the `rotateSigningKey` call
   is a required outcome in this contract, but CONTRACT-002's
   `rotateSigningKey` currently manages its own internal transaction and
   accepts no external transaction handle** (per `src/secrets.ts` as
   implemented today). Achieving "never one without the other" cleanly may
   require either (a) TASK-009 bypassing `rotateSigningKey` and
   implementing the revoke+insert+audit sequence directly against the
   schema in one transaction itself, or (b) a small extension to
   CONTRACT-002's interface to accept an externally-supplied transaction.
   I did not resolve this by unilaterally amending CONTRACT-002 — it's
   flagged here as a real design touchpoint between the two contracts
   for Patrick (or a contract-designer pass on CONTRACT-002) to settle
   before implementation.

8. **This contract requires a new `emergency_rotation_audit` table that no
   completed or approved task currently owns creating.** TASK-005 (schema/
   migrations) is already completed and didn't anticipate this table;
   TASK-009's own Plan doesn't currently mention a migration step. Either
   TASK-009's scope needs a small addition (add this migration) or a new
   task should be filed for it before implementation starts.

9. **No rate limiting, lockout, or throttling on failed authentication
   attempts.** The token is high-entropy (32+ random characters), so
   practical brute force over the network is not a realistic risk within
   any human timescale — but I'm flagging the absence of any
   attempt-limiting explicitly rather than silently omitting it, since
   this is exactly the kind of control a "kill switch" endpoint might
   reasonably be expected to have. The failed-attempt audit row at least
   makes a guessing pattern observable after the fact.

10. **No network-topology restriction (e.g., VPN-only / internal-firewall
    rule) is required by this contract beyond the credential check
    itself.** NOTES.md describes split-horizon DNS/Cloudflare DNS-01
    certs for `orca.biztechro.com`, which suggests the origin may be
    reachable beyond the internal network in some configuration I don't
    have full visibility into. If this endpoint should additionally be
    restricted to an internal-only network path as defense in depth (so a
    leaked token alone isn't sufficient from anywhere on the internet),
    that's a deployment/firewall decision outside what this contract can
    settle, and is worth an explicit call.

11. **No alerting/notification is required when this action fires.** A
    Slack or email notification on every trigger (success or failure)
    would materially improve incident awareness for an action this
    consequential, but adds a new external dependency this contract
    intentionally avoids introducing. Worth considering as a fast-follow,
    not blocking this milestone.

12. **Trusting the reverse proxy's forwarded client-IP header for the
    audit trail's `source_ip` field** assumes the only path to this
    endpoint is through the configured Caddy proxy (TASK-003d). If the
    process's own port is ever directly reachable bypassing Caddy, this
    header becomes spoofable — low severity, since it's audit metadata
    only and never feeds the authorization decision, but noted for
    completeness.
