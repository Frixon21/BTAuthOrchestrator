# TASK-010: Offline verification proof

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-001
Related ADRs: none
Dependencies: TASK-007, TASK-008, TASK-009

## Desired outcome

A standalone proof that a minted token can be verified completely offline
using only the public key from JWKS, with zero runtime calls back to
BTAuthOrchestrator beyond the initial key fetch — and that a token signed
under a since-rotated-out key correctly fails verification.

## Context

This is the actual acceptance bar for NOTES.md §6 milestone step 2 ("prove
the mint end works and that a token can be verified offline with only the
public key"). Modeled on CDMS's existing `src/proxy.ts` verification
pattern.

## Scope

### Included

- A standalone verifier (script or test) that fetches the public key(s)
  from JWKS once, then verifies a minted token with no further calls to
  BTAuthOrchestrator.
- A second case proving a token signed under a rotated-out key fails
  verification.

### Excluded

- Building this into any real consuming app (that's milestone step 3+,
  CDMS integration).

## Plan

1. Mint a token via TASK-007's flow.
2. Verify it offline using only JWKS-fetched public key material.
3. Trigger TASK-009's rotation.
4. Confirm the same token now fails offline verification.

## Acceptance criteria

- [x] A freshly minted token verifies successfully offline using only the
      public key.
- [x] No call to BTAuthOrchestrator occurs during verification itself, only
      the one-time key fetch.
- [x] A token signed under a since-rotated-out key fails verification.

## Validation requirements

Run the verifier against both a fresh and a rotated-out token; confirm
expected pass/fail in each case.

## Risks and assumptions

None.

## Blocker

None.

## Implementation handoff

Task: TASK-010 — Offline verification proof
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
was disconnected this session; Patrick authorized proceeding in his absence)
Date: 2026-09-15

### Changes made

- **`src/verify-offline.ts`** (new): a standalone, re-runnable proof script
  matching this project's existing `scripts/seed.js`/`src/seed.ts`
  standalone-operational-script pattern (thin `scripts/*.js` wrapper over a
  compiled `dist/<name>.js`). It performs exactly the three acceptance
  criteria, end to end:
  1. Reads the current signing key directly from `PGLITE_DATA_DIR` (via
     `openDatabase`/`SecretsStore.getCurrentSigningKey()`), releasing the
     database's single-process lock (`handle.close()`) immediately
     afterward, then mints a session token via `mintSessionToken` directly
     (no interactive Entra/TASK-007 login is used or required, per this
     brief's explicit instruction).
  2. Fetches `/.well-known/jwks.json` exactly once, then verifies the token
     completely offline using `jose`'s `createLocalJWKSet` (which performs
     no network I/O of its own, unlike `createRemoteJWKSet`). The `jwtVerify`
     call is bracketed by an instrumented `globalThis.fetch` wrapper that
     counts calls made during verification, so "zero further HTTP calls
     during verification" is empirically measured and printed, not merely
     asserted because of which jose helper was chosen.
  3. Triggers `POST /admin/emergency-rotate-keys` with
     `Authorization: Bearer <EMERGENCY_ROTATION_TOKEN>`.
  4. Re-fetches JWKS, confirms the rotated-out `kid` is absent from the
     `keys` array, and re-runs the same offline-verification routine against
     the same token and the fresh JWKS, confirming `jwtVerify` now throws.
  - The script prints one `[AC1]`/`[AC2]`/`[AC3]` PASS/FAIL line (with a
    short evidence detail) per acceptance criterion, plus a final `Summary`
    block and `Overall: PASS`/`FAIL`, and exits non-zero if any criterion
    fails — this is the durable, re-runnable proof artifact the task asks
    for, not a one-off validation transcript.
  - **Single-process/live-service design** (see "Assumptions and
    deviations" for the full reasoning): because CONTRACT-002 enforces a
    strict single-process lock on `PGLITE_DATA_DIR`, this script cannot read
    the current signing key directly from the database while a *separately*
    launched instance of the service already holds that lock. To remain a
    single, self-contained, one-command proof runnable against a real
    running instance, the script itself launches the real compiled service
    (`dist/index.js`) as a child process against the same real `.env` —
    but only *after* it has already read the key and released the lock. All
    JWKS fetches and the rotation trigger are then real HTTP calls
    (`fetch`) to that real running child process on `127.0.0.1:<PORT>`, and
    the child is stopped cleanly (`SIGTERM`, with a `SIGKILL` fallback) once
    the proof completes.
  - **Sandbox fallback**: before doing any of the above, the script probes
    whether this host permits binding a loopback socket at all
    (`net.createServer().listen()`, mirroring TASK-009's own probe
    technique). If not, it falls back to invoking the exported
    `createRequestHandler(secretsStore, config)` function directly against
    fake `IncomingMessage`/`ServerResponse` objects (no real socket, no
    child process) — exactly the TASK-008/012 precedent this brief pointed
    to — and prints this plainly at the top of its output. Both code paths
    converge on one shared `runVerificationSequence` function so the actual
    verification logic (steps 2–4) is identical and equally rigorous in
    either mode; only how JWKS is fetched and rotation is triggered differs.
  - If a *separate* instance of the service is already running against the
    same `PGLITE_DATA_DIR` when this script starts, `openDatabase` fails
    fast with CONTRACT-002's existing "already locked" error (see
    Validation performed) rather than the script hanging, corrupting state,
    or silently reading stale key material.
