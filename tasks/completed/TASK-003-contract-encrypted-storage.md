# TASK-003: Contract — Encrypted secret & key storage in PGlite

Owner role: Contract Designer
Assigned agent: contract-architect
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: none (this task produces CONTRACT-002)
Related ADRs: none
Dependencies: none

## Desired outcome

An approved CONTRACT-002 defining how BTAuthOrchestrator stores and protects
secrets and signing keys in PGlite, precise enough for TASK-005 (schema),
TASK-006 (bootstrap), TASK-008 (key storage/JWKS), and TASK-009 (rotation
trigger) to implement against without further architectural decisions.

## Context

Decided in planning (settled inputs, not open questions):

- All application state beyond bootstrap scaffolding lives in a PGlite
  database controlled by this application. `.env` is limited to true
  bootstrap values needed before the app can open its own database: `PORT`,
  `PGLITE_DATA_DIR`, `DB_ENCRYPTION_KEY`, `COOKIE_SECURE`, `TENANT_ID`,
  `CLIENT_ID`. `TENANT_ID`/`CLIENT_ID` stay in `.env` because they are
  non-secret identifiers (visible in redirect URLs) and moving them buys no
  security benefit while adding a bootstrap dependency.
- The Entra `CLIENT_SECRET` and all signing key material live in PGlite,
  encrypted — not in `.env`.
- Encryption mechanism: envelope encryption, AES-256-GCM, using a
  key-encrypting key (`DB_ENCRYPTION_KEY`) that lives only in `.env`, never
  in the database. Ciphertext, IV, and auth tag are stored in PGlite;
  plaintext secrets are never persisted.
- Defense in depth: the PGlite data directory is owned by a dedicated
  service user with restrictive permissions (`chmod 700`), in addition to
  (not instead of) encryption.
- Hard operational constraint: this service must run as a single process
  against its PGlite data directory — no clustering/multiple workers
  sharing one data directory.
- Signing keys are tracked with a `kid` (key ID) and status, supporting
  more than one currently-valid key at once, to support both emergency
  rotation (TASK-009, drop the old key immediately) and future routine
  rotation (overlap window, no forced mass logout) without a schema
  redesign.
- Bootstrap problem: the `CLIENT_SECRET` and initial signing key must be
  seeded into PGlite before first real use. This contract must define that
  seeding interface; TASK-006 implements it. The seed path must not leave
  secrets in shell history or a long-lived file.

## Scope

### Included

- Schema for signing keys (`kid`, algorithm, status, encrypted private key
  material, created/rotated timestamps) and a generic encrypted-secrets
  store (for `CLIENT_SECRET` and similar).
- The envelope-encryption scheme and exact algorithm/parameters.
- The bootstrap/seed interface.
- Data-directory permission requirements.
- The single-process constraint, stated as a precondition/invariant.

### Excluded

- The OIDC login flow itself (CONTRACT-001).
- The emergency-rotation trigger's authorization/audit design (TASK-009's
  own scope, though it depends on this contract's storage interface).

## Plan

1. Draft CONTRACT-002 per `docs/contracts/TEMPLATE.md`.
2. Specify the encrypted-secrets and signing-key schema.
3. Specify the envelope-encryption algorithm and exact key/IV/tag handling.
4. Specify the bootstrap/seed interface (inputs, how `CLIENT_SECRET` and the
   initial key pair enter the system, what is written where).
5. State the single-process constraint and data-directory permission
   requirements as explicit preconditions/invariants.
6. Present CONTRACT-002 to Patrick for approval.

## Acceptance criteria

- [x] CONTRACT-002 drafted per template, covering all items in Scope >
      Included.
- [x] Envelope-encryption scheme fully specified (algorithm, key sourcing,
      what's stored vs. what's never stored).
- [x] Bootstrap/seed interface specified with no path that requires a
      long-lived plaintext secret outside PGlite.
- [x] Single-process constraint and data-directory permissions stated as
      explicit requirements.
- [x] Reviewed and approved by Patrick.

## Validation requirements

Human review and explicit approval before TASK-005, TASK-006, TASK-008, or
TASK-009 begin.

## Risks and assumptions

None beyond the decisions already recorded above as settled.

## Blocker

None.

## Implementation handoff

Drafted `docs/contracts/CONTRACT-002-encrypted-secret-and-key-storage.md`
(Status: Proposed) per `docs/contracts/TEMPLATE.md`, covering every item in
this task's Scope > Included and written to be implementable by TASK-005,
TASK-006, TASK-008, and TASK-009 without further architectural decisions.

