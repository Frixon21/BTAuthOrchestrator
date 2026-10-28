# TASK-007: Implement OIDC login flow

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-001
Related ADRs: none
Dependencies: TASK-002 (CONTRACT-001 approved), TASK-004 (scaffold),
TASK-006 (`CLIENT_SECRET` available in storage)

## Desired outcome

A working OIDC authorization-code login flow against Entra ID, per
CONTRACT-001, culminating in an issued session cookie.

## Context

Implements CONTRACT-001 exactly. `CLIENT_SECRET` is read from the encrypted
storage layer (TASK-005/006), never from `.env`.

## Scope

### Included

- Redirect-to-Entra endpoint.
- Callback handling.
- Authorization code exchange.
- PKCE/state/nonce enforcement.
- ID token validation.
- Issuing BTAuthOrchestrator's own session token and cookie on success.
- Failure behavior when Entra is unreachable, per CONTRACT-001.

### Excluded

- Signing/JWKS internals (TASK-008).
- Refresh, logout, authorization gating (out of scope per CONTRACT-001).

## Plan

1. Implement the redirect-to-Entra endpoint with PKCE/state/nonce
   generation.
2. Implement the callback endpoint: validate state/nonce, exchange the
   code, validate the ID token.
3. On success, call into TASK-008's minting logic and set the session
   cookie per CONTRACT-001's attributes.
4. Implement the Entra-unreachable failure path per CONTRACT-001.

## Acceptance criteria

- [ ] Full login round-trip succeeds against a real Entra tenant. **Not
      verified by the implementer** — see "Unresolved risks" below;
      requires a real user, a real browser, and the real `CLIENT_SECRET`,
      none of which are available in the sandboxed implementer session.
- [x] PKCE/state/nonce are enforced; a tampered or missing value is
      rejected.
- [x] Entra-unreachable failure path matches CONTRACT-001.
- [x] Cookie attributes match CONTRACT-001 exactly (Domain, HttpOnly,
      `COOKIE_SECURE`-driven Secure, no `NODE_ENV`-derived logic).

## Validation requirements

End-to-end manual test against the real Entra tenant registered in
TASK-001.

## Risks and assumptions

Assumes TASK-001's redirect URI/HTTPS findings didn't force a CONTRACT-001
rework.

## Blocker

None.

## Implementation handoff

Task: TASK-007 — Implement OIDC login flow
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
was disconnected this session; Patrick authorized proceeding in his absence)
Date: 2026-09-14

### Changes made

- Added `getSecret(name: string): Promise<string>` to `SecretsStore`
  (`src/secrets.ts`), decrypting with AAD `name` (mirroring `setSecret`'s
  AAD convention). CONTRACT-002 §"Interfaces" already specifies this exact
  function and states CONTRACT-001's flow depends on
  `getSecret('CLIENT_SECRET')`, but TASK-008's implementation only ever
  needed `setSecret` (bootstrap) and signing-key retrieval, so `getSecret`
  did not exist yet. This is a narrow, contract-specified addition
  required to retrieve `CLIENT_SECRET` for the token exchange — not new
  architecture, not a change to JWKS/signing internals.