- **`scripts/verify-offline.js`** (new): thin wrapper spawning
  `node --env-file=.env dist/verify-offline.js`, byte-for-byte matching
  `scripts/seed.js`'s existing structure (same `spawnSync`, same
  `stdio: "inherit"`, same error/exit-code handling).
- **`package.json`**: added `"verify-offline": "npm run build && node
  scripts/verify-offline.js"`, matching the existing `"seed"` script's exact
  shape.
- **`docs/DEVELOPMENT.md`**: added `npm run verify-offline` to the commands
  list and a paragraph documenting what the script does, its single-process/
  live-service design, its sandbox fallback, and its pass/fail output
  contract (see "Documentation updated" below).
- No changes to `src/tokens.ts`, `src/index.ts`'s route handlers,
  `src/secrets.ts`, JWKS/signing internals, or the OIDC login flow — this
  task only adds a new standalone script that calls existing, unmodified
  exports (`mintSessionToken`, `createRequestHandler`, `createSecretsStore`,
  `openDatabase`, `loadConfig`). Nothing in `src/index.ts` was edited; it is
  only imported from.
- No consuming app was touched or integrated (out of scope per this task's
  own Excluded section).

### Validation performed

This sandbox session permitted live socket binding (confirmed with the same
`net.createServer().listen()` probe technique TASK-009 used), so the
**primary** validation below exercised the live-HTTP code path: a real
compiled service, spawned by the script itself, over a real loopback socket,
with real `fetch` calls for JWKS and the rotation trigger. The fallback
(in-process handler) code path was also independently exercised (see below)
to confirm it works correctly for a future session where live socket binding
is unavailable, even though this session did not need to rely on it.

- `npm run build`: TypeScript compiled cleanly with no errors.
- Created a fresh throwaway validation directory with its own `.env`-shaped
  variables (fresh random 64-hex-character `DB_ENCRYPTION_KEY`, fresh random
  32-byte-hex `EMERGENCY_ROTATION_TOKEN`, a dedicated `PGLITE_DATA_DIR`
  under `/tmp`, a distinct `SERVICE_ISSUER`, and dummy `TENANT_ID`/
  `CLIENT_ID` since no OIDC flow is exercised by this task). The
  repository's own `.env` was not modified — it currently predates
  TASK-009/012 (`SERVICE_ISSUER`/`EMERGENCY_ROTATION_TOKEN` are absent from
  it, since those tasks are still in `tasks/review/`), so the service cannot
  start against it yet regardless of this task; this is normal and expected
  since `.env` is operator-managed, not committed, and this task does not
  own updating it.
- Seeded that fresh database (`node dist/seed.js
  --client-secret-file=<path>`, a throwaway dummy `CLIENT_SECRET`):
  ```text
  CLIENT_SECRET stored.
  Signing key 8e086139-9f8a-433e-a73a-3bbe6aea03af generated and stored as current.
  EXIT_CODE=0
  ```
