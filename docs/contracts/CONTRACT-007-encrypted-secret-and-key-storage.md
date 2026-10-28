# CONTRACT-007: Encrypted secret & key storage in PGlite

Status: Retired
Approved by: Patrick Moon
Approved date: 2026-10-01
Related tasks: TASK-005, TASK-006, TASK-008, TASK-009 (all unaffected —
see "Relationship to CONTRACT-004" below), CONTRACT-001 and CONTRACT-003
(consumers of the Interfaces defined here, unaffected).
Related ADRs: ADR-001 (contracts are retired by supersession, never amended
in place).
Supersedes: CONTRACT-004 (retired in full; see CONTRACT-004's own header and
ADR-001 for why).
Superseded by: CONTRACT-008 (in full; approved by Patrick 2026-10-28)

## Purpose

Define, precisely enough for TASK-005/006/008/009 to implement against
without further architectural decisions, how BTAuthOrchestrator stores and
protects the Entra `CLIENT_SECRET` and its own signing key material at rest
in PGlite: the envelope-encryption scheme, the schema, the one-time
bootstrap/seed interface, the operational preconditions (data-directory
permissions, single-process constraint), and the key-lifecycle model that
supports both emergency rotation (TASK-009) and future routine rotation with
an overlap window.

This contract treats TASK-003's Context section as settled and does not
relitigate it: all secret/key material lives in PGlite (not `.env`),
protected by envelope encryption with a key-encrypting key (`DB_ENCRYPTION_KEY`)
that lives only in `.env`; the data directory is additionally hardened via
OS permissions; the service is single-process; and signing keys are tracked
by `kid` and status to allow more than one simultaneously valid key.

**Relationship to CONTRACT-004:** this contract supersedes CONTRACT-004 in
full (ADR-001). Every section below is identical to CONTRACT-004 except the
data-directory bullet in Preconditions, "Data-directory permissions" (§5),
the matching Postconditions bullet and Failure behavior row, and the new
Resolved decision #17, which add a Windows host alternative to the POSIX
`0700`/owner requirement. The service-side check is unchanged on POSIX
hosts; on Windows it is replaced by an owner-only ACL applied by the
`start.ps1` launcher, because Windows exposes no POSIX mode bits or uids to
Node. Nothing else changed; no other task's implementation is affected.

**Relationship to CONTRACT-002 (carried forward from CONTRACT-004):**
CONTRACT-004 superseded CONTRACT-002 in full (ADR-001). Every section below is identical to CONTRACT-002 except
"Key lifecycle" (§3), "Interfaces," the rotation-related "Validation
requirements" bullet, and "Resolved decisions" #13, which are rewritten to
match TASK-009's actual, independently-verified implementation rather than
CONTRACT-002's originally-specified (and never-implemented)
`rotateSigningKey`/`revokeKey` shape. TASK-005, TASK-006, and TASK-008's
implementations are unaffected — nothing in the sections they were built
against changed.

## Scope

### Included

- Schema for signing keys (`kid`, algorithm, status, encrypted private key
  material, created/rotated timestamps) and a generic encrypted-secrets
  store (for `CLIENT_SECRET` and similar).
- The envelope-encryption scheme and exact algorithm/parameters (AES-256-GCM,
  key sourcing, IV/auth-tag handling, what is and is never stored).
- The bootstrap/seed interface: a concrete, implementable specification for
  TASK-006, with no code path that leaves a secret in shell history or a
  long-lived plaintext file.
- Data-directory permission requirements, stated as explicit
  preconditions/invariants.
- The single-process constraint, stated as an explicit
  precondition/invariant.
- The key-lifecycle model (statuses/fields) supporting emergency rotation
  (drop old key immediately, atomically coupled to its audit record) as
  actually built by TASK-009.
- The module-boundary interface (function-level shape) that CONTRACT-001,
  TASK-008, and TASK-009 build against.

### Excluded

- The OIDC login flow itself, including how `CLIENT_SECRET` and the signing
  key are *used* during login/token-exchange/minting (CONTRACT-001's
  territory; this contract only defines how those values are stored and
  retrieved).
