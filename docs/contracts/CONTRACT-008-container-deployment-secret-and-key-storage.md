# CONTRACT-008: Encrypted secret & key storage in PGlite, with container deployment

Status: Approved
Approved by: Patrick
Approved date: 2026-10-28
Related tasks: TASK-024 (this contract's drafting task), TASK-025 (the
container image/compose implementation that builds against this contract),
TASK-005, TASK-006, TASK-008, TASK-009 (unaffected — see "Relationship to
CONTRACT-007" below), TASK-003d (Caddy/TLS; its Cloudflare DNS-01 work is
unaffected), CONTRACT-001, CONTRACT-003, and CONTRACT-005 (consumers of the
Interfaces defined here, unaffected except as noted under Open question
OQ-8 and OQ-9).
Related ADRs: ADR-001 (contracts are retired by supersession, never amended
in place).
Supersedes: CONTRACT-007 (in full, on approval; see "Relationship to
CONTRACT-007" below and ADR-001). Pending Open question OQ-8: may also
supersede the input-channel sentence of CONTRACT-005 §5, for the container
first-boot path only.
Superseded by: CONTRACT-012 for the reverse-proxy actor, the Preconditions
bullet and Interfaces "Ingress" line naming the reverse proxy, §8, the Caddy
scope exclusions, OQ-9's deferral and Resolved decision #21 (Cloudflare
Tunnel replaces Caddy). All other sections remain in force.

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

**Container deployment (new in this contract).** This contract additionally
defines how the same storage, bootstrap, data-directory, and single-process
guarantees behave when BTAuthOrchestrator runs as a Docker container on
TrueNAS SCALE (Custom App, Docker Compose based), precisely enough for
TASK-025 to implement without further architectural decisions once the Open
questions below are resolved. See §7 (container deployment profile), the
stale-lock rules added to §6, and §8 (forwarded client address).

**Reading rule for container deployments.** Text carried forward from
CONTRACT-007 refers to `.env` as the source of configuration. A container
deployment has no `.env` file. Wherever carried-forward text says a value
comes from, or lives "only in," `.env`, a container deployment substitutes
the container input channels defined in §7.2. Every other property such text
states still applies: the value never enters PGlite, a log, or a response.

**Relationship to CONTRACT-007:** this contract supersedes CONTRACT-007 in
full (ADR-001). Every section below is identical to CONTRACT-007 except for
the following, which are the complete list of differences:

1. **Header.** New title, Status, Related tasks, `Supersedes: CONTRACT-007`,
   and the pending CONTRACT-005 §5 note.
2. **Purpose.** Added the "Container deployment" and "Reading rule"
   paragraphs and this note. The CONTRACT-004 relationship note's heading
   gained "(carried forward from CONTRACT-007)". Its body is unchanged.
3. **Scope.** Container-specific bullets appended to Included and Excluded.
   Existing bullets are unchanged.
4. **Actors.** Four actors appended: container operator, container runtime,
   reverse proxy, and first-boot seeding step. Existing actors are unchanged.
5. **Inputs and outputs.** One input bullet appended for the container input
   channels.
6. **Preconditions.** The single-process bullet's clause "concurrently or
   sequentially without a clean shutdown of the prior instance" is replaced.
   A stale lock left by an instance that is no longer running no longer
   blocks the next start (§6). Container-mode preconditions are appended.
7. **§6 Single-process enforcement.** The original paragraph is unchanged.
   A "Stale-lock recovery" subsection is appended.
8. **§7 Container deployment profile.** New.
9. **§8 Forwarded client address in container deployment.** New.
10. **Postconditions and invariants.** The "no plaintext anywhere on the
    host" postcondition gains a container-mode qualification (§7.2).
    Container first-boot postconditions are appended, and stale-lock and
    container invariants are appended.
11. **Failure behavior.** The "already-fully-seeded" row is qualified as the
    interactive/CLI mode. Container-mode and stale-lock rows are appended.
12. **Interfaces.** A "Container deployment interface" subsection is
    appended. The "No HTTP interface" paragraph now also names the
    non-interactive seed mode.
13. **UX expectations.** The opening sentence now also covers container
    first-boot and startup output. Container bullets are appended.
14. **Validation requirements.** Container and stale-lock bullets are
    appended.
15. **Open questions.** The routine-rotation question is carried forward
    verbatim. New questions OQ-1 through OQ-10 must be decided before
    approval.
16. **Resolved decisions.** The opening sentence names CONTRACT-007 as the
    immediate source. Decisions #1–#17 are unchanged. #18–#22 record
    Patrick's 2026-10-20 container decisions.

§1 (envelope encryption), §2 (schema), §3 (key lifecycle), §4 (the existing
bootstrap CLI, including `--client-secret-file` read-then-unlink-or-abort
and the non-zero "already seeded" exit), and §5 (POSIX `0700`/owner check
and Windows `start.ps1` ACL) are unchanged. POSIX-host and Windows-host
non-container deployments keep their CONTRACT-007 behavior. The one
exception is that stale-lock recovery (§6) applies to POSIX hosts as well,
if Patrick accepts the recommendation in OQ-6. No other task's
implementation is affected by anything except §6, §7, and §8.

**Relationship to CONTRACT-004 (carried forward from CONTRACT-007):** this contract supersedes CONTRACT-004 in
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
- The container deployment profile (§7): the fixed in-container data path,
  acceptable input channels for every secret the container consumes,
  automatic and idempotent first-boot seeding, and container UID/GID and
  data-directory ownership behavior.
- Recognizing and recovering a stale single-process lock without weakening
  the guarantee against two concurrent instances (§6).