- **Live-mode run** (`node dist/verify-offline.js` against that seeded
  directory's env — the actual `npm run verify-offline` entry point, run
  post-build):
  ```text
  === BTAuthOrchestrator offline verification proof (TASK-010) ===
  Issuer: https://task010-verify.example.invalid
  Data directory: /tmp/.../validation.93io0o/data

  === Mode: live HTTP against a real spawned instance of the compiled service ===
  Read current signing key kid=8e086139-9f8a-433e-a73a-3bbe6aea03af from /tmp/.../data (lock released).
  Minted a session token via mintSessionToken() directly (no interactive Entra login), kid=8e086139-9f8a-433e-a73a-3bbe6aea03af.
  BTAuthOrchestrator listening on port 41930
  Real compiled service is listening and healthy at http://127.0.0.1:41930.

  === Step: one-time JWKS fetch (pre-rotation) ===
  Fetched JWKS: 1 key(s), kids=[8e086139-9f8a-433e-a73a-3bbe6aea03af].

  === Step: offline verification of the freshly minted token ===
  [AC1] PASS - jwtVerify succeeded against the fetched JWKS (kid=8e086139-9f8a-433e-a73a-3bbe6aea03af).
  [AC2] PASS - Instrumented global fetch recorded 0 call(s) during the jwtVerify() call itself (only the JWKS fetch above happened outside this window).

  === Step: trigger CONTRACT-003 emergency key rotation ===
  Rotated: previousKid=8e086139-9f8a-433e-a73a-3bbe6aea03af newKid=a1f9060a-3512-4e87-a952-31c41367b4a3.

  === Step: re-fetch JWKS (post-rotation) and confirm the rotated-out kid is absent ===
  Fetched JWKS: 1 key(s), kids=[a1f9060a-3512-4e87-a952-31c41367b4a3]. Rotated-out kid (8e086139-9f8a-433e-a73a-3bbe6aea03af) present: false.

  === Step: offline verification of the same token after rotation (expected to fail) ===
  [AC3] PASS - jwtVerify correctly threw against the fresh JWKS (rotated-out kid absent): no applicable key found in the JSON Web Key Set
  Spawned service process stopped.

  === Summary ===
  AC1: PASS - A freshly minted token verifies successfully offline using only the public key.
  AC2: PASS - No call to BTAuthOrchestrator occurs during verification itself, only the one-time key fetch.
  AC3: PASS - A token signed under a since-rotated-out key fails verification.
  Overall: PASS
  EXIT_CODE=0
  ```
  This is a real 200 JWKS response from a real listening socket, a real 200
  `POST /admin/emergency-rotate-keys` response, a real second JWKS fetch,
  and a real `jose` `JWKSNoMatchingKey`-class failure — not a simulation.
- **Fallback-mode run**: to independently confirm the in-process
  `createRequestHandler` fallback path (used automatically whenever a
  session cannot bind a loopback socket) also works correctly, seeded a
  second fresh throwaway database, temporarily patched the *compiled*
  `dist/verify-offline.js` in place (single line: forced
  `canBindSocket = false`, restored immediately after this one run — no
  source file was changed) and re-ran it:
  ```text
  === Mode: in-process handler fallback (this sandbox does not permit live socket binding) ===
  Falling back to invoking the exported createRequestHandler() function directly, exactly as TASK-008/012's validation did when live socket binding was unavailable. No real HTTP socket, no real child process, is used in this mode.
  Read current signing key kid=a7319eeb-3e5e-4dbe-82f9-a84266d907a6 from /tmp/.../validation-fallback.WIS1SL/data.
  Minted a session token via mintSessionToken() directly (no interactive Entra login), kid=a7319eeb-3e5e-4dbe-82f9-a84266d907a6.

  === Step: one-time JWKS fetch (pre-rotation) ===
  Fetched JWKS: 1 key(s), kids=[a7319eeb-3e5e-4dbe-82f9-a84266d907a6].

  === Step: offline verification of the freshly minted token ===
  [AC1] PASS - jwtVerify succeeded against the fetched JWKS (kid=a7319eeb-3e5e-4dbe-82f9-a84266d907a6).
  [AC2] PASS - Instrumented global fetch recorded 0 call(s) during the jwtVerify() call itself (only the JWKS fetch above happened outside this window).

  === Step: trigger CONTRACT-003 emergency key rotation ===
  Rotated: previousKid=a7319eeb-3e5e-4dbe-82f9-a84266d907a6 newKid=43890a82-54aa-490c-a51e-1a1883832ea0.

  === Step: re-fetch JWKS (post-rotation) and confirm the rotated-out kid is absent ===
  Fetched JWKS: 1 key(s), kids=[43890a82-54aa-490c-a51e-1a1883832ea0]. Rotated-out kid (a7319eeb-3e5e-4dbe-82f9-a84266d907a6) present: false.

  === Step: offline verification of the same token after rotation (expected to fail) ===
  [AC3] PASS - jwtVerify correctly threw against the fresh JWKS (rotated-out kid absent): no applicable key found in the JSON Web Key Set

  === Summary ===
  AC1: PASS
  AC2: PASS
  AC3: PASS
  Overall: PASS
  EXIT_CODE=0
  ```
  The patched `dist/verify-offline.js` was restored from a backup copy
  immediately after this one run; `npm run build` was re-run afterward to
  regenerate `dist/` cleanly from unmodified source, confirmed identical in
  behavior to the pre-patch live-mode run above.