- Added `src/oidc.ts`, the OIDC protocol engine used by the new routes:
  - `generateOpaqueToken`/`generateCodeVerifier`/`computeCodeChallenge`:
    PKCE/state/nonce generation (32 random bytes, base64url; S256
    challenge).
  - `createHandshakeStore`: in-memory, single-use, 10-minute-TTL `state`
    store per CONTRACT-001 §2 (`consume()` deletes on lookup regardless of
    outcome, so a `state` can be redeemed at most once; lazily prunes
    expired entries).
  - `EntraDiscoveryCache`: lazily fetches and caches Entra's OIDC
    discovery document (CONTRACT-001 §9); on a refresh failure with an
    existing cached copy, logs and falls back to the stale copy rather
    than failing the request. Also hands out a `jose` `createRemoteJWKSet`
    (its own kid-driven fetch/cooldown caching) for the discovery
    document's `jwks_uri`.
  - `exchangeAuthorizationCode`: POSTs the standard `authorization_code`
    grant to Entra's token endpoint; returns only `id_token`. The access
    token and any refresh token in Entra's response are read into a local
    object and discarded — never stored in a variable that outlives the
    function, logged, or returned (CONTRACT-001 §3's "used only
    transiently" requirement).
  - `validateIdToken`: `jose.jwtVerify` against the remote JWKS with
    `issuer`/`audience` checks, plus a manual `iat`-presence check and an
    exact `nonce` match against the handshake entry. A `nonce` mismatch is
    logged as a distinct `nonce_mismatch:` event (CONTRACT-001 §3's
    closing paragraph) before being folded into the same generic 400
    response as any other validation failure. Extracts and type-checks
    `oid`/`email`/`preferred_username`, throwing a distinct
    `IdentityClaimMissingError` if any is absent.
  - Typed error classes (`EntraUnreachableError`, `TokenExchangeError`,
    `IdTokenValidationError`, `IdentityClaimMissingError`) that `index.ts`
    maps to CONTRACT-001's fixed status tiers (502/400/400/500).
- Extended `src/index.ts`:
  - `createRequestHandler` now takes `(secretsStore, config)` (previously
    `(secretsStore)` only); `config` is needed for `tenantId`, `clientId`,
    `issuer`, `cookieSecure`. `start()` updated to pass it.
  - `GET /auth/login`: fetches/uses the cached Entra discovery document,
    generates `state`/`nonce`/PKCE, stores the handshake entry, and
    redirects (302) to Entra's real `authorization_endpoint` with
    `client_id`, `response_type=code`, `redirect_uri`,
    `scope=openid profile email`, `state`, `nonce`, `code_challenge`,
    `code_challenge_method=S256` — the exact minimum set CONTRACT-001 §1
    requires.
  - `GET /auth/callback`: implements CONTRACT-001 §3's ordered steps
    exactly — Entra `error` param short-circuits before any state lookup;
    state lookup/consumption; code presence check; discovery fetch;
    `CLIENT_SECRET` retrieval; code exchange; ID token validation; claim
    extraction; token minting via the existing `mintSessionToken`
    (`src/tokens.ts`, unchanged) using the same `now` `Date` instance for
    both minting and the cookie's `iat`/`exp` (via the already-exported
    `nextLocalMidnightEpochSeconds`) so cookie and token timings are
    identical by construction, not by two independent clock reads; sets
    the `bt_session` cookie; responds with a minimal, non-token-exposing
    success page.
  - Every failure path renders plain HTML (never a stack trace) at the
    fixed status CONTRACT-001's Failure behavior table specifies, with the
    literal message text from that table's "User-facing message theme"
    column.
- Updated `docs/DEVELOPMENT.md` describing the two new endpoints, the
  discovery/JWKS caching behavior, and the failure-tier summary.
- No changes to `src/tokens.ts`, `src/config.ts`, `src/database.ts`,
  JWKS/signing internals, or any refresh/logout/authorization-gating
  behavior — all explicitly out of TASK-007's scope and left untouched.

### Validation performed

- `npm run build`: TypeScript compiled cleanly with no errors (also
  re-verified after every subsequent code change).
- Unit-level exercise of `src/oidc.ts`'s handshake store, run directly
  against the compiled output:
  ```
  $ node -e "... createHandshakeStore ..."
  token1 43
  verifier 43
  challenge 43
  consume once { nonce: 'n1', codeVerifier: 'cv1', createdAt: 1789420778471 }
  consume twice (should be undefined - single use) undefined
  consume after ttl expiry (should be undefined) undefined
  ```
  Confirms opaque-token length, single-use deletion, and TTL expiry.
