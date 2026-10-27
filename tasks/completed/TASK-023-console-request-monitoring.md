# TASK-023: Console request and error monitoring

Owner role: Implementation
Assigned agent: Claude Code
Approved by: Patrick (direct implementation request)
Approved date: 2026-10-19
Related contracts: None (log output only; no response contract changes)

## Desired outcome

Intermittent 500 responses can be diagnosed from the service's console
output: which request failed, when, and the underlying error.

## Plan and acceptance criteria

Add timestamped, levelled, request-id-correlated console lines; one summary
line per request; log the error and its cause chain on every 500 path,
including the ones that previously swallowed errors silently; catch
exceptions that escape route handlers. Never log query strings, credentials,
or secrets.

## Implementation handoff

Task: TASK-023
Implementer: Claude Code
Date: 2026-10-19

### Changes made

- New `src/logging.ts`: console formatting (timestamp, level, request id via
  `AsyncLocalStorage`), `describeError` (message, `code`, cause chain),
  `describeErrorWithStack`, `withRequestMonitoring` (per-request summary
  line, last-resort 500), and process-level unhandled rejection/uncaught
  exception logging.
- `src/index.ts`: `start()` installs the logging, logs a non-secret startup
  summary, and wraps the server's listener. `errorMessage` now includes the
  cause chain. Unexpected-failure 500 paths log stack traces. The JWKS and
  registration-page user-list failures, previously silent, are now logged.
- `src/apiDocs.ts`: a docs-asset read failure (500) is now logged.

### Validation performed

`npm run build`, `node scripts/test-api-docs.js`, and
`node scripts/test-local-registration.js` pass. A live HTTP check of the
wrapper confirmed request-id propagation across `await`, query-string
stripping, a thrown error producing a logged stack plus a JSON 500, cause
chains with error codes, the 4xx/5xx levels, and quiet `/health`.

### Assumptions and deviations

- Successful `/health` requests are not logged, so probes don't flood the
  console.
- An uncaught exception still exits the process (Node's default), but is
  logged first. Unhandled rejections are logged and no longer crash it.
- `createRequestHandler` is deliberately left unwrapped for in-process
  callers (tests, verify-offline fallback).

### Unresolved risks

Log volume grows by one line per request. Not run against a deployed instance.
Error messages from dependencies are logged verbatim, as before.

### Documentation updated

docs/DEVELOPMENT.md ("Console monitoring").

## Review

Not reviewed.

## Human acceptance

Pending.