- **Concurrent-instance-safety check**: started a real service instance
  manually against the fallback-mode validation directory's data dir, then
  — while it was still running and holding the lock — ran
  `node dist/verify-offline.js` against the same directory. Result: the
  script failed fast and cleanly, exit code 1:
  ```text
  Single-process error: the data directory is already locked (/tmp/.../data/.btauthorchestrator.lock). Stop the other BTAuthOrchestrator process before starting this one.
  ```
  No hang, no corrupted lock state, no partial output. The manually started
  service was then stopped cleanly and the lock file was confirmed removed.
- Confirmed via `ps aux` after every run (live-mode, fallback-mode, and the
  concurrent-instance check) that no stray `node dist/index.js` processes
  were left running, and that lock files were removed from every throwaway
  data directory afterward.
- Grepped `src/verify-offline.ts` for the real `EMERGENCY_ROTATION_TOKEN`/
  `DB_ENCRYPTION_KEY`/private-key values: the token is used only inside the
  `Authorization: Bearer` header construction and the config field name in
  log lines, never itself printed; the signing key's `kid` (a public,
  non-secret identifier) is logged, but `privateKeyPem` never appears in any
  `console.log`/`console.error` call.
- No test framework exists in this project (`package.json` has no test
  command); validation therefore used the live/fallback/concurrency runs
  above, matching this project's established (TASK-007/008/009/012)
  validation methodology of exercising real compiled code over real
  sockets/handlers rather than a unit-test suite.

### Acceptance criteria evidence

- **A freshly minted token verifies successfully offline using only the
  public key: met.** `[AC1] PASS` in both the live-mode and fallback-mode
  runs above — `jwtVerify` succeeded against a `createLocalJWKSet` built
  only from the fetched JWKS response.
- **No call to BTAuthOrchestrator occurs during verification itself, only
  the one-time key fetch: met.** `[AC2] PASS` in both runs — the
  instrumented `globalThis.fetch` wrapper recorded exactly 0 calls during
  each `jwtVerify()` invocation; the only network/handler activity involving
  BTAuthOrchestrator around each verification is the single JWKS fetch
  performed immediately before it (shown as its own separate "Step" line in
  the output, outside the instrumented window).
- **A token signed under a since-rotated-out key fails verification: met.**
  `[AC3] PASS` in both runs — after triggering
  `POST /admin/emergency-rotate-keys`, the re-fetched JWKS's `keys` array
  was confirmed to no longer contain the original minting `kid`
  (`rotatedOutKidStillPresent: false`), and the same, unmodified token then
  failed `jwtVerify` against that fresh JWKS with a real
  `JWKSNoMatchingKey`-class error — a demonstrated failure produced by the
  tool itself, not an inferred "would fail" claim.

### Assumptions and deviations