- A from-scratch mock Entra server (`mock-entra.js`, RSA-signed ID tokens,
  its own discovery/JWKS/token endpoints, test-only code registration) plus
  a driver (`validate.js`) that monkey-patches only the hardcoded
  `https://login.microsoftonline.com/<tenant>/` discovery URL to redirect
  to the mock server (every other endpoint URL comes from the mocked
  discovery document itself, unmodified) and calls the actual exported
  `createRequestHandler(secretsStore, config)` — the real production
  request listener, invoked directly per the TASK-008/012 pattern since
  this sandbox's live-socket permission is unreliable — against a freshly
  seeded PGlite database. 44 checks, all passing:
  ```
  $ NODE_PATH=.../node_modules node validate.js <dist> <data-dir> <key>
  Mock Entra listening on 127.0.0.1:40575, tenant path /task007-tenant
  PASS: login redirect targets mock authorize endpoint
  PASS: response_type=code
  PASS: client_id matches config
  PASS: redirect_uri = issuer + /auth/callback
  PASS: scope includes openid profile email
  PASS: code_challenge_method=S256
  PASS: state present and opaque
  PASS: nonce present and opaque
  PASS: state != nonce
  PASS: unknown state -> 400
  PASS: unknown state -> expired message
  PASS: missing state -> 400
  PASS: error param -> 400
  PASS: error param -> cancelled message (distinct from expiry)
  PASS: successful callback -> 200
  PASS: successful callback does not expose token in body
  PASS: Set-Cookie present
  PASS: Set-Cookie attributes exact shape (COOKIE_SECURE=false -> no Secure)
  PASS: token has exactly sub,email,upn,iat,exp,iss
  PASS: sub == mock oid
  PASS: email == mock email
  PASS: upn == mock preferred_username
  PASS: iss == config.issuer
  PASS: exp > iat
  PASS: iat is close to call time
  PASS: Max-Age == exp - iat
  PASS: Expires matches token exp
  PASS: replayed state -> 400 (single-use)
  PASS: nonce mismatch -> 400
  PASS: nonce mismatch -> generic message (no detail leaked)
  PASS: nonce mismatch logged as distinct event
  PASS: PKCE verifier mismatch -> 400
  PASS: unregistered code (Entra invalid_grant) -> 400
  PASS: protocol failure message distinct wording
  PASS: missing email claim -> 500
  PASS: missing claim -> generic logged message
  PASS: Entra 5xx at token exchange -> 502
  PASS: 502 message matches contract wording
  PASS: discovery unreachable at /auth/login -> 502
  PASS: discovery unreachable -> no stack trace / raw error in body
  PASS: COOKIE_SECURE=true -> Set-Cookie includes Secure
  PASS: COOKIE_SECURE=false run had no Secure attribute
  PASS: CLIENT_SECRET not in any response body
  PASS: CLIENT_SECRET not in any captured log line
  PASS: no raw stack trace in any response body

  ALL CHECKS PASSED
  ```
  This covers: login-redirect shape/params; missing/unknown/reused
  `state`; Entra `error=` short-circuit before state lookup; a full
  successful mint with exact six-claim shape and exact cookie-attribute
  string (`bt_session=<jwt>; Domain=.biztechro.com; Path=/;
  Expires=<matches exp>; Max-Age=<exp-iat>; HttpOnly; SameSite=Lax`, with
  `; Secure` appended only when `COOKIE_SECURE=true`); `nonce` mismatch
  (rejected, distinctly logged, generic message); a tampered PKCE
  `code_verifier` (rejected by the mock's own SHA-256 challenge check,
  mirroring what Entra itself would do); Entra 4xx (`invalid_grant`) and
  5xx (unreachable, 502) at token exchange; a missing identity claim
  (500); discovery-endpoint unreachable at `/auth/login` (502, no stack
  trace); and an absence of `CLIENT_SECRET` or stack traces in every
  captured response body and log line across all thirteen scenarios.
