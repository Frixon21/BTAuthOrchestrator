# TASK-008: Key storage and JWKS endpoint

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: CONTRACT-001, CONTRACT-002
Related ADRs: none
Dependencies: TASK-002 (CONTRACT-001 approved), TASK-005 (schema)

## Desired outcome

Session tokens are signed using the current key loaded (decrypted) from
PGlite, and a JWKS endpoint exposes only public keys, kid-aware, supporting
more than one currently-valid key.

## Context

Implements the signing/JWKS side of CONTRACT-001 using CONTRACT-002's
storage layer. This is the foundation both TASK-009 (emergency rotation) and
future routine rotation build on — schema and JWKS response must support
multiple valid keys from day one even though only the emergency path ships
this milestone.

## Scope

### Included

- Loading and decrypting the current signing key from PGlite.
- Minting/signing tokens per CONTRACT-001's claim shape.
- A JWKS endpoint (e.g., `/.well-known/jwks.json`) exposing public keys
  only, tagged by `kid`, including any still-valid prior key.

### Excluded

- The rotation trigger itself (TASK-009).
- The OIDC handshake (TASK-007).

## Plan

1. Implement decrypt-on-load for the current signing key from PGlite.
2. Implement token minting/signing per CONTRACT-001's claim shape and
   RS256.
3. Implement the JWKS endpoint, kid-aware, supporting multiple published
   keys.
4. Verify the private key is never exposed via any endpoint or log.

## Acceptance criteria

- [x] Tokens are signed correctly using the current key from PGlite.
- [x] JWKS endpoint returns only public key material, correctly kid-tagged.
- [x] JWKS endpoint can represent more than one valid key simultaneously.
- [x] No code path logs or exposes the private key.

## Validation requirements

Verify a minted token's `kid` header matches an entry in the JWKS response;
verify private key material never appears in JWKS output or logs.

## Risks and assumptions

None beyond CONTRACT-001/002 being approved.

## Blocker

None.

## Implementation handoff

Task: TASK-008 — Key storage and JWKS endpoint
Implementer: openai-coder
Date: 2026-09-14

### Changes made

- Extended `SecretsStore` with decrypted current-key retrieval and public-only
  publishable-key listing (`current` and `retired`, never `revoked`).
- Added `src/tokens.ts` for jose-backed RS256 session-token minting with the
  exact six-claim shape, explicit injectable time, `kid`, and next-local-
  midnight expiration.
- Added the canonical service issuer to configuration and added `jose` as a
  runtime dependency.
- Added `GET /.well-known/jwks.json`, including exact public RSA JWK fields,
  multi-key support, revoked-key exclusion, and `Cache-Control: no-store`.
- Factored the request listener into an exported function so route behavior can
  be tested without starting the process; `/health` behavior is unchanged.

### Validation performed

- Built and seeded a fresh PGlite database under `/tmp` with a dummy client
  secret and generated current RS256 key.
- Minted and decoded a fixed token: header was exactly `alg=RS256` plus the
  seeded `kid`; payload contained exactly `sub,email,upn,iat,exp,iss` and no
  `aud` or other claim.
- Under `TZ=America/Los_Angeles`, validated local-time cases: 08:00 produced
  57,600 seconds; 23:59:59 produced 1 second; 00:00:01 produced 86,399
  seconds; exactly 00:00:00 produced 86,400 seconds. All had `exp > iat`.
- Exercised the exact HTTP request listener against the seeded store. The
  single-key and current-plus-retired responses returned status 200,
  `Cache-Control: no-store`, and only `alg,e,kid,kty,n,use` per key. A directly
  inserted revoked key was absent.
- Verified the minted JWT with jose `jwtVerify` using the matching JWK from the
  handler's actual JWKS response.