- The trust boundary the reverse proxy creates for the forwarded client
  address in a container deployment (§8). This covers the deployment
  invariant only; see OQ-9 for the trusted-proxy setting.
- Operator-facing behavior and messages of the container at startup, at
  first boot, and on failure.

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
- The Dockerfile, compose file, entrypoint script, Caddy image, and
  Caddyfile themselves (TASK-025). This contract states the behavior they
  must produce, not their contents.
- Caddy's certificate issuance mode (`tls internal` now, Cloudflare DNS-01
  later under TASK-003d) and the Cloudflare API credential's input channel.
  Those are TASK-025/TASK-003d concerns and do not touch PGlite.
- TrueNAS catalog/app-template packaging (questions.yaml-style templates).
- Changing how `source_ip` is extracted from requests (CONTRACT-003's and
  CONTRACT-005's territory). §8 states only the deployment invariant that
  keeps the current extraction trustworthy. See OQ-9.
- Rotating or updating `CLIENT_SECRET` after seeding, in any deployment
  mode. This is unchanged from CONTRACT-007; §7.4 only makes it explicit
  that changing a container input after seeding has no effect.
- Running the data directory on a network filesystem (NFS/SMB) or sharing
  it between hosts. This is unsupported; see §6.

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
- **Container operator** (new) — a TrueNAS administrator who installs the
  app as a Custom App, either through the form or with "Install via YAML."
  They choose the host path that backs `/data`, supply the container inputs
  (§7.2), and set the host path's ownership and mode. They have no
  interactive shell in the container during first boot.
- **Container runtime** (new) — Docker on TrueNAS SCALE 25.10.0.1
  (Goldeye). It starts, stops (SIGTERM, then SIGKILL after the stop grace
  period), restarts under a restart policy, and recreates the container on
  app updates or configuration edits.
- **Reverse proxy** (new) — Caddy, a sibling service in the same compose
  project. It is the only service that publishes host ports, bound to a
  dedicated TrueNAS IP. It reaches the Node service over the compose network
  only (§8).
- **First-boot seeding step** (new) — the non-interactive seed mode (§7.4)
  that the container runs before the service starts on every container
  start.

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
- In a container deployment (new): every input above, plus the first local
  user's credentials, arrives through the container input channels in
  §7.2, never through `.env` or an interactive prompt. `PGLITE_DATA_DIR`
  is fixed at `/data` (§7.1).

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
  at the same data directory concurrently. A second process attempting to
  open a data directory held by a running instance fails fast and observably
  rather than corrupting data or silently degrading. A lock left behind by
  an instance that is no longer running (an unclean stop) does not block the
  next start. It is recognized and recovered under §6's stale-lock rules.
- The bootstrap/seed process (TASK-006) has been run successfully at least
  once before CONTRACT-001's login flow is exercised — a database with zero
  rows in `secrets` or zero rows with `status = 'current'` in `signing_keys`
  is a valid *pre-bootstrap* state, not an error condition of this
  contract's schema itself, but CONTRACT-001 cannot function until bootstrap
  has run (already stated as CONTRACT-001's own precondition).
- **Container deployment only (new):**
  - The operator has supplied a host path to be mounted at `/data`, and
    that host path exists before install. It is owned by the UID the
    container runs as (§7.3) and has mode `0700`.
  - The host path carries no extended ACL entries that grant access to any
    principal other than its owner. On TrueNAS this means a dataset or
    directory without NFSv4 or POSIX ACL entries beyond the owner. The
    service checks POSIX mode bits only and cannot see such entries, so this
    is an operator responsibility.
  - The host path is on storage local to the TrueNAS host, not a network
    share (§6).
  - Every secret input file supplied through a `*_FILE` channel (§7.2)
    lives outside the host path backing `/data`, so that a snapshot or
    backup of the data dataset never contains `DB_ENCRYPTION_KEY` (Resolved
    decision #15).
  - The Node service's listening port is not published on any host
    interface. Only the reverse proxy reaches it (§8).

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

#### Stale-lock recovery (new in this contract)

The current guard is an exclusive-create lock file in the data directory
(`src/database.ts`, `acquireProcessLock`). It records a PID and is removed
only on clean close. Its presence alone is treated as "another instance is
running." After an unclean stop (host reboot, `docker kill`, SIGKILL after
the stop grace period, OOM kill, power loss), the file persists. Every
later start then fails, and a restart policy turns that into a crash loop.
This applies to POSIX-host systemd deployments too, not only containers.
Whatever single-process mechanism is used must therefore satisfy all of the
following. The mechanism itself is OQ-6.

- **S1 — Automatic recovery.** A lock left behind by an instance that is no
  longer running is recognized as stale at the next start and recovered
  without operator action. The start then proceeds normally.
- **S2 — Never break a live holder.** A lock held by a running instance is
  never treated as stale. This holds even when the starting instance cannot
  see the holder's process: a different container, a different PID
  namespace, or a frozen holder (`docker pause`). Staleness must therefore
  never be decided only by checking whether the recorded PID exists in the
  starting instance's own process table. Container PIDs are reused (a
  restarted container's process can get the same PID) and are invisible
  across containers, so a PID check gives wrong answers in both directions.
- **S3 — Concurrent starters.** If two instances start at the same moment
  against the same stale lock, at most one of them acquires the data
  directory. The other fails fast with the existing second-instance error.
- **S4 — Observable.** A recovery is logged at startup as a distinct,
  plain-language line, for example "Recovered stale lock left by an
  instance that is no longer running." It includes whatever non-secret
  holder identity the lock recorded. A recovery is never silent.
- **S5 — Fail closed when uncertain.** If the mechanism cannot determine
  whether the holder is alive, the start is refused with the existing
  second-instance error, extended with manual-recovery guidance: stop every
  instance, then remove the named lock file, giving its path relative to
  the data directory.
- **S6 — Bounded delay.** If the mechanism needs to wait before deciding,
  for example for a lease to expire, the wait is bounded, fixed, documented,
  and logged while it happens.
- **S7 — Supported storage.** These guarantees are required only for a data
  directory on local storage accessed through one kernel: a single host,
  including several containers bind-mounting the same host path. A data
  directory on a network filesystem, or shared between hosts, is
  unsupported. The contract does not require the mechanism to detect that
  case.
- **S8 — Clean shutdown still releases.** A clean shutdown (SIGTERM or
  SIGINT, handled as today) still releases the lock, so a normal stop never
  depends on stale-lock recovery.

Stale-lock recovery relies on PGlite's own crash recovery after an unclean
stop. This contract does not add a data-integrity check beyond what PGlite
does when it opens the database.

### 7. Container deployment profile (new in this contract)

This section applies only when the service runs from the container image
built by TASK-025. That image establishes **container mode** explicitly,
not through heuristics such as probing for `/.dockerenv`. How it does so is
not prescribed. Everything in §1–§6 continues to apply in container mode
unless this section says otherwise.

#### 7.1 Data path

- `PGLITE_DATA_DIR` is fixed at `/data` inside the container. The host-side
  location is supplied by the operator through the TrueNAS app
  configuration (form host-path storage or the YAML `volumes:` entry). The
  image never chooses it.
- In container mode, if `PGLITE_DATA_DIR` is set to any value other than
  `/data`, startup fails closed with an error naming the variable. This
  prevents data from being written to a path that is not the
  operator-mounted storage. See OQ-10.
- If no operator-supplied storage is mounted at `/data`, startup fails
  closed. It never silently persists data to storage the operator did not
  choose, such as an anonymous Docker volume or the container's writable
  layer. One acceptable way to get this result is through §5's ownership
  check: an unmounted `/data` is not owned by the runtime UID. The
  mechanism is not prescribed; see OQ-10.

#### 7.2 Input channels

Inputs fall into two classes:

| Input | Class | Channels (pending OQ-1) |
|---|---|---|
| `DB_ENCRYPTION_KEY` | Every start | `DB_ENCRYPTION_KEY` or `DB_ENCRYPTION_KEY_FILE` |
| `EMERGENCY_ROTATION_TOKEN` | Every start | `EMERGENCY_ROTATION_TOKEN` or `EMERGENCY_ROTATION_TOKEN_FILE` |
| `LOCAL_USER_ADMIN_TOKEN` | Every start | `LOCAL_USER_ADMIN_TOKEN` or `LOCAL_USER_ADMIN_TOKEN_FILE` |
| `CLIENT_SECRET` | First boot only (while unseeded) | `CLIENT_SECRET` or `CLIENT_SECRET_FILE` |
| First local user's username | First boot only (while `local_users` is empty) | `INITIAL_LOCAL_USER_USERNAME` (not secret; environment only) |
| First local user's email | First boot only (while `local_users` is empty) | `INITIAL_LOCAL_USER_EMAIL` (not secret; environment only) |
| First local user's password | First boot only (while `local_users` is empty) | `INITIAL_LOCAL_USER_PASSWORD` or `INITIAL_LOCAL_USER_PASSWORD_FILE` |
| All other configuration (`PORT`, `COOKIE_SECURE`, `SERVICE_ISSUER`, `LOCAL_LOGIN`, `TENANT_ID`, `CLIENT_ID`, the optional `LOCAL_LOGIN_*` thresholds, `ALLOW_NEW_LOCAL_LOGIN_CREATION`) | Every start | Environment only, unchanged validation |

The variable names are part of the operator-facing interface and are
proposed for Patrick's confirmation (OQ-1).

Rules for every row that offers a `*_FILE` channel:

- **Exactly one channel.** If both `NAME` and `NAME_FILE` are set and
  non-empty, startup fails closed with an error naming both variables. The
  service never silently prefers one.
- **File semantics.** `NAME_FILE` holds an absolute path to a file readable
  by the container's runtime UID. The service reads the whole file and
  strips a single trailing newline (`\n` or `\r\n`), the same convention as
  `--client-secret-file`. It then applies the same validation the
  environment value receives. A missing, unreadable, or empty file, or a
  file whose content fails validation, fails startup closed. The error names
  the variable and path, never the content.
- **Never modified.** In container mode the service never deletes,
  truncates, rewrites, or changes the permissions of a `*_FILE` input. These
  files are operator-managed and are typically read-only bind mounts or
  compose `secrets:`. This is the container-mode replacement for §4's
  read-then-unlink. §4's `--client-secret-file` and CONTRACT-005's
  `--local-user-file` keep read-then-unlink-or-abort unchanged outside
  container mode. See OQ-3.
- **Not inside the data directory.** A `*_FILE` path that resolves inside
  `/data` fails startup closed. This keeps `DB_ENCRYPTION_KEY` and other
  secrets out of the data dataset's snapshots and backups (Resolved decision
  #15).
- **Never echoed.** No secret value from either channel appears in stdout,
  stderr, a log line, an audit row, or a response. This matches CONTRACT-007's
  existing rules.

`DB_ENCRYPTION_KEY` is never generated by the container. A missing or
invalid key fails closed exactly as §1 and Failure behavior require. The
Windows launcher's key generation (Resolved decision #17) has no container
equivalent, because the container would have no place to keep a generated
key other than alongside the data.

**Exposure tradeoff (recorded, decision in OQ-1).** A value passed as a
plain environment variable is visible in `docker inspect`, in the TrueNAS
app configuration screens, and in the container process's environment
(`/proc/<pid>/environ`, readable by the same UID and root). It may also
appear in TrueNAS configuration exports or debug bundles. It persists for
as long as it remains in the app configuration. A `*_FILE` value is exposed
only to whoever can read the host file and does not appear in `docker
inspect` or the app configuration. However, it requires the operator to
create and protect a host file, and the TrueNAS Custom App form may support
that less directly than "Install via YAML." Anyone with Docker access on the
host is effectively root, so the extra exposure from environment variables
is mainly in UI, export, and debug artifacts, and in how long the value
persists. Accepting plain environment variables for first-boot secrets is
weaker than CONTRACT-007's file-and-delete flow. Approving this contract
records that tradeoff as an explicit decision.

#### 7.3 Container user and data-directory ownership

- The container process never runs as UID 0. In container mode, starting
  as UID 0 fails closed with an error stating that the container must run
  as a non-root UID. See OQ-5. This rule is not applied to non-container
  POSIX hosts, whose behavior is unchanged.
- The image's default runtime UID:GID is `568:568`, the TrueNAS `apps`
  convention. The operator may override it with the compose `user:` setting
  (pending OQ-5). The image does not require any file outside `/data` to be
  owned by, or writable by, a particular UID.
- §5's POSIX rule applies to `/data` unchanged. `/data` must be mode `0700`
  and owned by the running UID, or startup fails closed. The service never
  changes ownership or mode, and the container never starts as root to
  `chown` and then drop privileges. That would be the auto-`chown` §5
  rejects.
- Because the operator cannot run commands inside a container that fails
  to start, a container-mode permission or ownership error must state the
  fix as a host-side action on the directory mounted at `/data`. For
  example: "On the TrueNAS host, run `chown 568:568 <host path mounted at
  /data>` and `chmod 700 <host path mounted at /data>`." The message names
  the actual numeric runtime UID:GID and the mode found. The service does
  not know the host path and does not invent one.

#### 7.4 First-boot seeding (non-interactive seed mode)

On **every** container start, before the service listens, the container
runs a non-interactive mode of the seed entry point (`scripts/seed.js`). The
proposed flag name is `--non-interactive`; the final name is pending OQ-4.
In this mode:

- **No prompting.** It never prompts, even if a TTY is attached. It reads
  inputs only from the §7.2 channels. It never accepts `--client-secret-file`
  or `--local-user-file`; supplying either in this mode is a usage error.
- **Same pieces, same checks.** It determines what needs seeding exactly as
  §4 and CONTRACT-005 §5 do: whether `CLIENT_SECRET` is present in
  `secrets`, whether a current row exists in `signing_keys`, and whether any
  row exists in `local_users`. It seeds only the missing pieces, and it
  never overwrites or duplicates an existing piece.
- **Inputs for missing pieces only.** It requires inputs only for pieces
  that are missing. If `CLIENT_SECRET` is unseeded, a `CLIENT_SECRET` input
  is required. If `local_users` is empty, all three first-user inputs are
  required. The signing key needs no input. A missing input for a missing
  piece fails with a non-zero exit and an error naming the missing variables.
  Nothing is written, and the service does not start.
- **Validate before writing.** Every input needed for this run is validated
  before the first write. Usernames, emails, and passwords use CONTRACT-005's
  rules: lowercase username of 3–64 characters from `[a-z0-9._-]` after
  normalization, a valid email of at most 254 characters, and a password of
  at least 12 characters. An empty `CLIENT_SECRET` counts as missing. An
  invalid input therefore never leaves a partially seeded database behind.
  Interruption mid-write is still handled by §4's per-row atomicity and
  completion on the next run.
- **Hashing and the creator marker.** The first local user is hashed through
  the same scrypt path and parameters CONTRACT-005 §1 defines. It is
  inserted with `created_by = 'seed-script'`, the same marker the CLI path
  uses.
- **Already seeded is success.** If every piece is already seeded, this mode
  prints "Database already seeded; nothing to do." and exits 0 without
  writing. This is the one deliberate difference from §4's non-zero exit. In
  an automatic first-boot step, "already seeded" is the normal result of
  every restart, not an operator mistake. The plain (interactive/CLI)
  invocation keeps §4's non-zero exit unchanged. See OQ-4.
- **Exit status.** It exits 0 when it seeded every missing piece or when
  nothing was missing. It exits non-zero on any failure, and the container
  does not proceed to start the service.
- **Ignored inputs after seeding.** For each seed input that is set while
  its piece is already seeded, it logs one warning on each start. The warning
  names the variable or variables, never their values. It says the value was
  ignored, that changing it has no effect, and that it may be removed from
  the app configuration. A present-but-ignored input is never validated
  against, compared with, or written over the stored value. Whether removing
  seed inputs is optional, as drafted here, or mandatory is OQ-2.
- **Same output rules as §4.** On success it prints the same confirmations
  §4 and CONTRACT-005 §5 specify. It never prints a secret, password, or
  private key.

**Start sequence.** In container mode the service does not begin listening
until the non-interactive seed step has exited 0 and the existing startup
checks (`scripts/startup-check.js`) have passed. Each step that opens the
database acquires and releases the single-process lock (§6). These steps
run one after another inside one container. Another container that takes
the lock between steps makes the later step fail fast, which is the
intended second-instance behavior.

#### 7.5 Stop behavior

- The container's stop signal (SIGTERM) reaches the Node process. The
  existing shutdown handling then closes the server and the database and
  releases the lock (§6, S8). An entrypoint that would prevent the signal
  from reaching Node does not meet this contract.
- A stop that exceeds the runtime's grace period ends in SIGKILL. The next
  start must then recover under §6's stale-lock rules (S1) rather than
  crash-loop.

### 8. Forwarded client address in container deployment (new in this contract)

The service derives `source_ip` for audit rows (CONTRACT-003,
CONTRACT-005) and for CONTRACT-005 §3's per-source-IP login throttle from
the first `X-Forwarded-For` entry, falling back to the socket peer address
(`src/index.ts`, `extractSourceIp`). It accepts that header from any peer.
That is safe only while every request reaches Node through a proxy that
overwrites the header. If Node is reachable directly, a client can set the
header itself. It can then evade the per-IP throttle by sending a new value
on each attempt and can falsify audit rows.

This contract does not change the extraction rule (see OQ-9). In a container
deployment, the following deployment invariants are what keep the current
rule trustworthy:

- The Node service publishes no host port and is reachable only on the
  compose project's internal network.
- The reverse proxy is the only ingress. It sets `X-Forwarded-For` from the
  peer it actually received the connection from, and it discards any
  client-supplied `X-Forwarded-For` rather than appending to it. This is
  Caddy's default behavior for clients outside its `trusted_proxies`. A
  later Caddy configuration that adds `trusted_proxies`, for example for
  Cloudflare proxying, breaks this invariant unless OQ-9's trusted-proxy
  setting exists first.
- Container deployment documentation (TASK-025) states these invariants and
  the consequence of breaking them.

## Postconditions and invariants

**Postconditions (true after a successful bootstrap):**
- `secrets` contains exactly one row named `CLIENT_SECRET`, with populated
  `ciphertext`/`iv`/`auth_tag`.
- `signing_keys` contains exactly one row with `status = 'current'`, with
  populated `public_key` and encrypted private-key columns.
- No plaintext `CLIENT_SECRET` or private key value exists anywhere on the
  host outside of AES-256-GCM ciphertext inside `PGLITE_DATA_DIR` (in
  particular: not in `.env`, not in a log file, not in a leftover
  `--client-secret-file`, not in shell history). **Container-mode
  qualification:** plaintext seed inputs may remain where the operator put
  them (the app configuration or an operator-managed `*_FILE`) until the
  operator removes them (§7.2, OQ-2). The service itself never creates any
  other copy of them.

**Postconditions (true after a successful non-interactive seed run, §7.4)
(new):**
- Everything the bootstrap postconditions above require, plus CONTRACT-005's
  `scripts/seed.js` postconditions for `local_users`.
- Exit status 0. On a re-run against a fully seeded database, no row in
  `secrets`, `signing_keys`, or `local_users` was added, changed, or
  removed.
- No `*_FILE` input was modified or deleted.

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
- (New) A lock held by a running instance is never recovered as stale
  (§6, S2). Stale-lock recovery therefore never allows two instances to
  have `PGLITE_DATA_DIR` open at once.
- (New, container mode) The process runs as a non-root UID. `PGLITE_DATA_DIR`
  is `/data`. No `*_FILE` input lies inside `/data`.
- (New, container mode) The Node listening port is not published on any
  host interface (§8).

## Failure behavior

| Condition | Required behavior |
|---|---|
| `DB_ENCRYPTION_KEY` missing, malformed, or not exactly 32 bytes when decoded | Fail closed at process startup, before opening PGlite or serving any request. Clear, non-secret-revealing error message. |
| `PGLITE_DATA_DIR` exists with permissions/ownership other than `0700`/dedicated service user | Fail closed at startup with a clear error naming the required fix. No auto-`chown`. On Windows, `start.ps1` instead re-applies the owner-only ACL, and fails closed with an `icacls /setowner` fix only when the directory is owned by a different account (§5). |
| A second process attempts to open an already-open `PGLITE_DATA_DIR` | Fail fast with a clear error; must not corrupt the database or silently proceed. |
| Decryption of `CLIENT_SECRET` or the current signing key fails (wrong key, tampered/corrupted row) at a point where CONTRACT-001's login flow needs it | Treat as a startup/critical error — the process must not serve login traffic without a decryptable `CLIENT_SECRET` and current signing key. The specific decryption failure reason is logged server-side only, never including the ciphertext, key, or any recovered plaintext fragment. |
| Seed script run against an already-fully-seeded database (interactive/CLI mode, §4) | Refuse; exit non-zero; make no writes. |
| Seed script's `--client-secret-file` cannot be deleted after being read | Abort before any PGlite write; instruct the operator to delete it manually; exit non-zero. |
| Seed script interrupted mid-write (process killed between generating and storing a value) | No partially-written row is left in a state where it could be read as valid/current (see Postconditions and invariants — atomic per-row writes). A subsequent run detects the missing piece and completes it (see "Determining what needs seeding"). |
| Attempted signing-key status transition other than the valid set in "Key lifecycle" | Reject (throw/error); no such transition is ever written. |
| `rotateSigningKeyEmergency`'s transaction fails partway (e.g. database unreachable mid-write, after a bearer credential has already been authenticated by CONTRACT-003) | The whole transaction rolls back: no partial/new `signing_keys` row, no status change to the previous current key, no `emergency_rotation_audit` success row. The caller (CONTRACT-003's endpoint handler) is responsible for its own separate, best-effort `result = 'failure'` audit write and log-line backstop — this contract's own atomicity guarantee covers only the success path, by construction (a failed transaction commits nothing to couple). |
| (New) Lock present, holder no longer running | Recover automatically, log the recovery (§6, S1/S4), and start normally. |
| (New) Lock present, holder running (any container or namespace, including paused) | Fail fast with the second-instance error (§6, S2). |
| (New) Two instances start at once against a stale lock | At most one acquires. The other fails fast (§6, S3). |
| (New) Holder liveness cannot be determined | Fail closed with the second-instance error plus manual-recovery guidance (§6, S5). |
| (New, container) Both `NAME` and `NAME_FILE` set for one input | Fail closed at startup, naming both variables (§7.2). |
| (New, container) `NAME_FILE` missing, unreadable, empty, or invalid, or the path is inside `/data` | Fail closed at startup, naming the variable and path, never the content (§7.2). |
| (New, container) Non-interactive seed: input for a missing piece absent or invalid | Exit non-zero before any write, naming the variables. The container does not start the service (§7.4). Under a restart policy this repeats until the operator fixes the configuration. Each attempt prints the same message. |
| (New, container) Non-interactive seed: database already fully seeded | Exit 0, no writes, and one warning per ignored seed input still set (§7.4). |
| (New, container) Running as UID 0 | Fail closed at startup (§7.3, OQ-5). |
| (New, container) `PGLITE_DATA_DIR` ≠ `/data`, or no operator storage mounted at `/data` | Fail closed at startup (§7.1, OQ-10). |
| (New, container) `/data` ownership or mode wrong | Fail closed. The message names the fix as a host-side `chown`/`chmod` on the path mounted at `/data`, with the actual numeric UID:GID (§7.3). |

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

**Container deployment interface (new):** this is operator-facing and
normative. The names are pending OQ-1 and OQ-4.

- Fixed data path: `/data`.
- Input variables: see the table in §7.2, including the `*_FILE` variants
  and their rules.
- Non-interactive seed mode: `node scripts/seed.js --non-interactive`
  (proposed name). Exit 0 means seeded, or already seeded. Non-zero means
  failure. It reads only §7.2 inputs and never prompts or unlinks anything.
- Runtime identity: non-root. The default UID:GID is `568:568`, overridable
  through compose `user:` (pending OQ-5).
- Ingress: the Node port is unpublished, and the reverse proxy is the sole
  ingress (§8).
- Health: the existing `GET /health` endpoint is unchanged and opens no
  database lock.

**No HTTP interface.** Unlike CONTRACT-001 and CONTRACT-003, this contract
defines no network-facing endpoints of its own; it is an in-process module
boundary plus the standalone bootstrap CLI script described above, including
its non-interactive container mode (§7.4).

## UX expectations

Applies only to the bootstrap CLI (TASK-006) and, in container mode, to the
non-interactive seed step and startup output (§7) — there is no
browser-facing UI in this contract's scope:

- `CLIENT_SECRET` input is never echoed to the terminal in the interactive
  path.
- The `CLIENT_SECRET` value and any private key material never appear in
  stdout, stderr, or any log line, in either the success or the error path.
- Distinct, plain-language messages exist for at least: success (naming
  what was seeded), already-seeded (no-op refusal), missing/invalid
  `DB_ENCRYPTION_KEY`, data-directory permission failure, and
  `--client-secret-file` unlink failure — an operator reading the output
  must be able to tell these apart without inspecting source code.
- (New, container) All container output goes to stdout and stderr, so it
  appears in the TrueNAS app logs. An operator reading only those logs must
  be able to tell apart at least the following: first-boot seeding performed
  (naming each piece); already seeded; seed input missing or invalid (naming
  variables); `NAME`/`NAME_FILE` conflict; unreadable `*_FILE`;
  data-directory ownership or mode wrong, with the host-side fix;
  running as root; `PGLITE_DATA_DIR` not `/data` or storage not mounted;
  stale lock recovered; and another instance running.
- (New, container) The ignored-seed-input warning (§7.4) names the variables
  and says that changing them has no effect after seeding. Without this, an
  operator could reasonably expect that editing `CLIENT_SECRET` in the app
  configuration rotates it.
- (New, container) Container-mode guidance names container concepts: app
  configuration, the host path mounted at `/data`, and restarting the app.
  It does not name `.env`, `npm run seed`, `start.sh`, or the service user.
  Startup output does not present container-internal network addresses as
  addresses clients should use. The existing client DNS hint in
  `scripts/startup-check.js` prints detected interface addresses, which in a
  container are compose-network addresses.

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
- (New) **Stale lock.** Do the following on a local Docker host and on a
  POSIX host, if OQ-6 applies the rule there:
  - Start the service, SIGKILL it (`docker kill`), and start it again.
    Confirm it starts without operator action and logs the recovery.
  - With one instance running, start a second container that bind-mounts
    the same host path. Confirm it fails fast and the first is unaffected.
  - Repeat with the first instance paused (`docker pause`). Confirm the
    second still fails.
  - Start two instances simultaneously against a stale lock. Confirm
    exactly one starts.
  - Confirm `docker stop` leaves no lock behind.
- (New) **First boot.** With an empty host path and every first-boot input
  set, start the container. Confirm it seeds `CLIENT_SECRET`, the signing
  key, and the first local user, then serves `/health` through the proxy.
  Restart it. Confirm the seed step exits 0, no row changed, and the
  ignored-input warnings name the variables but not their values.
- (New) **Missing and invalid inputs.** Remove one first-boot input from a
  fresh install, and separately supply a password of 11 characters. Confirm
  a non-zero seed exit, no rows written, a message naming the variable, and
  no service start.
- (New) **`*_FILE` channel.** Supply each `*_FILE`-capable input through a
  read-only mounted file. Confirm seeding and startup succeed and the file
  is unchanged (content, mode, and modification time). Confirm the
  `NAME`+`NAME_FILE` conflict, an unreadable file, and a file under `/data`
  each fail closed with the variable named and no content shown.
- (New) **Secret leakage.** Search the container logs, the image layers
  (`docker history` and layer contents), and the data directory for every
  input value. None may appear in plaintext. Note that `docker inspect`
  will show environment-channel values. That is the recorded tradeoff in
  §7.2, not a failure.
- (New) **Ownership.** With the host path owned by root or set to `0755`,
  confirm the container fails closed with a host-side fix naming the actual
  UID:GID. Confirm the container refuses to run as UID 0. If OQ-5 permits a
  `user:` override, confirm a non-default UID works when the host path is
  owned accordingly.
- (New) **Data path.** Run without a host path mounted at `/data`, and
  separately with `PGLITE_DATA_DIR=/elsewhere`. Confirm both fail closed.
- (New) **Ingress.** Confirm from the host and from the LAN that the Node
  port is not reachable directly. Confirm through the proxy that a
  client-supplied `X-Forwarded-For` value does not appear as `source_ip` in
  `local_login_audit`.
- (New) **Regression.** Confirm the interactive CLI seed, the
  `--client-secret-file` unlink behavior, and the Windows `start.ps1` path
  behave exactly as before.

## Open questions

**Carried forward from CONTRACT-007 (not blocking approval):**

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

**New, requiring Patrick's decision before approval:**

**OQ-1. Input channels for secrets.** Should inputs be accepted as plain
environment variables, as `*_FILE` secret files, or both? This covers
`DB_ENCRYPTION_KEY`, `CLIENT_SECRET`, the first user's password, and the two
admin tokens. The variable names in §7.2 also need confirming.
- Environment only: easiest in the TrueNAS form. Values appear in
  `docker inspect`, the app configuration screens, and possibly exports and
  debug bundles, for as long as they stay configured.
- `*_FILE` only: the smallest exposure. However, every install needs host
  files created and protected, and the form workflow may be awkward. Compose
  `secrets:` is available only through "Install via YAML."
- Both, as drafted: operators choose. If both are set for one input,
  startup fails closed.

- **Recommendation:** both, with the documentation recommending `*_FILE`
  for `DB_ENCRYPTION_KEY` and the two tokens, which persist for the life of
  the install. Accept plain environment variables as a recorded tradeoff.
  Confirm the proposed names (`*_FILE` suffix and `INITIAL_LOCAL_USER_*`).
  Also confirm whether `*_FILE` support should be container-only or
  accepted in every deployment mode. I recommend every mode for the three
  every-start secrets, because the change is additive and keeps one
  configuration code path. The first-boot seed inputs should be read only by
  the non-interactive mode, so that `CLIENT_SECRET` still never belongs in a
  host `.env`.
**Answer: Environment only
**OQ-2. Removing seed inputs after first boot: may, or must?**
- May (as drafted): seed inputs set after seeding are ignored, with a
  per-start warning that names the variables.
- Must: the service refuses to start while any seed input is set and the
  database is seeded. This gives the strongest hygiene. The cost is that
  every new install crash-loops right after its first successful seed until
  the operator edits the app configuration. On TrueNAS that edit recreates
  the container. A wiped-data reinstall also needs the inputs re-added.
- **Recommendation:** may, with the warning. Documentation should tell
  operators to remove `CLIENT_SECRET` and `INITIAL_LOCAL_USER_PASSWORD`
  once the first boot succeeds.
**Answer: may
**OQ-3. Read-only secret files.** CONTRACT-007's `--client-secret-file`
must be deleted after reading, or the run aborts. Docker and TrueNAS mounts
are typically read-only, so the delete always fails.
- **Recommendation (as drafted):** container `*_FILE` inputs are
  operator-managed and never deleted or modified. `--client-secret-file` and
  `--local-user-file` keep unlink-or-abort unchanged outside container mode.
- Rejected alternatives:
  - Attempt the unlink and tolerate failure. This silently weakens the CLI's
    guarantee.
  - Pass the CLI flags into the container. They would always abort.
**Answer: for now lets go with your recommendation.
**OQ-4. Exit status for "already seeded."**
- (a), as drafted: a separate non-interactive mode returns 0 for already
  seeded, and the plain CLI keeps its non-zero exit.
- (b): one mode with a distinct documented exit code for already seeded,
  for example 2. The entrypoint would treat 0 and 2 as success.
- (c): the server process seeds itself in-process, with no separate step.
- **Recommendation:** (a). The entrypoint gets a plain success/failure
  status, and §4's "visibly distinct" CLI behavior is preserved. Option (b)
  makes every future entrypoint encode a magic number. Option (c) mixes
  first-run input handling into the long-running server. Please also
  confirm the flag name (`--non-interactive` is proposed).
**Answer:  yes option a
**OQ-5. Container UID/GID versus the `0700`/owner check.**
- The check itself works with any non-root UID. The decisions are:
  - (a) Is the default `568:568`? Yes, as drafted.
  - (b) May the operator override it through compose `user:`? Yes, as
    drafted.
  - (c) Should UID 0 be refused in container mode? Yes, as drafted.
- Tension: CONTRACT-007 requires a *dedicated* service user. UID 568
  (`apps`) is shared by every TrueNAS app. Container isolation, where only
  this app mounts this host path, substitutes for user-level isolation. But
  any other app or host process running as 568 that can reach the path
  could read it.
- **Recommendation:** default `568:568` for TrueNAS compatibility, an
  operator override allowed, and documentation recommending a dedicated UID
  as the stronger option. Refuse root in container mode only. Never
  auto-`chown`.
- Also confirm that operators are responsible for the no-extended-ACL
  precondition. The service cannot see NFSv4 ACLs.
**Answer: 568 is fine. there are many safeguards in truenas to deal with this.
**OQ-6. Stale-lock mechanism (satisfying §6 S1–S8).**
- (a) **Kernel-held advisory lock** (`flock`/`fcntl`) on a file in `/data`.
  The kernel releases it when the holder dies by any means, so no staleness
  needs detecting. It works across containers on one host. However, Node
  22 has no built-in `flock`, so this needs a native dependency or a helper
  process. The project has so far avoided third-party native modules.
- (b) **Liveness-socket lock.** The holder listens on a Unix-domain socket
  in `/data`. A starter that finds the lock tries to connect. A refused
  connection means stale. The existing exclusive-create file stays as the
  mutex, and the takeover must be race-free (S3). It needs no dependency,
  works across containers on one host, and survives `docker pause`, because
  the kernel still accepts connections into the listen backlog. Costs: a
  socket path length limit of about 107 bytes, which matters for long
  POSIX-host data paths and must fail closed if exceeded; a little more
  takeover logic; and it does not cover Windows.
- (c) **Lease or heartbeat.** The holder refreshes a timestamp, and the lock
  is stale after N missed refreshes. It needs no dependency and works on
  Windows. However, it delays startup after an unclean stop, writes to disk
  periodically, and violates S2 when the holder is paused. Recommended
  against.
- (d) **PID plus boot ID plus hostname.** Unsafe across PID namespaces, and
  it crash-loops when TrueNAS recreates the container. Rejected.
- **Recommendation:** (b). Choose (a) instead if you would accept a native
  dependency. Apply it on POSIX hosts as well as in containers, since
  systemd deployments have the same crash-loop problem. Keep Windows on
  today's behavior, with no stale-lock recovery, unless you want (c) there
  specifically.
**Answer: option b
**OQ-7. Shutdown grace period.** Docker's default stop grace period is
10 seconds. If Node's shutdown ever takes longer, the stop ends in SIGKILL,
which still recovers through §6.
- **Recommendation:** no contract-level number. TASK-025 should set a
  modest `stop_grace_period` (for example 30 seconds) and confirm that
  `docker stop` exits cleanly.
**Answer: I think dockers default grace is more then enough time.
**OQ-8. CONTRACT-005 §5 interaction.** CONTRACT-005 §5 still governs
first-local-user seeding. It allows only a hidden prompt or "a one-time,
immediately-deleted input file." The container path in §7.4 adds an
environment-variable or read-only-file channel, which contradicts that
sentence.
- (a) Approve CONTRACT-008 as also superseding that one sentence of
  CONTRACT-005 §5, for container mode only. This is a section-level
  supersession recorded in both headers, with precedent in CONTRACT-006.
- (b) Write a separate small contract superseding CONTRACT-005 §5.
- **Recommendation:** (a). The change is narrow and makes sense only
  alongside §7.4.
**Answer: option a
**OQ-9. `X-Forwarded-For` trust.** As drafted, this contract records the
deployment invariant (§8) but does not change extraction.
- (a) Defer a trusted-proxy setting to a named follow-up, for example
  "TASK-026: trusted-proxy source-address extraction." That follow-up would
  supersede CONTRACT-005 §1's `source_ip` note, and CONTRACT-003's if
  required. It would honour `X-Forwarded-For` only from configured proxy
  addresses or CIDRs, and would take the right-most untrusted entry rather
  than the left-most.
- (b) Specify the setting in this contract now.
- **Recommendation:** (a). The invariant in §8 makes the current deployment
  safe. The extraction rule belongs to CONTRACT-003/005. Adding Cloudflare
  proxying or Caddy `trusted_proxies` should be blocked on that follow-up.
  This matters because CONTRACT-005 §3's per-IP throttle, not only audit
  fidelity, depends on the address.
**Answer: option a
**OQ-10. Container data-path guards (smaller).**
- Should a `PGLITE_DATA_DIR` other than `/data` fail closed in container
  mode? Recommendation: yes.
- Should a missing operator mount at `/data` fail closed rather than fall
  back to an anonymous volume? Recommendation: yes. An image-provided
  `/data` that is root-owned achieves this through §5's existing check, with
  no new detection logic.
- These go slightly beyond "`/data` is fixed" and so need your
  confirmation.
**Answer: Yes to both
## Resolved decisions

The following were judgment calls this contract made because TASK-003 did
not settle them explicitly, carried forward unchanged from CONTRACT-007 (and,
before it, CONTRACT-004 and CONTRACT-002) except where noted.

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
18. **Container target platform (new).** Decided by Patrick (2026-10-20).
    The container target is TrueNAS SCALE 25.10.0.1 (Goldeye), deployed as
    a Custom App through the form or "Install via YAML." It is Docker
    Compose based and is not a catalog app. Input channels must therefore
    work from a Custom App.
19. **Fixed in-container data path (new).** Decided by Patrick
    (2026-10-20). `PGLITE_DATA_DIR` is `/data` inside the container, backed
    by an operator-supplied host path. See §7.1.
20. **Required inputs and automatic first-boot seeding (new).** Decided by
    Patrick (2026-10-20). The container deployment requires `CLIENT_SECRET`
    and the initial local-user credentials. It seeds itself automatically on
    first boot, with no interactive seed run. See §7.4. This contract reads
    "requires" as "required while the corresponding piece is unseeded" (see
    OQ-2).
21. **Reverse proxy topology (new).** Decided by Patrick (2026-10-20).
    Caddy runs as a sibling compose service and is the only service
    publishing ports, bound to a dedicated TrueNAS IP. It uses
    `tls internal` for now, with Cloudflare DNS-01 to follow under
    TASK-003d. See §8.
22. **Node 22 base image (new).** Decided by Patrick (2026-10-20). This has
    no effect on this contract's behavior. It is recorded so that the
    runtime assumption behind §6's mechanism options (no built-in `flock` in
    Node 22) is explicit.
