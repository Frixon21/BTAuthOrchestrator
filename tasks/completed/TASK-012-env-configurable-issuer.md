# TASK-012: Make session-token `iss` env-configurable

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Patrick Moon
Proposed date: 2026-09-14
Approved by: Patrick Moon
Approved date: 2026-09-14
Related contracts: CONTRACT-001
Related ADRs: none
Dependencies: TASK-008 (introduced `SERVICE_ISSUER` as a fixed constant)

## Desired outcome

The session token's `iss` claim value is sourced from an environment
variable rather than hardcoded as a constant in `src/config.ts`, so a
future non-production deployment (or a hostname change) does not require a
code change.

## Context

TASK-008 implemented CONTRACT-001 §4's `iss` claim as a fixed constant,
`SERVICE_ISSUER = "https://orca.biztechro.com"` in `src/config.ts`, and
flagged it as a judgment call worth human review rather than build it
env-driven without asking. Patrick confirmed he wants it env-configurable,
matching the pattern already used for `TENANT_ID`/`CLIENT_ID`.

**Note for the implementer:** CONTRACT-002's Context section enumerates
exactly six bootstrap-only `.env` values (`PORT`, `PGLITE_DATA_DIR`,
`DB_ENCRYPTION_KEY`, `COOKIE_SECURE`, `TENANT_ID`, `CLIENT_ID`) as what
belongs in `.env`. This task adds a seventh. That list describes what
*may* live in `.env` as a non-secret bootstrap value, not a closed
enumeration that forbids additions — `iss` is exactly the same shape
(non-secret, needed before the app can do anything else) as the existing
six — but this is flagged explicitly per this project's convention of
naming judgment calls rather than making them silently. This does not
require a CONTRACT-001/002 amendment: the contracts fix the *value*
(`https://orca.biztechro.com`) and the claim's presence/shape, not the
mechanism by which the running process obtains it.

## Scope

### Included

- Add a new required env var (suggested name: `SERVICE_ISSUER`, to match
  the existing constant's name — implementer may confirm/rename if a
  clearer name fits the existing `src/config.ts` conventions) to
  `src/config.ts`'s required-variable validation, `.env.example`, and
  `docs/DEVELOPMENT.md`.
- Remove the hardcoded `SERVICE_ISSUER` constant; `Config.issuer` is
  populated from the new env var instead.
- No change to CONTRACT-001's required claim shape or value — the
  production value remains `https://orca.biztechro.com`; this task only
  changes where that value is read from.

### Excluded

- Any other config value becoming env-driven.
- Any change to CONTRACT-001 or CONTRACT-002 themselves.
- The OIDC login flow (TASK-007) or JWKS/minting logic itself (TASK-008,
  already implemented) — this task only touches how `issuer` is sourced.

## Plan

1. Add the new required env var to `src/config.ts`'s validation (missing →
   same clear startup-error behavior as the existing six variables).
2. Populate `Config.issuer` from it; remove the hardcoded constant.
3. Update `.env.example` and `docs/DEVELOPMENT.md` to document the new
   variable, including the production value it must be set to
   (`https://orca.biztechro.com`).
4. Confirm token minting (TASK-008) and the JWKS endpoint are unaffected in
   behavior — only the source of the `iss` value changes.

## Acceptance criteria

- [x] `iss` is sourced from an env var, not a hardcoded constant.
- [x] Missing the new env var produces the same clear, fail-closed startup
      error as the existing six required variables — no silent fallback.
- [x] A minted token's `iss` claim matches whatever value the env var is
      set to (proving it's genuinely read from config, not still
      hardcoded).
- [x] `.env.example` and `docs/DEVELOPMENT.md` document the new variable.

## Validation requirements

Start the service with the new var set to a test value and confirm a
minted token's `iss` matches it; start with the var missing and confirm a
clear startup error, not a silent default or stack trace.

## Risks and assumptions

None beyond TASK-008 already being implemented (it is — in
`tasks/review/`).

## Blocker

None.

## Implementation handoff

Task: TASK-012 — Make session-token `iss` env-configurable
Implementer: openai-coder
Date: 2026-09-14

### Changes made

- Added `SERVICE_ISSUER` as the seventh entry in `src/config.ts`'s existing
  `requiredVariables` array, so it uses the same whitespace-aware missing-value
  validation and aggregated configuration-error format as every other required
  variable.
- Removed the exported hardcoded `SERVICE_ISSUER` constant and populated
  `Config.issuer` from `environment.SERVICE_ISSUER!.trim()`.
- Left `src/tokens.ts` unchanged; its existing `.setIssuer(issuer)` path now
  receives the environment-backed `config.issuer` value.

### Validation performed

