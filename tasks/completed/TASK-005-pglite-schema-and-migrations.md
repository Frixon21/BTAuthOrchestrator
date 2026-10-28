# TASK-005: PGlite schema & migrations

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-002
Related ADRs: none
Dependencies: TASK-003 (CONTRACT-002 approved), TASK-004 (scaffold)

## Desired outcome

PGlite is integrated into the service with a schema and migration mechanism
matching CONTRACT-002, and the data directory is hardened per its permission
requirements.

## Context

Implements CONTRACT-002's schema and operational requirements. Encryption
itself (encrypt/decrypt helpers) may be implemented here or in TASK-008/009
— whichever this task's implementer finds cleaner — but the schema must
support the encrypted-secrets and signing-key tables CONTRACT-002 defines,
including `kid`/status on signing keys.

## Scope

### Included

- PGlite dependency integration.
- Schema/migrations per CONTRACT-002 (signing keys table with kid/status,
  generic encrypted-secrets table).
- Data-directory creation with the required permissions.
- Startup logic that opens the database as a single process (per the
  single-process constraint).

### Excluded

- The bootstrap/seed script itself (TASK-006).
- JWKS endpoint and key-loading logic (TASK-008).
- The rotation trigger (TASK-009).

## Plan

1. Add PGlite as a dependency.
2. Implement schema/migrations per CONTRACT-002 (signing keys table with
   kid/status, generic encrypted-secrets table).
3. Create/open the PGlite data directory at `PGLITE_DATA_DIR` with the
   permissions CONTRACT-002 requires.
