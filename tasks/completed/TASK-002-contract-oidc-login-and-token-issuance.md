# TASK-002: Contract — OIDC login flow & session token issuance

Owner role: Contract Designer
Assigned agent: contract-architect
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: none (this task produces CONTRACT-001)
Related ADRs: none
Dependencies: TASK-001 (for the confirmed hostname/redirect URI); may
reference CONTRACT-002's storage interface once available (TASK-003) but is
not blocked by it.

## Desired outcome

An approved CONTRACT-001 defining the OIDC authorization-code login flow and
BTAuthOrchestrator's session token issuance, precise enough to implement
against without further architectural decisions.

## Context

Architecture direction and design decisions were established across a
Jarvis-led planning session with Patrick and are settled inputs to this
contract, not open questions for the contract designer to relitigate:

- Authorization code flow against Entra ID, with PKCE, `state`, and `nonce`
  required.
- Session token: BTAuthOrchestrator mints its own claim set (`sub`, `email`,
  `upn`, `iat`, `exp`, `iss`) rather than passing Entra's ID token through.
  Authentication only — no roles/groups/authorization claims; each
  consuming app owns its own authorization logic.
- Signing algorithm: RS256.
- Token expiry: local (server) midnight following issuance — not a
  fixed-duration TTL. Worst case is close to 24 hours (a login just after
  midnight); accepted given the small, internally-networked staff and
  physical presence at termination time.
- JWKS must be `kid`-aware and able to publish more than one currently-valid
  key, to support both emergency and future routine key rotation (see
  CONTRACT-002 / TASK-009).
- Session cookie: scoped to the parent domain, `HttpOnly`, explicit
  `COOKIE_SECURE` env flag defaulting to false — never derived from
  `NODE_ENV`.
- The Entra client secret and signing keys are sourced through the
  encrypted storage interface defined by CONTRACT-002 (TASK-003), not from
  `.env` or a flat file.

## Scope

### Included

- Authorization code + PKCE/state/nonce handling.
- Redirect-to-Entra and callback handling.
- Token claim shape and signing.
- Cookie issuance and attributes.
- JWKS response shape (kid-aware, multi-key).
- Failure behavior when Entra is unreachable at login time.
- OIDC handshake state storage (where `state`/`nonce`/PKCE verifier live
  between redirect and callback).

### Excluded

- Refresh flow, logout, authorization/role gating, admin UI, audit logging.
- The key-rotation trigger mechanism itself (see CONTRACT-002/TASK-009).
- The encrypted storage/schema design itself (see CONTRACT-002).

## Plan

1. Read NOTES.md and this task's Context section as settled constraints.
2. Draft CONTRACT-001 per `docs/contracts/TEMPLATE.md` covering purpose,
   scope, actors, inputs/outputs, preconditions, required behavior,
   postconditions/invariants, failure behavior, interfaces, validation
   requirements, and open questions.
3. Explicitly state the failure behavior when Entra is unreachable at login
   (clear error, not a raw 500; consider pointing toward the app's local
   break-glass path).
4. Explicitly state OIDC handshake state storage.
5. Present CONTRACT-001 to Patrick for approval.

## Acceptance criteria

- [x] CONTRACT-001 drafted per template, covering all items in Scope >
      Included.
- [x] Failure behavior for an unreachable Entra tenant is explicit.
- [x] OIDC handshake state storage mechanism is explicit.
- [x] Reviewed and approved by Patrick.

## Validation requirements

Human review and explicit approval before any implementation task
(TASK-007) begins.

## Risks and assumptions

Assumes TASK-001's redirect URI and HTTPS-requirement findings are
available; if Entra rejects a plain-HTTP redirect URI, this contract may
need rework before approval.

## Blocker

None.

## Implementation handoff

CONTRACT-001 drafted per `docs/contracts/TEMPLATE.md`, covering purpose,
scope, actors, inputs/outputs, preconditions, required behavior,
postconditions/invariants, failure behavior, interfaces, UX expectations,
and validation requirements for the OIDC login flow and session token
issuance. All judgment calls left open by this task's Context (`upn`
source claim, `sub` mapping, cookie domain/name/`SameSite`/expiry, deferred
post-login destination, and the break-glass pointer text) are recorded in
CONTRACT-001's "Resolved decisions" section with Patrick's confirmation.
No open questions remain. See `docs/contracts/CONTRACT-001-oidc-login-and-session-token-issuance.md`.

## Review

Not applicable — contract-only task, no separate reviewer role; reviewed
directly by Patrick as part of approval (see Human acceptance).