Key content:
- Envelope encryption: AES-256-GCM, `DB_ENCRYPTION_KEY` (32 raw bytes,
  64-char hex in `.env`) used directly as a single-layer key-encrypting
  key (no separately-stored wrapped per-value DEK), 12-byte random IV and
  16-byte auth tag per value, AAD bound to each row's own `name`/`kid` to
  block cross-row ciphertext swapping. Only ciphertext/IV/auth-tag are ever
  persisted; plaintext secrets, private keys, and `DB_ENCRYPTION_KEY` are
  never persisted.
- Schema: a generic `secrets` table (`name`, `ciphertext`, `iv`,
  `auth_tag`, timestamps) for `CLIENT_SECRET` and similar, and a
  `signing_keys` table (`kid`, `algorithm`, `status`, plaintext `public_key`
  PEM, encrypted private-key columns, `created_at`/`retired_at`/`revoked_at`).
- Key lifecycle: three statuses (`current`, `retired`, `revoked`) with a
  fixed transition set, supporting TASK-009's immediate `current`→`revoked`
  emergency path and a future `current`→`retired`→`revoked` overlap-window
  path without any schema change. Invariant: exactly one `current` row at
  all times.
- Bootstrap/seed interface (for TASK-006): a concrete `node scripts/seed.js`
  CLI, `CLIENT_SECRET` accepted only via hidden interactive prompt or a
  `--client-secret-file` that is unlinked immediately after being read
  (never a bare CLI flag), idempotent re-run behavior (completes a partial
  seed, refuses if already fully seeded), and an in-process-only initial
  RS256 key pair generation (2048-bit, PKCS8/SPKI PEM).
- Data-directory permissions (`0700`, dedicated service user) and the
  single-process constraint are both stated as enforced preconditions with
  explicit fail-closed startup behavior, not just documented facts.
- A concrete module-boundary interface (`getSecret`/`setSecret`,
  `insertSigningKey`/`rotateSigningKey`/`revokeKey`/`getCurrentSigningKey`/
  `listPublishableSigningKeys`) that CONTRACT-001 depends on for
  `CLIENT_SECRET` and signing-key retrieval, and that TASK-009 uses
  (`rotateSigningKey(..., previousKeyDisposition: 'revoke')`) without this
  contract prescribing TASK-009's own authorization/audit design.

13 judgment calls not explicitly settled by this task's Context were made
and logged under CONTRACT-002's own "Resolved decisions" section (table/
column names, status vocabulary, `DB_ENCRYPTION_KEY` hex encoding, IV/tag
lengths, AAD binding, RSA key size, PEM formats, `kid` generation, the
single-layer (vs. two-layer DEK) envelope construction, the bootstrap
script's invocation shape, fail-closed startup posture, and the
`insertSigningKey`/`rotateSigningKey` function split) — each with its
rationale, awaiting Patrick's review alongside the rest of the contract.

Three items were left as genuinely open questions rather than resolved by
judgment call, since they are product/ops decisions this task's Context did
not touch at all: `DB_ENCRYPTION_KEY` rotation (re-keying), backup/restore
strategy for the encrypted data directory, and dedicated-service-user
deployment provisioning.

No application code was written; no other task file was modified; TASK-005,
TASK-006, TASK-008, TASK-009 were not started.

**2026-09-14 review outcome:** all 13 "Resolved decisions" approved as
drafted. The three genuinely open questions were resolved by Patrick as
deliberate scope decisions (not gaps to design around), recorded in
CONTRACT-002's "Resolved decisions" #14–16:
- `DB_ENCRYPTION_KEY` re-keying: explicitly out of scope; a full re-seed
  against a fresh data directory is the accepted recovery path if the key
  is ever compromised or lost.
- `PGLITE_DATA_DIR` backup/restore: explicitly out of scope; the one rule
  asserted is that `DB_ENCRYPTION_KEY` must never be escrowed only inside
  a backup of the data directory itself.
- Dedicated service-user/systemd provisioning: confirmed out of this
  contract's scope, to be handled manually by Patrick directly on the
  host — no tracked implementation task, same treatment as TASK-001.

CONTRACT-002's "Open questions" section now reads "None outstanding."

## Review

Not applicable — contract-only task, no separate reviewer role; reviewed
directly by Patrick as part of approval (see Human acceptance).