- Built the project:

  ```text
  $ npm run build

  > bt-auth-orchestrator@0.1.0 build
  > tsc

  EXIT_CODE=0
  ```

- Created a fresh validation directory:

  ```text
  $ mktemp -d /tmp/task012-validation.XXXXXX
  /tmp/task012-validation.EP3gVs
  ```

- Seeded the fresh database with the test issuer and a dummy client secret
  entered through the seed command's hidden TTY prompt (the interactive value
  was not echoed or placed in command-line arguments):

  ```text
  $ env PORT=41812 PGLITE_DATA_DIR=/tmp/task012-validation.EP3gVs/data DB_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 COOKIE_SECURE=false TENANT_ID=task012-tenant CLIENT_ID=task012-client SERVICE_ISSUER=https://test-issuer.example.invalid node dist/seed.js
  CLIENT_SECRET:
  CLIENT_SECRET stored.
  Signing key 76f0be64-ad18-4532-adb9-cd5a903f8563 generated and stored as current.
  EXIT_CODE=0
  ```

- Loaded the current signing key from that database, minted through
  `mintSessionToken` using `loadConfig(process.env).issuer`, and decoded the JWT
  payload locally without printing or transmitting the encoded token:

  ```text
  $ env PORT=41812 PGLITE_DATA_DIR=/tmp/task012-validation.EP3gVs/data DB_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 COOKIE_SECURE=false TENANT_ID=task012-tenant CLIENT_ID=task012-client SERVICE_ISSUER=https://test-issuer.example.invalid node --input-type=module -e 'import { loadConfig } from "./dist/config.js"; import { openDatabase } from "./dist/database.js"; import { createSecretsStore } from "./dist/secrets.js"; import { mintSessionToken } from "./dist/tokens.js"; const config = loadConfig(process.env); const handle = await openDatabase(config.pgliteDataDir); try { const key = await createSecretsStore(handle.database, config.dbEncryptionKey).getCurrentSigningKey(); const token = await mintSessionToken({ sub: "task012-subject", email: "task012@example.invalid", upn: "task012@example.invalid" }, key, config.issuer, new Date("2026-09-14T19:00:00.000Z")); const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); console.log(JSON.stringify(payload)); console.log(`iss=${payload.iss}`); } finally { await handle.close(); }'
  {"sub":"task012-subject","email":"task012@example.invalid","upn":"task012@example.invalid","iat":1789412400,"exp":1789455600,"iss":"https://test-issuer.example.invalid"}
  iss=https://test-issuer.example.invalid
  EXIT_CODE=0
  ```

- Started the compiled entry point with all prior required variables present
  and `SERVICE_ISSUER` explicitly unset:

  ```text
  $ env -u SERVICE_ISSUER PORT=41812 PGLITE_DATA_DIR=/tmp/task012-validation.EP3gVs/data DB_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 COOKIE_SECURE=false TENANT_ID=task012-tenant CLIENT_ID=task012-client node dist/index.js 2>&1; status=$?; echo "EXIT_CODE=$status"
  Configuration error: missing required environment variable(s): SERVICE_ISSUER
  EXIT_CODE=1
  ```

  Output was a single clear configuration-error line plus the captured exit
  code; no raw stack trace was emitted.

- Attempted to start the compiled service with valid configuration for live
  HTTP checks. The managed execution sandbox prohibited binding a listening
  socket:

  ```text
  $ env PORT=41812 PGLITE_DATA_DIR=/tmp/task012-validation.EP3gVs/data DB_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 COOKIE_SECURE=false TENANT_ID=task012-tenant CLIENT_ID=task012-client SERVICE_ISSUER=https://test-issuer.example.invalid node dist/index.js
  Startup error: listen EPERM: operation not permitted 0.0.0.0:41812
  EXIT_CODE=1
  ```

  After confirming that process had exited, removed only its stale throwaway
  validation lock using the documented unclean-exit recovery procedure:

  ```text
  $ rm /tmp/task012-validation.EP3gVs/data/.btauthorchestrator.lock
  EXIT_CODE=0
  ```

