# TASK-004: Service scaffold

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: none
Related ADRs: none
Dependencies: none (can start immediately; independent of TASK-001/002/003)

## Desired outcome

A minimal, runnable Node/TypeScript service skeleton with narrowed
environment-based bootstrap config and a health check, with no auth or
database logic yet.

## Context

Node/TypeScript chosen for consistency with CDMS's existing `src/proxy.ts`
/ `jose` pattern. Config is deliberately narrow — only true bootstrap values
belong in `.env` per CONTRACT-002's boundary (`PORT`, `PGLITE_DATA_DIR`,
`DB_ENCRYPTION_KEY`, `COOKIE_SECURE`, `TENANT_ID`, `CLIENT_ID`); everything
else is out of scope for this task.

## Scope

### Included

- Project skeleton, package/dependency setup.
- Env-based config loading with validation (clear startup error on missing
  required vars).
- A health-check endpoint.

### Excluded

- Any database connection.
- Any auth/OIDC logic.
- Any JWT/key handling.

## Plan

1. Scaffold a Node/TypeScript project.
2. Implement env-based config loading for `PORT`, `PGLITE_DATA_DIR`,
   `DB_ENCRYPTION_KEY`, `COOKIE_SECURE`, `TENANT_ID`, `CLIENT_ID`,
   validating presence at startup.
3. Implement a health-check endpoint.
4. Document how to run the service locally.

## Acceptance criteria

- [x] Service starts and listens on the configured `PORT`.
- [x] Health-check endpoint responds.
- [x] Missing required env vars produce a clear startup error, not a silent
      failure or an unclear stack trace.
- [x] No database or auth logic present.

## Validation requirements

Manual run-through: start with complete config (succeeds), start with a
missing required var (fails clearly).

## Risks and assumptions

None.

## Blocker

None.

## Implementation handoff

Task: TASK-004: Service scaffold
Implementer: openai-coder
Date: 2026-09-14

### Changes made

- Added a Node/TypeScript project with strict compilation, npm scripts, a lock
  file, ignored generated/local files, and a documented six-variable example
  environment file.
- Added bootstrap configuration loading for exactly `PORT`,
  `PGLITE_DATA_DIR`, `DB_ENCRYPTION_KEY`, `COOKIE_SECURE`, `TENANT_ID`, and
  `CLIENT_ID`. All values must be non-empty; `PORT` must be an integer from 1
  through 65535.
- Added a dependency-free Node HTTP service with `GET /health`, returning
  `200` and `{"status":"ok"}`.
- Added clear handled startup failures without uncaught exception stacks.
- Did not add database, OIDC/auth, JWT, key-handling, or JWKS behavior.

### Validation performed

Validation A used a `.env` containing all six variables with
`PORT=3210`.

Build command:

```sh
npm run build
```

Exact build output:

```text
> bt-auth-orchestrator@0.1.0 build
> tsc
```

Exit code: `0`.

Listen-and-request command:

```sh
set -eu
server_log=/tmp/task-004-server-validation.log
: > "$server_log"
node --env-file=.env dist/index.js >"$server_log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
attempt=0
while ! grep -q 'BTAuthOrchestrator listening on port 3210' "$server_log"; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$server_log"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    cat "$server_log"
    echo 'Timed out waiting for listener'
    exit 1
  fi
  sleep 0.1
done
cat "$server_log"
curl --silent --show-error --include http://127.0.0.1:3210/health
printf '\nCURL_EXIT_CODE=%s\n' "$?"
kill "$server_pid"
wait "$server_pid" || true
trap - EXIT
echo 'SERVER_STOPPED'
```

Exact output:

```text
BTAuthOrchestrator listening on port 3210
HTTP/1.1 200 OK
Content-Type: application/json
Date: Mon, 14 Sep 2026 16:51:24 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"status":"ok"}
CURL_EXIT_CODE=0
SERVER_STOPPED
```

Exit code: `0`. The service bound to configured port `3210`, the real loopback
request returned HTTP status `200` and body `{"status":"ok"}`, and the service
was stopped afterward.

Validation B omitted `CLIENT_ID` while supplying the other five variables.

Command:

```sh
set +e
env -i PATH=/usr/local/bin:/usr/bin:/bin PORT=3210 PGLITE_DATA_DIR=./data DB_ENCRYPTION_KEY=validation-placeholder COOKIE_SECURE=false TENANT_ID=validation-tenant node dist/index.js
status=$?
printf 'EXIT_CODE=%s\n' "$status"
exit 0
```

Exact output:

```text
Configuration error: missing required environment variable(s): CLIENT_ID
EXIT_CODE=1
```

Scope inspection command:

```sh
rg -n -i 'database|pglite|oidc|auth|jwt|jose|key' src package.json || true
```

Exact output:

```text
package.json:2:  "name": "bt-auth-orchestrator",
src/config.ts:3:  "PGLITE_DATA_DIR",
src/config.ts:4:  "DB_ENCRYPTION_KEY",
src/config.ts:12:  pgliteDataDir: string;
src/config.ts:13:  dbEncryptionKey: string;
src/config.ts:47:    pgliteDataDir: environment.PGLITE_DATA_DIR!.trim(),
src/config.ts:48:    dbEncryptionKey: environment.DB_ENCRYPTION_KEY!.trim(),
src/index.ts:20:      console.log(`BTAuthOrchestrator listening on port ${config.port}`);
```

The matches are project/config names only; there is no database or auth
implementation.

### Acceptance criteria evidence

- Service starts and listens on configured `PORT`: verified by the listen
  confirmation on configured port `3210`.
- Health-check endpoint responds: verified by a real loopback `GET /health`
  returning HTTP `200` with `{"status":"ok"}`.
- Missing required variables fail clearly: verified by omitting `CLIENT_ID`;
  the process emitted one human-readable line naming it and exited `1`.
- No database or auth logic: verified by source inspection; only bootstrap
  config names reserved for later tasks are present.

### Assumptions and deviations

- Used Node's built-in HTTP server rather than Express to keep the service
  minimal and dependency-free at runtime.
- Used Node 20's native `--env-file` option; local development therefore
  requires Node.js 20 or newer.
- npm's normal network access was unavailable and its default cache was
  read-only, so installation validation used a copied writable cache at
  `/tmp/task-004-npm` with offline mode.

### Unresolved risks

None.

### Documentation updated

- Updated `docs/DEVELOPMENT.md` with the actual technology stack, repository
  layout, setup/scripts, and coding conventions.
- Left its `Testing philosophy` and `Security and privacy` sections unchanged.

## Review

Not reviewed.