- This sandbox session, unlike the one TASK-008/012's implementer used,
  did **not** hit the documented `listen EPERM` restriction — real socket
  binding worked. This allowed additional, stronger live-socket validation
  beyond the mock:
  - Fetched the **real** production discovery document directly via
    `EntraDiscoveryCache` (`src/oidc.ts`, compiled) for the actual tenant
    ID from CONTRACT-001 (`0adaaaf4-1740-44d0-94ef-620d1fb75045`):
    ```
    $ node -e "... cache.getDiscoveryDocument('0adaaaf4-...') ..."
    matches CONTRACT-001 authorize URL: true
    matches CONTRACT-001 token URL: true
    real Entra JWKS key count: 5
    first key kty/use/alg: RSA sig undefined
    ```
    (confirms the discovery fetch/parse logic works against Entra's real,
    live tenant metadata, not just a mock).
  - Started the real compiled service (`dist/index.js`) on a real
    listening socket, seeded with the real `TENANT_ID`/`CLIENT_ID` from
    CONTRACT-001 and a throwaway (non-production) `CLIENT_SECRET`/signing
    key, and issued a real `curl` request:
    ```
    $ curl -sS -i --max-redirs 0 "http://127.0.0.1:41999/auth/login"
    HTTP/1.1 302 Found
    Location: https://login.microsoftonline.com/0adaaaf4-1740-44d0-94ef-620d1fb75045/oauth2/v2.0/authorize?client_id=edcb141d-df64-46ec-8ec2-e92e05359e41&response_type=code&redirect_uri=https%3A%2F%2Forca.biztechro.com%2Fauth%2Fcallback&scope=openid+profile+email&state=UR3Qw5Z5Wh4iOht6mYk7yaiU7RyrpZH1wzjOEwCfXj4&nonce=_V1F3-6uoM-fxjz35FStIkT7xL4IE--77UkpFC0xJb0&code_challenge=3PeK5k4McNAJht7yuSlg09TirGODPEDU6uplumnVZic&code_challenge_method=S256

    $ curl -sS -i "http://127.0.0.1:41999/health"
    HTTP/1.1 200 OK
    {"status":"ok"}

    $ curl -sS -i "http://127.0.0.1:41999/.well-known/jwks.json"
    HTTP/1.1 200 OK
    Cache-Control: no-store
    {"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"c931ec39-...","n":"...","e":"AQAB"}]}
    ```
    This is a real `302` from the real running service to the real,
    exact Entra authorize URL CONTRACT-001 §1 specifies, with the
    registered `redirect_uri` (`https://orca.biztechro.com/auth/callback`)
    and correct PKCE/state/nonce parameters — confirming `/auth/login`
    genuinely works end-to-end against production Entra metadata.
    `/health` and `/.well-known/jwks.json` are unaffected (no regression
    from the `createRequestHandler` signature change). The process was
    stopped with a clean shutdown (SIGTERM handler ran; no stale lock file
    remained).
  - What this does **not** and cannot cover: completing the exchange
    itself requires Entra to actually issue a real authorization `code` to
    a real, interactively-authenticated browser session, which requires
    real end-user credentials and the real `CLIENT_SECRET` — neither
    available to this implementer session. See "Unresolved risks."
- Grepped every `console.error`/`console.log` call added in `src/oidc.ts`
  and `src/index.ts`, and inspected every response-body construction site:
  all error logging goes through `error.message` (or a fixed literal),
  never the raw `clientSecret` variable, the raw Entra token-endpoint
  response body, or the minted JWT. The mock-Entra-harness run's explicit
  `CLIENT_SECRET not in any response body` / `CLIENT_SECRET not in any
  captured log line` checks (above) verify this at runtime, not just by
  inspection.

### Acceptance criteria evidence

- **Full login round-trip against a real Entra tenant: not verified.**
  Everything short of the interactive human-authentication step was
  validated against real Entra (discovery + JWKS fetch, and the full real
  `/auth/login` redirect to Entra's real authorize endpoint with correct
  parameters, both shown above). The remaining piece — a human actually
  authenticating in a browser and Entra issuing a real authorization code
  — cannot be performed by this implementer. See "Unresolved risks."