- **The verifier itself spawns the real compiled service as a child
  process, rather than requiring the operator to have already started it
  separately.** This is the one material design judgment call this task
  required. CONTRACT-002's single-process lock on `PGLITE_DATA_DIR` means
  this script cannot open the database (to read the current signing key)
  while a *separately* launched instance of the service already holds that
  lock — and there is no other interface (HTTP or otherwise) that exposes a
  private signing key, nor should there be. Two ways to resolve this were
  considered: (a) make the verifier a purely HTTP-only client and require a
  two-phase manual dance (stop the service, run a key-reading step, restart
  the service, then run the HTTP-only verifier), or (b) have the verifier
  read the key once, release the lock, and then itself start the real
  service as a child process for the HTTP-facing steps. I chose (b): it
  keeps this a single, one-command, re-runnable proof (`npm run
  verify-offline`), matches this task's explicit framing as a *durable,
  re-runnable proof artifact* rather than a manual runbook, and still uses
  the real compiled `dist/index.js` over a real socket for every HTTP-facing
  step — nothing about the JWKS/rotation behavior itself is simulated. The
  literal task text ("runnable against a real running instance of the
  service, started with a real `.env`") is satisfied in the sense that the
  script starts that real instance from the real `.env` itself; if Patrick
  intended this to instead run purely as an HTTP client against an
  already-independently-running instance (e.g., a long-lived production
  deployment), the concurrent-instance-safety check above shows the exact
  (clear, fail-fast) behavior that would currently occur, and adapting the
  script to accept a pre-existing base URL via an environment variable
  (skipping its own key-read/spawn steps entirely) would be a narrow
  follow-up if wanted.
- **A fixed, synthetic identity (`verify-offline-proof-subject` /
  `verify-offline-proof@example.invalid`) is used for the minted token's
  claims**, rather than any real user identity — consistent with this task
  explicitly not requiring a real interactive Entra login.
- **`createLocalJWKSet` (not `createRemoteJWKSet`) is the verification
  mechanism**, specifically because `createRemoteJWKSet` performs its own
  internal HTTP fetches (including possible re-fetches on a `kid` miss),
  which would make "no further calls during verification" true only by
  omission of a retry path rather than true by construction. `createLocalJWKSet`
  performs no network I/O at all, and the added `globalThis.fetch`
  instrumentation empirically confirms this on every run rather than relying
  on documentation of jose's internals.
- **The fallback-mode probe/switch (`net.createServer().listen()`) lives
  inside `verify-offline.ts` itself**, run automatically at the start of
  `main()`, rather than being a separately documented manual step — this
  makes the script itself adaptive to whatever sandbox/host it runs on,
  consistent with it being a durable artifact expected to be re-run in
  different environments (including, per this brief, environments that may
  not permit live socket binding).
- No product behavior, contract, or existing route/module (`src/tokens.ts`,
  `src/index.ts`'s handlers, `src/secrets.ts`, `src/oidc.ts`) was modified —
  everything above is additive (two new files, one new `package.json`
  script, one new `docs/DEVELOPMENT.md` paragraph).

### Unresolved risks

- **The repository's own `.env` does not yet contain `SERVICE_ISSUER` or
  `EMERGENCY_ROTATION_TOKEN`** (TASK-009/012, which introduced them, are
  still in `tasks/review/`, not yet accepted/merged into operator practice).
  This is not a gap introduced by this task — `npm start` against the real
  `.env` would fail the same fail-closed configuration check today,
  independent of `verify-offline` existing — but it means `npm run
  verify-offline` cannot be run against the real `.env` as-is until Patrick
  updates it with those two variables (or accepts TASK-009/012, whichever
  he intends to happen first). All validation above therefore used a fresh,
  throwaway, correctly-configured `.env`-equivalent, exactly as TASK-009's
  and TASK-012's own validations did.
- **If Patrick intends this tool to run purely as an HTTP client against an
  already-independently-running (e.g., production) instance**, rather than
  spawning its own child instance, that is a narrow, clearly-scoped follow-up
  (an optional base-URL override environment variable that skips the
  key-read/spawn steps) — flagged above under "Assumptions and deviations"
  rather than assumed silently.
- No other unresolved risks identified from implementation and validation
  performed. Independent review and human acceptance remain pending.

### Documentation updated

- `docs/DEVELOPMENT.md`: added `npm run verify-offline` to the commands list
  and a full paragraph documenting what the script proves, its
  single-process/live-service design (read key, release lock, then spawn
  the real service), its automatic sandbox fallback, its
  already-locked-directory failure behavior, and its pass/fail output
  contract.

## Review

Not reviewed.