- TASK-009's own authorization/audit design for *who* may trigger emergency
  rotation and how that trigger is audited, and the shape of the
  `emergency_rotation_audit` table itself (CONTRACT-003's territory). This
  contract only guarantees that its own storage-layer function atomically
  couples a key rotation to one row insert in that externally-defined
  table — see Interfaces.
- Future routine (non-emergency, overlap-window) key rotation's interface —
  see Open questions. The schema still supports it (the `retired` status
  and `retired_at` column are unused but present); no function interface
  for it is specified by this contract.
- Rotating `DB_ENCRYPTION_KEY` itself (the key-encrypting key) — see
  Resolved decisions #14.
- Backup/restore strategy for the PGlite data directory — see Resolved
  decisions #15.
- Deployment mechanics for the dedicated service OS user (creation,
  systemd unit configuration) — this contract states the permission
  *requirement*, not how an operator provisions the user.

## Actors

- **Bootstrap operator** — a human with shell access to the host, who runs
  the one-time seed process (TASK-006) to get `CLIENT_SECRET` and the
  initial signing key into PGlite.
- **BTAuthOrchestrator process** — the single Node process that reads and
  writes encrypted rows in PGlite via the interface this contract defines.
- **CONTRACT-001 login flow** (indirect consumer) — retrieves the current
  decrypted `CLIENT_SECRET` and the current signing key at login/token-mint
  time.
- **TASK-008 JWKS endpoint** (indirect consumer) — retrieves all
  publishable (non-revoked) public key material.
- **TASK-009 emergency rotation trigger** (indirect consumer) — invokes this
  contract's `rotateSigningKeyEmergency` to atomically insert a new current
  key, revoke the previous one, and write its own success audit row; owns
  its own authorization/audit design (CONTRACT-003) on top of this
  interface.
- **`DB_ENCRYPTION_KEY`** (environment input, not a running actor) — the
  key-encrypting key, sourced from `.env` only, and never written to PGlite
  or any other durable store this contract controls.
- **The host filesystem/OS** — enforces the data-directory permission
  requirement as a second, independent layer of protection alongside
  encryption.

## Inputs and outputs

**Inputs:**
- `DB_ENCRYPTION_KEY` (from `.env` / process environment) — see "Envelope
  encryption scheme" below for format.
- `PGLITE_DATA_DIR` (from `.env`) — filesystem path to the PGlite data
  directory.
- At bootstrap only: the operator-supplied Entra `CLIENT_SECRET` plaintext
  value (via the seed interface, never as a bare CLI argument).
- At bootstrap only: a generated RS256 key pair (generated in-process by the
  seed script; the plaintext private key never originates outside the
  process that immediately encrypts it).
- At emergency-rotation time (TASK-009): a newly generated RS256 key pair
  and an audit context (`triggeredBy`, `sourceIp`), supplied to this
  contract's `rotateSigningKeyEmergency`.

**Outputs:**
- Encrypted rows in PGlite: ciphertext, IV, and authentication tag for each
  protected value, plus non-secret metadata (`kid`, `algorithm`, `status`,
  public key material, timestamps).
- Decrypted plaintext values (`CLIENT_SECRET`, a signing private key)
  returned in-memory to an authorized in-process caller (CONTRACT-001,
  TASK-008) — never written back to disk, logged, or included in any HTTP
  response by this contract's own code paths.
- A queryable set of "publishable" signing keys (public material only,
  `status IN ('current', 'retired')`) for TASK-008's JWKS endpoint to
  render.
- One row written into CONTRACT-003's `emergency_rotation_audit` table per
  successful `rotateSigningKeyEmergency` call, in the same transaction as
  the key rotation itself (see Interfaces).

## Preconditions

- `.env` contains a valid `PGLITE_DATA_DIR` and `DB_ENCRYPTION_KEY` before
  the BTAuthOrchestrator process starts. `DB_ENCRYPTION_KEY` is exactly 64
  lowercase hexadecimal characters, decoding to exactly 32 raw bytes (an
  AES-256 key). If it is absent, malformed, or the wrong length, the process
  must fail closed at startup — see Failure behavior.
- TASK-005's schema/migrations have already been applied to
  `PGLITE_DATA_DIR` before any function in this contract's Interfaces
  section is called.
- `PGLITE_DATA_DIR` is owned by a dedicated service OS user (not a shared or
  general-purpose account, not root) and is mode `0700` (owner
  read/write/execute only, no group or world access) at all times the
  process is running. On a Windows host the equivalent is an NTFS ACL
  granting full control to the owning service account only, with
  inheritance from the parent removed (see §5). This is defense in depth *in addition to*, not
  instead of, encryption — a filesystem-level compromise that stops short of
  full OS-user compromise (e.g. a misconfigured sibling service, a
  world-readable backup job) must not expose PGlite's on-disk files to
  anything but the dedicated service user.
- BTAuthOrchestrator runs as a single OS process against `PGLITE_DATA_DIR`.
  No clustering, no multi-worker process model, no second instance pointed
  at the same data directory — concurrently or sequentially without a clean
  shutdown of the prior instance. A second process attempting to open an
  already-open data directory fails fast and observably rather than
  corrupting data or silently degrading.
- The bootstrap/seed process (TASK-006) has been run successfully at least
  once before CONTRACT-001's login flow is exercised — a database with zero
  rows in `secrets` or zero rows with `status = 'current'` in `signing_keys`
  is a valid *pre-bootstrap* state, not an error condition of this
  contract's schema itself, but CONTRACT-001 cannot function until bootstrap
  has run (already stated as CONTRACT-001's own precondition).

## Required behavior

### 1. Envelope encryption scheme

- **Algorithm:** AES-256-GCM.
- **Key:** `DB_ENCRYPTION_KEY`, decoded from its 64-character hex
  representation in `.env` into 32 raw bytes, used directly as the AES-256
  key. It is never derived into, wrapped by, or stored alongside a
  per-value data-encryption key inside PGlite — there is exactly one key,
  it lives only in `.env`/process environment, and it directly encrypts
  every protected value. (See "Resolved decisions" for why this
  single-layer construction, rather than a two-layer per-value DEK design,
  satisfies TASK-003's "envelope encryption" framing.)
- **IV:** 12 random bytes (96 bits), freshly generated via a
  cryptographically secure random source for every individual encryption
  operation. An IV must never be reused with the same key for two different
  plaintexts.
- **Authentication tag:** 16 bytes (128 bits), produced by AES-256-GCM as
  part of the encryption operation.
- **Additional authenticated data (AAD):** the UTF-8 bytes of the
  protected row's own stable identifier — the `name` column value for rows
  in `secrets`, the `kid` column value for the private-key column in
  `signing_keys`. This binds each ciphertext to the specific row it belongs
  to, so that swapping ciphertext/IV/tag values between two rows (e.g. via
  direct DB manipulation) fails decryption instead of silently succeeding
  with the wrong plaintext under the wrong label.
- **What is stored in PGlite:** ciphertext, IV, and authentication tag, per
  protected value, plus non-secret metadata (see Schema below).
- **What is never stored in PGlite, `.env`, a log, or any response:**
  plaintext `CLIENT_SECRET`, plaintext private key material, and
  `DB_ENCRYPTION_KEY` itself.
- **Plaintext encoding before encryption:** `CLIENT_SECRET` is encrypted as
  its raw UTF-8 bytes. Signing private keys are encrypted as the UTF-8 bytes
  of their PKCS8 PEM serialization (see Schema below).

### 2. Schema

**Table `secrets`** — generic encrypted key-value store for `CLIENT_SECRET`
and any future similar values (e.g., a future non-Entra credential):

| Column | Type | Notes |
|---|---|---|
| `name` | text, primary key | Stable identifier, e.g. `'CLIENT_SECRET'`. Also serves as the AES-GCM AAD for this row. |
| `ciphertext` | bytea, not null | AES-256-GCM ciphertext of the plaintext value. |
| `iv` | bytea, not null | 12-byte IV used for this row's encryption. |
| `auth_tag` | bytea, not null | 16-byte GCM authentication tag. |
| `created_at` | timestamptz, not null, default now() | |
| `updated_at` | timestamptz, not null, default now() | Updated on any overwrite of this row (e.g. a future manual `CLIENT_SECRET` update, outside this milestone's flow but supported by the schema without redesign). |

**Table `signing_keys`** — signing key material and lifecycle state:

| Column | Type | Notes |
|---|---|---|
| `kid` | text, primary key | Opaque key identifier — see "Resolved decisions" for generation scheme. |
| `algorithm` | text, not null | e.g. `'RS256'`. Application-validated against a small allow-list, not DB-constrained, so a future algorithm (e.g. `'ES256'`) needs no schema change. |
| `status` | text, not null | One of exactly `'current'`, `'retired'`, `'revoked'` — see "Key lifecycle" below. |
| `public_key` | text, not null | PEM (SPKI) encoding of the public key. Plaintext — public key material is not secret and is exactly what the JWKS endpoint publishes (after TASK-008 converts it to JWK `n`/`e` form). |
| `private_key_ciphertext` | bytea, not null | AES-256-GCM ciphertext of the PKCS8 PEM private key. |
| `private_key_iv` | bytea, not null | 12-byte IV. |
| `private_key_auth_tag` | bytea, not null | 16-byte GCM authentication tag. |
| `created_at` | timestamptz, not null, default now() | When this key was generated/inserted. |
| `retired_at` | timestamptz, nullable | Unused by any function this contract currently specifies (no routine-rotation interface exists yet — see Open questions); reserved for that future work. |
| `revoked_at` | timestamptz, nullable | Set when this key transitions to `revoked` (from `current` directly via `rotateSigningKeyEmergency`). |

**Invariant:** at all times after the bootstrap/seed process completes
successfully, exactly one row in `signing_keys` has `status = 'current'` —
never zero, never more than one. Implementers may enforce this with a DB
constraint (e.g. a partial unique index) or with transactional
application logic; this contract requires the outcome, not the mechanism.

Migration ownership (which tool/format expresses this schema, e.g. raw SQL
files vs. a migration library) is TASK-005's implementation choice and is
intentionally not prescribed here.

### 3. Key lifecycle

Exactly three statuses:

- **`current`** — the one key actively used to sign new tokens. Published
  in JWKS.
- **`retired`** — no longer used to sign new tokens, but still published in
  JWKS so tokens already signed under it keep verifying. Reserved for
  future routine rotation's overlap window; no function in this contract's
  Interfaces currently produces this transition (see Open questions).
- **`revoked`** — no longer published in JWKS at all. Any token signed
  under this key fails verification from the moment of revocation. Reached
  directly from `current` via `rotateSigningKeyEmergency` (TASK-009's
  emergency rotation: no overlap window, immediate global invalidation).

Transitions specified by this contract:
- `current` → `revoked` (emergency rotation, `rotateSigningKeyEmergency`)
- (new key) → `current` (bootstrap, or emergency rotation)

No other transition is valid (e.g. a `revoked` key is never reactivated). A
fresh signing key is always inserted directly with `status = 'current'`.
The `current` → `retired` and `retired` → `revoked` transitions remain part
of the schema's supported vocabulary but have no producing function in this
contract — see Open questions.

JWKS-publishable set (what TASK-008's endpoint must render, public material
only): all rows with `status IN ('current', 'retired')`. `revoked` rows are
excluded from JWKS but remain in the table (their row is not deleted by
this contract's own behavior — retaining rotation history is a reasonable
default and this contract does not require a retention/cleanup policy).

### 4. Bootstrap/seed interface

A standalone script, invoked as `node scripts/seed.js` from the repository
root (TASK-006's implementation may additionally alias this via an npm
script, e.g. `npm run seed`, but `scripts/seed.js` is the normative entry
point this contract specifies; if implemented in TypeScript, the compiled
output must resolve to this invocation). It is run manually, once, by the
bootstrap operator, after `.env` (including `DB_ENCRYPTION_KEY` and
`PGLITE_DATA_DIR`) is in place and TASK-005's schema has been applied, and
before CONTRACT-001's login flow is exercised for the first time.

**`DB_ENCRYPTION_KEY` is a precondition, not something this script
generates.** The operator supplies it in `.env` before running the script
(e.g. via `openssl rand -hex 32`, non-normative guidance). The script
validates it per "Envelope encryption scheme" above and fails closed if
invalid.

**Determining what needs seeding**, on every invocation:
- If `secrets` has a row named `CLIENT_SECRET` **and** `signing_keys` has a
  row with `status = 'current'`: the database is already fully seeded. The
  script prints "Database already seeded; nothing to do." and exits with a
  non-zero status, making no writes. This is intentionally not a silent
  no-op success — a second accidental invocation must be visibly distinct
  from a successful first run.
- If exactly one of the two is missing (a prior run was interrupted after
  completing one part but not the other): the script seeds only the
  missing piece, leaves the existing piece untouched, and reports exactly
  what it did.
- If both are missing: full first-run bootstrap, both steps below.

**`CLIENT_SECRET` input**, exactly one of:
- **Interactive prompt (default):** a hidden-input prompt (input not
  echoed to the terminal, equivalent to a password prompt), read directly
  from the TTY. The value is never accepted as a bare CLI
  argument/flag value (e.g. `--client-secret=...`), since that would appear
  in shell history and in the process list (`ps`) of every user on the
  host.
- **One-time input file (`--client-secret-file=<path>`):** for
  non-interactive/scripted bootstrap contexts (e.g. a value copied onto the
  host via `scp` ahead of running the script). The script reads the file's
  contents (trimmed of a single trailing newline if present) once, then
  immediately deletes (`unlink`s) the file before performing any further
  step. If the unlink fails, the script aborts immediately, writes nothing
  to PGlite, and prints an explicit error instructing the operator to
  delete the file manually — it never silently proceeds while a plaintext
  copy remains on disk.

In both paths, the plaintext value is held only in local variables scoped
to the seeding routine and is never written to any temporary file, cache,
or log. It is not needed once the encrypt-and-store step for that value
completes. (Node.js cannot guarantee memory is zeroed after use; this is an
accepted limitation, not a gap this script is expected to close.)

**`CLIENT_SECRET` storage:** encrypt per "Envelope encryption scheme" above
(AAD `'CLIENT_SECRET'`) and write to `secrets`.

**Initial signing key generation:** the script generates an RS256 key pair
in-process (2048-bit RSA; see "Resolved decisions"). The plaintext private
key never exists outside this process and is encrypted immediately after
generation, before any write to PGlite. The script assigns a fresh `kid`
(see "Resolved decisions" for the generation scheme) and inserts a row with
`status = 'current'`.

**Output:** on success, the script prints a confirmation naming what was
seeded (e.g. "CLIENT_SECRET stored." / "Signing key <kid> generated and
stored as current.") — never the secret value or private key material, in
success or error output, at any point.

**Re-running is always safe** in the sense that it never silently
overwrites or duplicates an existing `CLIENT_SECRET` row or an existing
`current` signing key; it either completes the missing piece(s) of a
partial bootstrap or refuses entirely. This script is a first-run
bootstrap tool only — it is never the mechanism for rotating `CLIENT_SECRET`
or a signing key; rotation uses the interface in "Interfaces" below, not
this script.

### 5. Data-directory permissions (enforced behavior, not just a fact)

On startup, before opening PGlite, the process must:
- If `PGLITE_DATA_DIR` does not yet exist, create it with mode `0700`,
  owned by the OS user the process runs as (which must be the dedicated
  service user per Preconditions).
- If it already exists, verify it is mode `0700` and owned by the running
  user. If it is not (e.g. group- or world-readable, or owned by a
  different user), refuse to start: fail closed with a clear error naming
  the required `chmod`/`chown`, rather than silently continuing with weaker
  protection or attempting to auto-correct ownership (auto-`chown` on a
  directory owned by a different, unexpected user is a privilege-escalation
  footgun this contract deliberately avoids).

On Windows (`process.platform === 'win32'`), POSIX mode bits and uids are
not available to Node (directories report `0666`/`0777` and
`process.getuid` is undefined), so the process skips the mode and
ownership verification above and the supported launcher, `start.ps1`
(invoked via `start.bat`), enforces the equivalent before starting the
process:
- If `PGLITE_DATA_DIR` exists and is owned by an account other than the one
  running the launcher, refuse to start with a clear error naming the
  required `icacls /setowner` fix. Ownership is never changed
  automatically, matching the POSIX rule.
- Otherwise, replace the directory's ACL with a single full-control entry
  for the running account, with inheritance from the parent removed, and
  reset existing children to inherit only that entry. Unlike the POSIX
  path, the launcher repairs the ACL rather than refusing: re-applying an
  owner-only ACL for the owner can only narrow access, never widen it or
  move it to a different account.
- Starting the process on Windows other than through `start.ps1` (e.g.
  `npm start` directly) bypasses this enforcement; that is an operator
  error, not a supported path.

### 6. Single-process enforcement

The process must not silently tolerate a second concurrent instance against
the same `PGLITE_DATA_DIR`. Whatever mechanism enforces this (PGlite's own
on-disk lock, or an explicit guard added in TASK-005) must produce an
observable, immediate failure on the second instance — not data corruption,
not a hang, not a silently-degraded shared-nothing assumption being
violated.

## Postconditions and invariants

**Postconditions (true after a successful bootstrap):**
- `secrets` contains exactly one row named `CLIENT_SECRET`, with populated
  `ciphertext`/`iv`/`auth_tag`.
- `signing_keys` contains exactly one row with `status = 'current'`, with
  populated `public_key` and encrypted private-key columns.
- No plaintext `CLIENT_SECRET` or private key value exists anywhere on the
  host outside of AES-256-GCM ciphertext inside `PGLITE_DATA_DIR` (in
  particular: not in `.env`, not in a log file, not in a leftover
  `--client-secret-file`, not in shell history).

**Postconditions (true after a successful `rotateSigningKeyEmergency`
call):**
- Exactly one `signing_keys` row has `status = 'current'` (the newly
  generated key); the immediately prior current key (if any) now has
  `status = 'revoked'` and a populated `revoked_at`.
- Exactly one new row exists in CONTRACT-003's `emergency_rotation_audit`
  table with `result = 'success'`, naming the previous and new `kid`.
- These two facts are never observed independently — see Invariants.

**Invariants (always true while the service is running):**
- `DB_ENCRYPTION_KEY` never appears inside PGlite or any file this contract
  writes.
- Exactly one `signing_keys` row has `status = 'current'` at any observable
  moment (no window in which zero or more than one is externally
  observable via this contract's interfaces).
- A `revoked` key's public material is never returned by
  `listPublishableSigningKeys()` (see Interfaces).
- `PGLITE_DATA_DIR` is mode `0700`, owned by the dedicated service user
  (on Windows: owner-only, non-inherited ACL, owned by the service
  account; see §5).
- At most one OS process has `PGLITE_DATA_DIR` open at a time.
- Every row's ciphertext/IV/auth-tag write is atomic: a row is either fully
  present with all three populated and internally consistent, or it does
  not exist — never a partially-written row with a null or mismatched
  ciphertext/IV/tag.
- Decrypting any protected value with an incorrect key, tampered
  ciphertext, tampered IV, or a ciphertext/IV/tag set copied from a
  different row (wrong AAD) always fails (throws) rather than returning
  incorrect plaintext.
- A committed key rotation performed by `rotateSigningKeyEmergency` and its
  `result = 'success'` `emergency_rotation_audit` row are written inside
  one database transaction and therefore always occur together — never a
  rotation without its audit row, never an audit row without the rotation
  it claims happened. This is the atomicity guarantee CONTRACT-003's Open
  question #7 asked for; see Interfaces for how it's achieved.

## Failure behavior

| Condition | Required behavior |
|---|---|
| `DB_ENCRYPTION_KEY` missing, malformed, or not exactly 32 bytes when decoded | Fail closed at process startup, before opening PGlite or serving any request. Clear, non-secret-revealing error message. |
| `PGLITE_DATA_DIR` exists with permissions/ownership other than `0700`/dedicated service user | Fail closed at startup with a clear error naming the required fix. No auto-`chown`. On Windows, `start.ps1` instead re-applies the owner-only ACL, and fails closed with an `icacls /setowner` fix only when the directory is owned by a different account (§5). |
| A second process attempts to open an already-open `PGLITE_DATA_DIR` | Fail fast with a clear error; must not corrupt the database or silently proceed. |
| Decryption of `CLIENT_SECRET` or the current signing key fails (wrong key, tampered/corrupted row) at a point where CONTRACT-001's login flow needs it | Treat as a startup/critical error — the process must not serve login traffic without a decryptable `CLIENT_SECRET` and current signing key. The specific decryption failure reason is logged server-side only, never including the ciphertext, key, or any recovered plaintext fragment. |
| Seed script run against an already-fully-seeded database | Refuse; exit non-zero; make no writes. |
| Seed script's `--client-secret-file` cannot be deleted after being read | Abort before any PGlite write; instruct the operator to delete it manually; exit non-zero. |
| Seed script interrupted mid-write (process killed between generating and storing a value) | No partially-written row is left in a state where it could be read as valid/current (see Postconditions and invariants — atomic per-row writes). A subsequent run detects the missing piece and completes it (see "Determining what needs seeding"). |
| Attempted signing-key status transition other than the valid set in "Key lifecycle" | Reject (throw/error); no such transition is ever written. |
| `rotateSigningKeyEmergency`'s transaction fails partway (e.g. database unreachable mid-write, after a bearer credential has already been authenticated by CONTRACT-003) | The whole transaction rolls back: no partial/new `signing_keys` row, no status change to the previous current key, no `emergency_rotation_audit` success row. The caller (CONTRACT-003's endpoint handler) is responsible for its own separate, best-effort `result = 'failure'` audit write and log-line backstop — this contract's own atomicity guarantee covers only the success path, by construction (a failed transaction commits nothing to couple). |

## Interfaces

The following is the module-boundary interface this contract requires to
exist (function names, parameters, and return semantics are normative;
exact language-level types, the choice of ORM/query builder vs. raw SQL,
and which task file physically implements each function are not
prescribed).

**Envelope encryption primitives:**
```
encryptValue(plaintext: Buffer, aad: string): { ciphertext: Buffer, iv: Buffer, authTag: Buffer }
decryptValue(input: { ciphertext: Buffer, iv: Buffer, authTag: Buffer }, aad: string): Buffer
```
`decryptValue` throws if the AES-GCM authentication tag does not verify
(wrong key, tampered data, or wrong `aad`) — it never returns a value on
tag-verification failure.

**Secrets store:**
```
getSecret(name: string): Promise<string>          // decrypted plaintext; throws if absent or undecryptable
setSecret(name: string, plaintext: string): Promise<void>   // upsert; used by bootstrap and any future manual update
```

**Signing keys:**
```
insertSigningKey(input: {
  kid: string,
  algorithm: string,
  publicKeyPem: string,
  privateKeyPem: string,
}): Promise<void>
// Inserts a new row with status = 'current'. Used by bootstrap when no
// current key exists. Must reject (not silently succeed) if a current key
// already exists.

getCurrentSigningKey(): Promise<{ kid: string, algorithm: string, publicKeyPem: string, privateKeyPem: string }>
// Throws if no row has status = 'current' (a critical/startup-class error
// per Failure behavior once bootstrap is expected to have run).

listPublishableSigningKeys(): Promise<Array<{ kid: string, algorithm: string, publicKeyPem: string, status: 'current' | 'retired' }>>
// Public material only. Never includes 'revoked' rows or any private key
// field. This is what TASK-008's JWKS endpoint renders.

rotateSigningKeyEmergency(
  newKey: { kid: string, algorithm: string, publicKeyPem: string, privateKeyPem: string },
  audit: { triggeredBy: string | null, sourceIp: string | null },
): Promise<{ previousKid: string | null, newKid: string }>
// Atomically, in one transaction: reads the current signing_keys row (if
// any); if one exists, transitions it to status = 'revoked' with
// revoked_at = now(); inserts newKey as the new status = 'current' row;
// inserts one result = 'success' row into CONTRACT-003's
// emergency_rotation_audit table naming previousKid/newKid and the given
// audit context. If any step fails, the whole transaction rolls back —
// see Failure behavior. This is the only function this contract specifies
// for replacing an already-current key; there is no routine
// (previousKeyDisposition: 'retire') mode — see Open questions.

recordEmergencyRotationFailure(
  input: { triggeredBy: string | null, sourceIp: string | null, failureReason: string },
): Promise<void>
// Inserts one result = 'failure' row into emergency_rotation_audit,
// non-transactionally (there is no key rotation to couple it to
// atomically on this path). The caller (CONTRACT-003's endpoint handler)
// must treat this as best-effort: catch a rejection from this function
// and fall back to a server-side log-line backstop rather than let it
// fail the HTTP response it's auditing.
```

**Interface to CONTRACT-001:** CONTRACT-001's login/token-minting flow
depends on `getSecret('CLIENT_SECRET')` and `getCurrentSigningKey()`.
Unchanged from CONTRACT-002.

**Interface to CONTRACT-003:** CONTRACT-003's `POST
/admin/emergency-rotate-keys` handler, after authenticating the request,
generates a new key pair itself (key generation is CONTRACT-003/TASK-009's
own responsibility, using the same 2048-bit RSA / PKCS8-PEM-in,
AES-256-GCM-encrypted-at-rest shape bootstrap uses) and calls
`rotateSigningKeyEmergency`. On success it uses the returned
`previousKid`/`newKid` to build its HTTP response. On failure, it calls
`recordEmergencyRotationFailure`. This contract defines the schema and
atomicity of `emergency_rotation_audit` writes made through these two
functions; CONTRACT-003 defines that table's full column schema, who is
authorized to reach this interface, and how the endpoint audits/responds.

**No HTTP interface.** Unlike CONTRACT-001 and CONTRACT-003, this contract
defines no network-facing endpoints of its own; it is an in-process module
boundary plus the standalone bootstrap CLI script described above.

## UX expectations

Applies only to the bootstrap CLI (TASK-006) — there is no browser-facing
UI in this contract's scope:

- `CLIENT_SECRET` input is never echoed to the terminal in the interactive
  path.
- The `CLIENT_SECRET` value and any private key material never appear in
  stdout, stderr, or any log line, in either the success or the error path.
- Distinct, plain-language messages exist for at least: success (naming
  what was seeded), already-seeded (no-op refusal), missing/invalid
  `DB_ENCRYPTION_KEY`, data-directory permission failure, and
  `--client-secret-file` unlink failure — an operator reading the output
  must be able to tell these apart without inspecting source code.

## Validation requirements

- After seeding, directly inspect `secrets` and `signing_keys` table
  contents: `ciphertext`/`private_key_ciphertext` values are opaque binary,
  not the plaintext or any recognizable encoding of it; `iv` values differ
  between the two rows (proving fresh random IVs, not a reused/static IV).
- Attempt decryption with a deliberately wrong `DB_ENCRYPTION_KEY` and
  confirm it throws rather than returning incorrect plaintext.
- Attempt decryption after swapping the `ciphertext`/`iv`/`auth_tag` of one
  row into another row with a different `name`/`kid` and confirm it throws
  (validates AAD binding).
- Run the seed script via both the interactive-prompt path and the
  `--client-secret-file` path; inspect shell history and a captured process
  list (`ps`) during each run for the plaintext value — neither may appear.
- Confirm the `--client-secret-file` no longer exists after a successful
  run; confirm the script aborts cleanly (no PGlite write) when the unlink
  step is made to fail (e.g. file on a read-only mount).
- Run the seed script a second time against an already-seeded database;
  confirm non-zero exit and confirm no row values changed.
- Interrupt the seed script (simulated kill) between generating and storing
  the signing key; confirm no invalid/partial row is left in
  `signing_keys`, and confirm a subsequent run completes the missing piece.
- Inspect `PGLITE_DATA_DIR` permissions on disk after a fresh start
  (`ls -ld`) — confirm `drwx------`, owned by the dedicated service user;
  confirm the process refuses to start if the directory is `chmod 755`d
  before startup.
- Using `rotateSigningKeyEmergency`, confirm: exactly one `current` row
  exists before and after; the previous current key correctly transitions
  to `revoked` with `revoked_at` populated; `listPublishableSigningKeys()`
  excludes it afterward; exactly one `result = 'success'`
  `emergency_rotation_audit` row is written naming the correct
  previous/new `kid`.
- Confirm the rotation-and-audit-row atomicity invariant directly: force a
  failure after authentication but before/during the transaction (e.g. a
  simulated database error) and confirm neither a partial `signing_keys`
  change nor a `result = 'success'` audit row is left; confirm
  `recordEmergencyRotationFailure` (or the log-line backstop, if the
  database itself is unreachable) produces the failure-path audit record
  instead.
- Fire two authenticated `rotateSigningKeyEmergency`-triggering requests
  concurrently and confirm they chain correctly (the second's
  `previousKid` equals the first's `newKid`), exactly one final `current`
  row results, and two `result = 'success'` audit rows are written.

## Open questions

Future routine (non-emergency) key rotation with an overlap window
(`current` → `retired`, then `retired` → `revoked` once the window
elapses) has no defined function interface in this contract. CONTRACT-002
originally specified `rotateSigningKey(previousKeyDisposition: 'retire' |
'revoke')` and a separate `revokeKey(kid)` to cover both the emergency and
future routine cases with one shared interface; neither was ever
implemented, and this contract drops that shape when superseding
CONTRACT-002 rather than carry forward an unimplemented, unvalidated
design. When routine rotation is actually taken up, it should get its own
interface designed against real requirements at that time (as a new
contract, or a further supersession of this one, per ADR-001) — not a
resurrection of the dropped `rotateSigningKey`/`revokeKey` shape by
default. The `retired` status and `retired_at` column remain in the schema
specifically so that future work needs no migration to use them.

## Resolved decisions

The following were judgment calls this contract made because TASK-003 did
not settle them explicitly, carried forward unchanged from CONTRACT-004 (and, before it, CONTRACT-002)
except where noted.

1. **Single-layer envelope construction, not a two-layer per-value DEK.**
   TASK-003 calls `DB_ENCRYPTION_KEY` a "key-encrypting key" and says only
   ciphertext/IV/auth-tag are stored — no mention of a separately-stored
   wrapped data-encryption key. This contract reads that literally:
   `DB_ENCRYPTION_KEY` directly encrypts each value with a fresh IV per
   value, rather than wrapping a per-row generated key. This is simpler,
   matches exactly what TASK-003 says is stored, and still satisfies the
   stated goal (the key never lives in the database; the database alone is
   insufficient to decrypt anything). See "Envelope encryption scheme."
2. **`DB_ENCRYPTION_KEY` format** — 64-character lowercase hex (32 raw
   bytes), not base64. Chosen to avoid `.env`-quoting/parsing ambiguity
   around `+`, `/`, `=` characters that base64 can contain. See
   Preconditions, §1.
3. **Table names and columns** — `secrets` (`name`, `ciphertext`, `iv`,
   `auth_tag`, `created_at`, `updated_at`) and `signing_keys` (`kid`,
   `algorithm`, `status`, `public_key`, `private_key_ciphertext`,
   `private_key_iv`, `private_key_auth_tag`, `created_at`, `retired_at`,
   `revoked_at`). See Schema.
4. **Status vocabulary** — exactly `'current'`, `'retired'`, `'revoked'`.
   `'retired'` currently has no producing function (see Open questions),
   kept in the schema so future routine rotation needs no migration.
5. **IV length (12 bytes) and auth-tag length (16 bytes)** — standard
   AES-GCM parameters, matching Node's `crypto` module defaults and NIST
   guidance for GCM interoperability/security. See "Envelope encryption
   scheme."
6. **AAD binding** — each row's own `name`/`kid` is used as AES-GCM
   additional authenticated data, to detect (fail decryption on)
   ciphertext copied or swapped between rows. Not explicitly requested by
   TASK-003, but a low-cost strengthening consistent with its
   defense-in-depth framing; flagged explicitly rather than silently added.
7. **Public key material is not itself tamper-evident against DB-level
   modification** (it is stored as plaintext PEM, not AES-GCM protected,
   since it is not secret). A DB-level attacker with write access could in
   principle substitute a public key without invalidating the corresponding
   encrypted private key. Accepted limitation, given the chmod-700 +
   dedicated-user defense layer this contract already requires.
8. **RSA key size** — 2048 bits, fixed (not configurable), for both
   bootstrap and emergency rotation. Matches common library defaults
   (`jose`, PyJWT, php-jwt all support 2048-bit RS256 without extra
   configuration) and keeps JWKS/JWT size predictable across the mixed
   Node/Python/PHP consuming apps referenced in NOTES.md §4.
9. **Private/public key serialization formats** — private key: PKCS8 PEM
   (plaintext form, before encryption). Public key: SPKI PEM (stored as
   plaintext in `signing_keys.public_key`). Both are standard,
   language-neutral formats every consuming-app JWT library can parse
   without a custom conversion step; converting SPKI PEM to JWK `n`/`e` for
   the JWKS response itself is left to TASK-008 as a normal library call
   (e.g. via `jose`).
10. **`kid` generation** — `crypto.randomUUID()` (RFC 4122 v4 UUID),
    generated by whichever code path inserts a new key (bootstrap or
    rotation). Opaque and not derived from key material, avoiding any
    risk of leaking information about the key itself through its
    identifier. No extra dependency required (built into Node).
11. **Bootstrap script location and invocation** — `node scripts/seed.js`,
    run manually from the repo root, with an optional
    `--client-secret-file=<path>` flag for non-interactive input; default
    behavior is an interactive hidden-input prompt. Re-running is
    always safe (completes a partial bootstrap or refuses outright), and
    the script is explicitly first-run-only — not the mechanism for
    later `CLIENT_SECRET` or key rotation.
12. **Fail-closed posture for permission and decryption failures at
    startup** — chosen over "warn and continue" for both the data-directory
    permission check and any startup-critical decryption failure
    (`CLIENT_SECRET`, current signing key), consistent with TASK-003's
    "defense in depth" framing: a security control that can be silently
    bypassed by a misconfiguration is not a control BTAuthOrchestrator can
    rely on. See Failure behavior.
13. **`rotateSigningKeyEmergency` and `recordEmergencyRotationFailure`, not
    `rotateSigningKey`/`revokeKey`.** CONTRACT-002 originally specified a
    single combined `rotateSigningKey` (accepting a
    `previousKeyDisposition: 'retire' | 'revoke'`) plus a separate
    `revokeKey`, intended to serve both TASK-009's emergency path and a
    future routine-rotation path with one shared interface. TASK-009 also
    needed its rotation and its own audit-trail row (CONTRACT-003) to
    commit atomically — a requirement CONTRACT-002 had left as an
    explicitly open question rather than resolve. TASK-009's implementer
    built `rotateSigningKeyEmergency`/`recordEmergencyRotationFailure`
    instead, solving the atomicity requirement directly; TASK-011's review
    (Finding F1) confirmed the resulting behavior is correct but that this
    left CONTRACT-002's literal interface unmet without the escalation its
    own open question had asked for. Patrick decided (2026-09-15) to
    supersede CONTRACT-002 with this contract, codifying the as-built,
    already-implemented-and-verified interface as normative, rather than
    rework working code to match a never-implemented signature. See
    ADR-001 and Open questions (routine rotation's interface is
    deliberately left undesigned here, not silently dropped).
14. **`DB_ENCRYPTION_KEY` re-keying is explicitly out of scope, not an
    oversight.** Confirmed by Patrick. This contract defines no process for
    rotating the key-encrypting key itself; if it is ever changed without a
    data re-encryption migration, every existing row becomes undecryptable.
    The accepted recovery path if `DB_ENCRYPTION_KEY` is ever compromised or
    lost is a full re-seed against a fresh (empty) `PGLITE_DATA_DIR`: a new
    `DB_ENCRYPTION_KEY`, a re-entered `CLIENT_SECRET`, and freshly generated
    signing keys via TASK-006's bootstrap script — a reset, not a rotation.
    This is consistent with this project's small, single-host,
    internally-networked scale (NOTES.md §1) and requires no schema or
    interface support beyond what bootstrap already provides.
15. **Backup/restore of `PGLITE_DATA_DIR` is explicitly out of scope, not an
    oversight.** Confirmed by Patrick. This contract defines no
    backup/restore procedure. The one operational rule this contract does
    assert, for whatever backup approach is used operationally: a backup of
    `PGLITE_DATA_DIR` must never be the only place `DB_ENCRYPTION_KEY` is
    escrowed, and the key must never be bundled into the same backup
    artifact as the data directory — a backup that is restorable by anyone
    who can read it defeats the point of encrypting the data at rest. Where
    and how `DB_ENCRYPTION_KEY` itself is durably retained is an operational
    decision outside this contract, same status as any other `.env` bootstrap
    value.
16. **Dedicated service-user provisioning is confirmed out of this
    contract's scope and will be handled manually by Patrick directly on
    the host** — the same treatment as TASK-001's Entra app registration.
    This contract states the permission *requirement* (`0700`, dedicated
    user, see Preconditions and Failure behavior) and enforces it
    defensively at startup; it does not require a tracked implementation
    task for creating the OS user or writing a systemd unit.
17. **Windows hosts use a launcher-enforced, owner-only ACL in place of
    `0700`.** Decided by Patrick (2026-10-01). Windows exposes no POSIX
    mode bits or uids to Node, so the process's own `0700`/owner check
    could never pass there. On `win32` the process skips that check, and
    `start.ps1` applies an owner-only, non-inherited ACL to an existing
    `PGLITE_DATA_DIR` before every start, refusing (never auto-changing
    ownership) if another account owns it. See §5. The same launcher
    generates `DB_ENCRYPTION_KEY` in `.env` only when it is absent or still
    the `.env.example` placeholder and `PGLITE_DATA_DIR` holds no data,
    which keeps Resolved decision #14 intact: an existing database is never
    paired with a newly generated key.