- **PKCE/state/nonce enforcement: met.** The mock-harness run
  demonstrates: missing `state` → 400; unknown `state` → 400; a `state`
  reused after a successful login → 400 (single-use enforced); a `nonce`
  mismatch between the ID token and the handshake entry → 400, logged as a
  distinct `nonce_mismatch:` event; a tampered PKCE `code_verifier`
  (verified server-side via its own SHA-256 challenge check, exactly as
  Entra would) → 400. No code path omits generating and checking all
  three (see `handleLogin`/`handleCallback` in `src/index.ts`).
- **Entra-unreachable failure path: met.** Demonstrated for both failure
  points CONTRACT-001 names as 502-class: a 5xx from Entra's token
  endpoint during exchange, and total unreachability of the discovery
  endpoint at `/auth/login` (connection refused) — both produced a 502
  with the contract's exact message text and no stack trace.
- **Cookie attributes: met.** The successful-login check asserts the
  literal `Set-Cookie` string against a regex requiring exactly
  `bt_session=<jwt>; Domain=.biztechro.com; Path=/; Expires=<value>;
  Max-Age=<value>; HttpOnly; SameSite=Lax` (no `Secure` when
  `COOKIE_SECURE=false`), and a second handler instance constructed with
  `cookieSecure: "true"` (no other change) produces the same shape with
  `; Secure` appended — confirming `Secure` tracks only `COOKIE_SECURE`,
  with no `NODE_ENV` or build-mode input anywhere in `buildSetCookieHeader`
  or its caller.

### Assumptions and deviations

- **Added `SecretsStore.getSecret`.** CONTRACT-002 already specifies this
  function and CONTRACT-001 already documents the dependency; TASK-008
  simply hadn't implemented it because it didn't need to. Treated as
  filling a contract-specified gap, not inventing architecture. Flagged
  for Patrick's awareness since it touches `src/secrets.ts`, a file
  TASK-008 owns, even though the change is additive-only and doesn't alter
  any existing exported behavior.
- **`redirect_uri` derived as `${config.issuer}/auth/callback` rather than
  a separate hardcoded or env-configured constant.** CONTRACT-001 fixes
  the redirect URI to `https://orca.biztechro.com/auth/callback`, which is
  exactly `config.issuer` (already env-configurable since TASK-012) plus
  the fixed `/auth/callback` path this contract itself assigns. Deriving
  it avoids a second constant that could drift from `SERVICE_ISSUER` and
  requires no new env var. If Patrick wants the callback path itself
  independently configurable later, that's a narrow follow-up.
- **Session cookie `Domain=.biztechro.com` left as a fixed constant in
  `src/index.ts`**, not env-configurable. CONTRACT-001 §7 fixes this value
  and TASK-007's scope doesn't ask for it to be configurable (unlike
  `iss`, which TASK-012 explicitly made configurable after TASK-008). Not
  changed here; flagged in case Patrick wants the same treatment applied
  later.
- **HTTP timeouts** for the discovery fetch, token exchange, and remote
  JWKS fetch are a fixed 10-second constant (`DEFAULT_HTTP_TIMEOUT_MS` in
  `src/oidc.ts`), not env-configurable. CONTRACT-001 doesn't specify a
  value; 10 seconds was chosen as a reasonable bound so a hung connection
  degrades to the "Entra unreachable" 502 path in bounded time rather than
  hanging the request indefinitely.
- **Discovery-document cache TTL** is a fixed 6 hours
  (`DISCOVERY_CACHE_TTL_MS`); CONTRACT-001 §9 explicitly leaves this
  implementation detail unprescribed. A stale cached copy is used on a
  refresh failure rather than failing the request, per §9's explicit
  requirement.