- Because the sandbox disallowed a live socket, invoked the exported production
  request handler directly against the same seeded `SecretsStore` to validate
  the `/health` and JWKS route behavior:

  ```text
  $ env PORT=41812 PGLITE_DATA_DIR=/tmp/task012-validation.EP3gVs/data DB_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 COOKIE_SECURE=false TENANT_ID=task012-tenant CLIENT_ID=task012-client SERVICE_ISSUER=https://test-issuer.example.invalid node --input-type=module -e 'import { openDatabase } from "./dist/database.js"; import { createSecretsStore } from "./dist/secrets.js"; import { createRequestHandler } from "./dist/index.js"; const handle = await openDatabase(process.env.PGLITE_DATA_DIR); try { const handler = createRequestHandler(createSecretsStore(handle.database, process.env.DB_ENCRYPTION_KEY)); for (const url of ["/health", "/.well-known/jwks.json"]) { const result = { status: 0, headers: {}, body: "" }; const response = { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(body = "") { result.body = body; } }; await handler({ method: "GET", url }, response); console.log(`${url} STATUS=${result.status}`); console.log(`${url} HEADERS=${JSON.stringify(result.headers)}`); console.log(`${url} BODY=${result.body}`); } } finally { await handle.close(); }'
  /health STATUS=200
  /health HEADERS={"Content-Type":"application/json"}
  /health BODY={"status":"ok"}
  /.well-known/jwks.json STATUS=200
  /.well-known/jwks.json HEADERS={"Content-Type":"application/json","Cache-Control":"no-store"}
  /.well-known/jwks.json BODY={"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"76f0be64-ad18-4532-adb9-cd5a903f8563","n":"pftjSZhKiFDnUBK2BVBUADVH-cHUwRj7DBnlGjG1DO-Wpt-K9FnE8Rq_T-1YfjlrHfczos1Qygp_27GZyolkLQCgVACOAEjVz6Hy5Ck-wMlQh8suT8UIqLnOZLAMKs_ER9MMkjb3xAUBrz527pCFWCXV9WDnrvttUZq_tXqJ3cc0qwfskzdNOnCDOtrVH5UQdVqyHvAom6nCXTlPUOapJTnZ_QHPjP95unBYmGE2ZtteN3BSvNKi0KAqOJxvq6Wdw3wRxQVOrKvY8V9S9OR5FyGT6Y4VCzifs5A5KkuyeW0KOKtbfK3BAX98chVNa55RYQk91FIt0IEE4ZH21d6v9w","e":"AQAB"}]}
  EXIT_CODE=0
  ```

### Acceptance criteria evidence

- Environment-backed issuer: source inspection and successful compilation show
  no hardcoded issuer constant remains; the returned config trims and uses
  `environment.SERVICE_ISSUER`.
- Fail-closed startup: with only `SERVICE_ISSUER` unset, startup emitted the
  standard `Configuration error: missing required environment variable(s):
  SERVICE_ISSUER` message, returned exit code 1, and emitted no stack trace.
- Minted claim: local decoding of a token minted from the seeded current key and
  `config.issuer` returned exactly
  `iss=https://test-issuer.example.invalid`.
- Documentation: `.env.example` documents the variable and required production
  value; `docs/DEVELOPMENT.md` documents its role, production value, and
  non-production use.
- Route regression evidence: the production request handler returned 200 with
  `{"status":"ok"}` for `/health` and 200 with a public RS256 key plus
  `Cache-Control: no-store` for `/.well-known/jwks.json` under valid issuer
  configuration.

### Assumptions and deviations

- TASK-008 does not expose an HTTP token-mint endpoint; validation therefore
  used its public `mintSessionToken` function with the current key loaded from
  the seeded store and passed `loadConfig(process.env).issuer`, matching the
  implemented minting boundary.
- The managed sandbox denied all live listening at the service's bind step with
  `EPERM`. Route regression validation used the exported production request
  handler directly instead of claiming a successful live curl check. No source
  change was made to work around the environment restriction.
- `src/tokens.ts`, CONTRACT-001, and CONTRACT-002 were not modified.

### Unresolved risks

- ~~A live socket-level `/health` and JWKS request could not be completed...~~
  Closed 2026-09-14 (verified outside the sandboxed implementer session, in an
  environment that permits socket binding): built `dist/`, started the service
  against a fresh scratch `PGLITE_DATA_DIR` with `SERVICE_ISSUER=https://orca.biztechro.com`
  and a real random `DB_ENCRYPTION_KEY`, then ran real `curl -i` requests
  against the live listening process. `GET /health` → `HTTP/1.1 200 OK`,
  `{"status":"ok"}`. `GET /.well-known/jwks.json` → `HTTP/1.1 200 OK`,
  `Cache-Control: no-store`, `{"keys":[]}` (empty is correct — no signing key
  was seeded in this data directory). Confirms both routes are unaffected by
  the `SERVICE_ISSUER` change over a real socket, not just the handler
  function.

### Documentation updated

- Added `SERVICE_ISSUER=https://orca.biztechro.com` and its production-value
  requirement to `.env.example`.
- Updated `docs/DEVELOPMENT.md` from six to seven required variables and
  documented how `SERVICE_ISSUER` controls the session-token `iss` claim.

## Review

Not reviewed.