4. Verify only a single process can hold the data directory open at a time
   (or document why PGlite's own locking already guarantees this).

## Acceptance criteria

- [x] Schema matches CONTRACT-002 exactly (tables, key fields, kid/status on
      signing keys).
- [x] Data directory is created with the required restrictive permissions.
- [x] Service still starts cleanly with the health check from TASK-004
      intact.
- [x] Single-process constraint is enforced or explicitly verified as
      inherent to PGlite's behavior.

## Validation requirements

Verify schema against CONTRACT-002 line by line; verify data-directory
permissions on disk after a fresh start.

## Risks and assumptions

Assumes CONTRACT-002 is approved before this starts.

## Blocker

None.

## Implementation handoff

Task: TASK-005: PGlite schema & migrations
Implementer: openai-coder
Date: 2026-09-14

### Changes made

- Added `@electric-sql/pglite` 0.5.8 as a runtime dependency.
- Added `src/database.ts`. It creates a missing data directory as `0700`,
  verifies exact mode and running-user ownership before opening PGlite,
  acquires an exclusive `.btauthorchestrator.lock`, opens PGlite, and executes
  an idempotent raw SQL migration at every startup.
- The raw SQL migration creates exactly the contract's `secrets` and
  `signing_keys` tables with `CREATE TABLE IF NOT EXISTS`. A database `CHECK`
  restricts status to `current`, `retired`, or `revoked`; a partial unique
  index on the constant `true` for rows where `status = 'current'` permits at
  most one current key. No rows are seeded.
- Integrated directory preparation, database initialization/migration, and
  graceful database/lock cleanup into `src/index.ts` before the existing HTTP
  server listens. Existing health and 404 response behavior is unchanged.
- Extended existing configuration validation to enforce CONTRACT-002's
  64-lowercase-hex-character `DB_ENCRYPTION_KEY` precondition without adding or
  removing environment variables.

### Validation performed

1. Dependency installation:

   Command: `npm install @electric-sql/pglite`

   The first attempt could not write npm's host cache and made no dependency
   change:

   ```text
   npm ERR! code EROFS
   npm ERR! syscall open
   npm ERR! path /home/patrick/.npm/_cacache/tmp/fe12d06d
   npm ERR! errno -30
   npm ERR! rofs EROFS: read-only file system, open '/home/patrick/.npm/_cacache/tmp/fe12d06d'
   npm ERR! rofs Often virtualized file systems, or other file systems
   npm ERR! rofs that don't support symlinks, give this error.

   npm ERR! Log files were not written due to an error writing to the directory: /home/patrick/.npm/_logs
   npm ERR! You can rerun the command with `--loglevel=verbose` to see the logs in your terminal
   ```

   Retried with the writable cache only: `npm_config_cache=/tmp/btauth-npm-cache npm install @electric-sql/pglite`

   ```text
   added 1 package, and audited 5 packages in 590ms

   found 0 vulnerabilities
   ```

2. Strict build/typecheck (run after implementation, after shutdown handling
   was tightened, and once more after the handoff/task relocation):
   `npm run build`

   ```text
   > bt-auth-orchestrator@0.1.0 build
   > tsc
   ```

   All three runs exited 0 with no TypeScript errors.

3. Fresh-directory creation, health check, concurrent-process behavior, clean
   lock release, and wrong-permission refusal were run together using compiled
   `dist/index.js` with all six environment variables explicitly set. The first
   process used a nonexistent `/tmp/task005-final.SEw1qE/data`, the second used
   the same directory concurrently, and the wrong-mode process used a newly
   created `0755` directory. Observed output:

   ```text
   validation_root=/tmp/task005-final.SEw1qE
   --- a. fresh directory ---
   BTAuthOrchestrator listening on port 43205
   path=/tmp/task005-final.SEw1qE/data mode=700 permissions=drwx------ uid=1000 owner=patrick
   --- d. health endpoint ---
   HTTP/1.1 200 OK
   Content-Type: application/json
   Date: Mon, 14 Sep 2026 17:41:05 GMT
   Connection: keep-alive
   Keep-Alive: timeout=5
   Transfer-Encoding: chunked

   {"status":"ok"}
   --- e. concurrent second process ---
   Single-process error: the data directory is already locked (/tmp/task005-final.SEw1qE/data/.btauthorchestrator.lock). Stop the other BTAuthOrchestrator process before starting this one.
   exit=1 elapsed_ms=123
   first_process_SIGTERM_exit=0
   lock_after_clean_shutdown=absent
   --- b. wrong existing permissions ---
   Data directory permissions error: /tmp/task005-final.SEw1qE/wrong-permissions must have mode 0700 (found 0755). Run: chmod 700 /tmp/task005-final.SEw1qE/wrong-permissions
   exit=1
   mode_after_refusal=755
   data_dir=/tmp/task005-final.SEw1qE/data
   ```

4. Direct schema-catalog inspection: opened the migrated database with PGlite
   and queried `information_schema.columns`, primary-key metadata,
   `pg_constraint`, and `pg_indexes`. Observed column output:

   ```text
   table_name   pos column_name                data_type                   nullable default primary_key
   secrets       1  name                       text                        NO       -       YES
   secrets       2  ciphertext                 bytea                       NO       -       NO
   secrets       3  iv                         bytea                       NO       -       NO
   secrets       4  auth_tag                   bytea                       NO       -       NO
   secrets       5  created_at                 timestamp with time zone    NO       now()   NO
   secrets       6  updated_at                 timestamp with time zone    NO       now()   NO
   signing_keys  1  kid                        text                        NO       -       YES
   signing_keys  2  algorithm                  text                        NO       -       NO
   signing_keys  3  status                     text                        NO       -       NO
   signing_keys  4  public_key                 text                        NO       -       NO
   signing_keys  5  private_key_ciphertext     bytea                       NO       -       NO
   signing_keys  6  private_key_iv             bytea                       NO       -       NO
   signing_keys  7  private_key_auth_tag       bytea                       NO       -       NO
   signing_keys  8  created_at                 timestamp with time zone    NO       now()   NO
   signing_keys  9  retired_at                 timestamp with time zone    YES      -       NO
   signing_keys 10  revoked_at                 timestamp with time zone    YES      -       NO

   status_check: CHECK ((status = ANY (ARRAY['current'::text, 'retired'::text, 'revoked'::text])))
   one_current_index: CREATE UNIQUE INDEX signing_keys_one_current ON public.signing_keys USING btree ((true)) WHERE (status = 'current'::text)
   ```

5. Direct database enforcement checks inserted a deliberately invalid status,
   then attempted two `current` rows (the one successful test row was deleted
   afterward). Observed output:

   ```text
   invalid_status=new row for relation "signing_keys" violates check constraint "signing_keys_status_check"
   second_current=duplicate key value violates unique constraint "signing_keys_one_current"
   ```

6. Native PGlite 0.5.8 locking investigation, before adding the explicit
   guard: one Node process opened a fresh directory and printed `first ready`;
   while it remained running, a second independent Node process opened the same
   directory. Observed second-process output:

   ```text
   second ready
   elapsed=0.542 exit_status_from_command_follows
   exit=0
   ```

   Therefore PGlite's own filesystem behavior did not enforce the contract.
   The explicit exclusive-create lock was added and produced the 123 ms,
   exit-1 result shown above.

### Acceptance criteria evidence

- Schema: all 16 columns were inspected directly in the live PGlite catalog;
  names, PostgreSQL types, nullability, `now()` defaults, and primary keys match
  CONTRACT-002 section 2. The status check and one-current partial unique index
  were also observed and exercised.
- Data directory: a real startup created a previously absent directory; `stat`
  reported mode `700`, `drwx------`, uid 1000/owner `patrick`.
- Fail-closed permissions: a real startup against mode `0755` printed the exact
  `chmod 700` correction, exited 1 without a stack trace, and left mode `755`
  unchanged.
- Health: a request to the running compiled service returned HTTP 200 and
  `{"status":"ok"}`.
- Single process: native PGlite allowed two opens, so the implemented lock was
  tested with two compiled service processes; the second exited 1 in 123 ms.
  Normal SIGTERM exited 0 and removed the lock.
- Build: strict `tsc` completed three times with exit 0 and no errors.
- Scope: no bootstrap/seed, JWKS, key-loading, rotation-trigger, OIDC, login, or
  encryption/storage-interface application logic was added.

### Assumptions and deviations

- Dedicated-service-user provisioning is outside scope. Runtime enforcement is
  the contract-requested approximation: directory uid must equal
  `process.getuid()` (uid 1000, `patrick`, in validation).
- Migration mechanism choice: idempotent raw SQL embedded in the database
  module and executed on every startup. No migration-tracking table is created,
  keeping the application schema to exactly the two contract tables.
- An exclusive-create lock file was required because the empirical native
  PGlite test allowed concurrent access. The lock contains only the process id
  and is mode `0600` inside the `0700` data directory.
- The initial npm command used the default unwritable cache and failed with
  `EROFS`; the only deviation on retry was selecting a writable `/tmp` cache.

### Unresolved risks

- `SIGKILL`, host failure, or another unclean termination can leave the lock
  file behind. This fails closed on the next start; an operator must confirm no
  process is using the directory and manually remove the stale lock. Automatic
  stale-lock deletion was intentionally avoided because PID reuse and races
  could violate the single-process invariant.
- `CREATE TABLE/INDEX IF NOT EXISTS` is safe and idempotent for the intended
  newly managed database, but intentionally does not rewrite a pre-existing,
  externally created table of the same name with an incompatible definition.
- PGlite's public `PGlite` API can still be used by unrelated ad hoc code to
  bypass this service-level lock; all BTAuthOrchestrator database opens must go
  through `openDatabase`.

### Documentation updated

- `docs/DEVELOPMENT.md` now records PGlite as a runtime component and documents
  first-start directory creation, existing-directory validation, startup
  migration/locking order, corrective failures, and stale-lock recovery.
- This task file records the implementation, actual validation evidence,
  assumptions/deviations, and residual risks.

## Review

Not reviewed.