- **A non-5xx, non-2xx response from Entra's discovery endpoint** (e.g. a
  4xx, which would indicate a misconfigured `TENANT_ID` rather than an
  outage) is treated as an unclassified error, surfacing as the 500-class
  generic fallback rather than the 502-class Entra-unreachable response.
  CONTRACT-001's Failure behavior table only names "network/DNS/timeout,
  or 5xx" for the unreachable tier; a 4xx here is closer to a
  configuration problem than an outage, so it did not seem right to also
  fold it into "unreachable." A 5xx or network-level failure at any of the
  three Entra calls (discovery, token exchange, Entra's own JWKS) does map
  to 502, as required.
- **A missing or empty `code` parameter at the callback** (no `error=`
  present either — a malformed callback request) is treated as a
  400-class "sign-in incomplete" response. CONTRACT-001's Failure behavior
  table does not name this exact case explicitly; it was folded into the
  nearest-matching existing 400-class row (protocol-level failure) rather
  than invented as a new category.
- **Mapping of `jose`'s and `fetch`'s specific exception types to
  CONTRACT-001's three failure tiers** (`joseErrors.JWKSTimeout` and
  `TypeError`/`AbortError` from `fetch` → Entra-unreachable; every other
  `jwtVerify` failure → generic ID-token-validation-failed) is a judgment
  call the contract doesn't itemize at the library-exception level; it
  follows the same "unreachable vs. rejected/invalid" split CONTRACT-001
  draws for the token-exchange step.
- **Message text** for each failure tier is copied verbatim from
  CONTRACT-001's Failure behavior table's "User-facing message theme"
  column rather than paraphrased, on the reasoning that the table reads as
  the intended exact copy, not just a theme description.
- **Validation methodology**: the mock-Entra harness is a same-shape stand-in
  for Entra, not Entra itself — it does not attempt to replicate every
  possible Entra error response, only the specific ones CONTRACT-001's
  Failure behavior table enumerates. The one piece of real-Entra
  validation performed (discovery fetch, JWKS fetch, and the real
  `/auth/login` redirect against the actual TASK-001 tenant/client) used
  only Entra's unauthenticated, public metadata endpoints — no real
  `CLIENT_SECRET` or real user credential was used or required for that
  part.
- **Repository note, not a TASK-007 deviation**: partway through this
  session, `git log` showed a commit (`871e05b`, "Draft CONTRACT-003:
  emergency key-rotation authorization") that this implementer did not
  make, evidently from a concurrent contract-architect session against
  the same working tree. It incidentally picked up this task's already-
  `git mv`'d rename (0 content changes to this file) alongside its own
  unrelated `CONTRACT-003` addition. It did not touch, conflict with, or
  overwrite any TASK-007 source file. Noted for Patrick's awareness of
  concurrent-session activity during this milestone, not as a TASK-007
  risk.

### Unresolved risks

- **Full login round-trip against the real Entra tenant is not verified
  by this implementer**, and cannot be, in this sandboxed session: it
  requires a real, interactively-authenticated end-user browser session
  against Entra (to obtain a genuine authorization `code`) and the real,
  production `CLIENT_SECRET` (to complete the exchange), neither of which
  this implementer has or can fabricate. Recorded as an explicit
  unresolved risk for Patrick to close manually, exactly as TASK-012's
  handoff did for its own live-socket gap: attempt a real interactive
  login against `https://orca.biztechro.com/auth/login` with the real
  Entra tenant once the service is deployed with the real `CLIENT_SECRET`
  seeded, and confirm a `bt_session` cookie is set and decodes to the
  expected six claims.
- Beyond that single gap, this session's live-socket access (unlike
  TASK-008/012's session) allowed direct confirmation of `/auth/login`,
  `/health`, and `/.well-known/jwks.json` all working correctly over a
  real socket against real Entra discovery metadata for the real
  TASK-001 tenant/client — this substantially narrows, but does not fully
  close, the round-trip gap above.
- No other unresolved risks identified from implementation and validation
  performed. Independent review and human acceptance remain pending.

### Documentation updated

- `docs/DEVELOPMENT.md`: documented `GET /auth/login` and
  `GET /auth/callback`, the discovery/JWKS caching behavior, where
  `CLIENT_SECRET` is read from, and the failure-tier summary.

## Review

Not reviewed.