- Exercised `/health`: status 200 and body `{"status":"ok"}`.
- Grepped `src/secrets.ts`, `src/tokens.ts`, and `src/index.ts` for logging,
  private-key/PEM references, and response-body sites. Private material occurs
  only in storage/decryption and the internal jose signing call; response bodies
  contain only health, public JWKS, and fixed error/not-found data. No log site
  references key material.
- Ran `npm run build`; TypeScript completed with no errors. `package.json`
  defines no additional test command.
- Started the compiled service against a fresh throwaway PGlite database on
  `127.0.0.1:41605` and completed the required live socket/curl validation.
  The actual `curl -sS -i` responses were:

  ```text
  HTTP/1.1 200 OK
  Content-Type: application/json
  Cache-Control: no-store
  Date: Mon, 14 Sep 2026 19:26:42 GMT
  Connection: keep-alive
  Keep-Alive: timeout=5
  Transfer-Encoding: chunked

  {"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"64860b20-ae18-4a3f-8600-66f7e632542f","n":"yBeNTeSli9mXd4q8vFpGiy18gA-jnmDjlAx0D6IOqENDMSNGDY_Dqsijl8WAMsSKKOw2U8hu8OKR4QFPpv9qE-rjikwGYhR9bGbJ2xjrGHLeqRHtaxX0VwN3k3xL3atKW5i4cRb3eHIBh504lwEJBnR1zv8aQox51E0MjYcD7gu93DHgE69WEQgFbBbmHxTWSLZqFP2Ou_C12slX6BPs1zVXxktszyrK7EDJOVlPJaBJwJtQxNgCjomd0-ie7Nip-vBYD06Kub0dute1rZbolnrBmpG-wmuFntjGFiI_y9lq0ckxW-rSZnjO2VKISlSxAtgwA5W7DWQ9OcnBDI-tww","e":"AQAB"}]}
  HTTP/1.1 200 OK
  Content-Type: application/json
  Date: Mon, 14 Sep 2026 19:26:42 GMT
  Connection: keep-alive
  Keep-Alive: timeout=5
  Transfer-Encoding: chunked

  {"status":"ok"}
  ```
- Minted a token with fixed claims using the same seeded current key, selected
  the matching JWK from the live curl-fetched response, and verified it with
  jose `jwtVerify`. Verification returned `verified: true`, protected header
  `{"alg":"RS256","kid":"64860b20-ae18-4a3f-8600-66f7e632542f"}`, and payload
  `{"sub":"task008-live-subject","email":"task008-live@example.test","upn":"task008-live@example.test","iat":1789412400,"exp":1789455600,"iss":"https://orca.biztechro.com"}`.

### Acceptance criteria evidence

- Tokens signed correctly: the current key was decrypted from the fresh
  PGlite database, its `kid` appeared in the protected header, the payload had
  exactly the six contractual claims, and jose verified the signature using
  the public JWK returned by the endpoint handler.
- Public-only JWKS: every returned object had exactly
  `alg,e,kid,kty,n,use`; neither PEM nor private/ciphertext fields appeared.
- Multi-key JWKS: after direct insertion of one retired and one revoked row,
  the response contained the current and retired kids and excluded the revoked
  kid.
- No private-key exposure: targeted grep plus inspection of every response and
  logging site found no private-key value routed to a response or log.

### Assumptions and deviations

- The fixed canonical issuer is exposed by `src/config.ts` and included on the
  loaded `Config`; it is not operator-configurable because CONTRACT-001 fixes
  it to `https://orca.biztechro.com`.
- No product behavior or validation deviates from the approved contracts. The
  live service was stopped before reopening the same data directory to mint the
  verification token because the database intentionally enforces a
  single-process lock; verification used the JWK captured from the live curl
  response and the same seeded current key.

### Unresolved risks

- None identified from implementation validation. Independent review and human
  acceptance remain pending.

### Documentation updated

- Updated `docs/DEVELOPMENT.md` with the `jose` dependency and JWKS endpoint.

## Review

Not reviewed.
