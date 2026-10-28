# TASK-006: Bootstrap / seed script

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-002
Related ADRs: none
Dependencies: TASK-003 (CONTRACT-002 approved), TASK-005 (schema exists);
consumes the `CLIENT_SECRET` produced by TASK-001.

## Desired outcome

A first-run script that seeds the Entra `CLIENT_SECRET` and an initial
RS256 signing key pair into PGlite, encrypted, with no plaintext secret left
in shell history or any long-lived file.

## Context

Per CONTRACT-002, `CLIENT_SECRET` and signing keys must enter PGlite
through a defined, one-time seed path — never sitting in `.env`. This task
implements that path.

## Scope

### Included

- A script/command that accepts the `CLIENT_SECRET` via a mechanism that
  avoids shell-history/long-lived-file exposure (e.g., an interactive
  prompt or a one-time input file the script deletes after reading),
  encrypts it per CONTRACT-002's envelope scheme, and writes it to PGlite.
- Generation of an initial RS256 signing key pair (kid assigned), similarly
  encrypted and stored.

### Excluded

- Ongoing key rotation (TASK-009).
- The OIDC flow itself (TASK-007).

## Plan

1. Implement `CLIENT_SECRET` input handling per CONTRACT-002's bootstrap
   interface, avoiding shell history/long-lived plaintext files.
2. Encrypt and store the `CLIENT_SECRET` using the `DB_ENCRYPTION_KEY`
   -derived envelope scheme.
3. Generate an initial RS256 key pair, assign it a `kid`, mark it current,
   encrypt and store the private key.
4. Confirm the script is safely re-runnable or clearly guards against
   accidental re-seeding over an already-initialized database.

## Acceptance criteria

- [x] Running the script on a fresh database results in an encrypted
      `CLIENT_SECRET` and one current signing key stored in PGlite.
- [x] No plaintext secret appears in shell history, logs, or any file left
      on disk after the script completes.
- [x] Script safely handles being run against an already-seeded database
      (refuses or requires explicit confirmation, does not silently
      overwrite).

## Validation requirements

Run the script; inspect PGlite contents to confirm ciphertext, not
plaintext; inspect shell history and filesystem for leftover plaintext.

## Risks and assumptions

Assumes TASK-001 has produced a real `CLIENT_SECRET` value to seed.

## Blocker

None.

## Implementation handoff

Task: TASK-006 Bootstrap / seed script
Implementer: openai-coder
Date: 2026-09-14

### Changes made

- Added `src/secrets.ts` with an injected PGlite/key store implementing the
  TASK-006 subset of CONTRACT-002's interfaces: AES-256-GCM
  `encryptValue`/`decryptValue`, `setSecret`, and bootstrap-only
  `insertSigningKey`.
- Added `src/seed.ts` with partial-bootstrap detection, hidden TTY input,
  delete-before-database-open one-time file input, RS256 key generation, and
  clean database closure.
- Added the normative `scripts/seed.js` launcher. It respawns `dist/seed.js`
  through Node's `--env-file=.env` support, preserving compatibility with the
  project's Node >=20.6 requirement and forwarding CLI arguments.
- Added `npm run seed` and documented both seed invocations in
  `docs/DEVELOPMENT.md`. No schema, migration, locking, OIDC, retrieval,
  rotation, revocation, or JWKS behavior was added or changed.

### Validation performed

- `npm run build` and `npx tsc --noEmit`: passed with no diagnostics.
- Fresh interactive database through the real raw-mode TTY prompt: exit 0;
  output was `CLIENT_SECRET stored.` followed by a generated-key confirmation.
  Input was not echoed. A first attempt exposed multi-character paste handling;
  the handler was corrected and the successful fresh-directory test repeated.
- Fresh one-time-file database through
  `node scripts/seed.js --client-secret-file=<path>`: exit 0; both confirmation
  lines printed; input file deletion passed; a live `ps -ef` snapshot and a
  recursive binary scan of the data directory contained no dummy plaintext.
- Direct inspection of both databases: each held one `CLIENT_SECRET` and one
  `current`/`RS256` key. Secret/key IVs were 12 bytes, tags 16 bytes, key
  ciphertext 1704 bytes, and ciphertext prefixes were opaque. Interactive IVs
  were `f315440a6130f2cee78a023e` and
  `5ee85fca4a2c736523cb5a77`; file-path IVs were
  `e8c7f3d576f38b381e641de2` and
  `19f0056e83f2632ccceef5d5`; each pair differed.
- Already-seeded invocation: exact output
  `Database already seeded; nothing to do.`, exit 1. SHA-256 of all protected
  row fields was
  `4cccdc257c36235cd949d39dcc6dbbfe2afc9b3738e894f6da99c064604f3fdf`
  both before and after.
- Primitive/store checks: round trip passed; wrong key, tampered ciphertext,
  and wrong AAD each threw; a second `insertSigningKey` threw
  `A current signing key already exists.`
- Forced input-file unlink failure: exit 1 with explicit manual-deletion and
  no-write message; file remained and the fresh data directory contained no
  PGlite files.
- Invalid encryption key and mode-0755 data directory each exited 1 with their
  distinct existing configuration/permission messages.
- Fresh directories were confirmed `drwx------` and owned by the running user.
- Existing service regression attempt: `npm start` reached the HTTP listen but
  this managed sandbox rejected socket creation with
  `Startup error: listen EPERM: operation not permitted 0.0.0.0:43115`;
  consequently an actual `GET /health` could not be completed in this
  environment. Compilation/type-checking and all non-network startup work
  passed.
- **2026-09-14, closed the health-check gap above** (verified outside the
  sandboxed implementer session, in an environment that permits socket
  binding): built `dist/`, started the service against a fresh scratch
  `PGLITE_DATA_DIR` with a real random `DB_ENCRYPTION_KEY`, and ran
  `curl -i http://127.0.0.1:<port>/health` against the live process — got
  `HTTP/1.1 200 OK` with body `{"status":"ok"}`, and the server log showed
  the normal `BTAuthOrchestrator listening on port <port>` line. Confirms
  TASK-004/005's health check and startup path are unaffected by TASK-006's
  changes.

### Acceptance criteria evidence

- Fresh runs through both supported inputs produced exactly one encrypted
  secret row and exactly one current signing-key row with populated binary
  fields and distinct random IVs.
- Dummy plaintext was absent from seed output and database files. The one-time
  input files were deleted. Interactive input was not a process argument and
  was not echoed; no shipped test bypass exists.
- A fully seeded re-run exited non-zero, printed the required exact refusal,
  and preserved byte-for-byte-equivalent protected row values.
- Encryption authentication and duplicate-current rejection were directly
  exercised as described above.

### Assumptions and deviations

- Synthetic validation-only secrets were used. Seeding the real production
  Entra `CLIENT_SECRET` is a manual operator step and was not performed here.
- The service health HTTP request is the sole requested check not completed,
  because the execution sandbox prohibits listening sockets. This is an
  environmental deviation, not a claimed pass.

### Unresolved risks

- ~~A human/operator should run `npm start` and request `GET /health`...~~
  Closed 2026-09-14 — see the added validation entry above.
- Node cannot guarantee zeroing immutable JavaScript strings or generated PEM
  strings in memory; CONTRACT-002 explicitly accepts this limitation.

### Documentation updated

- Updated `docs/DEVELOPMENT.md` with the launcher location, normative command,
  hidden prompt, one-time file behavior, and `npm run seed` alias.

## Review

Not reviewed.
