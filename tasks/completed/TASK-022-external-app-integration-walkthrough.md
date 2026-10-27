# TASK-022: External app integration walkthrough sample

Owner role: Implementer
Assigned agent: Codex
Proposed by: Patrick Moon
Proposed date: 2026-09-17
Approved by: Patrick
Approved date: 2026-09-17
Related contracts: CONTRACT-001 (OIDC login and session token issuance),
CONTRACT-005 (local login and user management) — this task documents their
externally-visible flow, it does not change either
Related ADRs: none
Dependencies: none (Milestone 1-2 and CONTRACT-005 are already implemented
and can be walked through as-is)

## Desired outcome

A single, self-contained, standalone sample that shows a consuming
("external") internal tool how the login process looks from its own point
of view: what it redirects to, what comes back, and how it verifies a
session token — without needing to read the contracts or the service's
source to understand the shape of the integration.

## Context

BTAuthOrchestrator's README and contracts describe the login flow
precisely, but from the orchestrator's own point of view. A developer
integrating a *new* internal tool has to reconstruct the consuming side of
the flow (redirect to `/auth/login`, receive the callback, verify the
token via `/.well-known/jwks.json`) themselves. Patrick asked (2026-09-17)
for a walkthrough sample aimed at that developer, as either:

- a static `.html` file with SVG diagrams illustrating each step, or
- a small script that walks through each step (e.g. hitting `/health`,
  starting `/auth/login`, following the callback, fetching the JWKS, and
  verifying a token offline).

Either form is acceptable — pick whichever communicates the flow most
clearly with the least maintenance burden. This is a documentation/sample
artifact, not a change to the service itself.

## Scope

### Included

- One sample artifact (either form above) covering the external app's
  side of the OIDC login flow (CONTRACT-001): redirect to `/auth/login`,
  receive `bt_session`, verify against `/.well-known/jwks.json`.
- Brief coverage of the local-login alternative (CONTRACT-005) if it does
  not meaningfully expand the artifact's scope.
- A pointer to the sample from `README.md` (e.g. under "Learn more") so
  future integrators can find it.

### Excluded

- Any change to the orchestrator service's actual endpoints or behavior.
- A production-grade SDK or client library — this is an illustrative
  walkthrough, not a supported integration package.
- Covering `/admin/emergency-rotate-keys` or admin user-management
  endpoints — those are operator-facing, not part of a consuming app's
  integration story.

## Plan

Approved implementation (Patrick, 2026-09-17, "I approve"): one standalone
`docs/samples/external-app-integration.html` with inline SVG and no external
assets. Include:

1. Browser, consuming app, orchestrator, and Entra sequence diagram.
2. Redirect to the orchestrator's /auth/login; Entra returns to the
   orchestrator's /auth/callback, not to the consuming app.
3. Orchestrator issues bt_session and displays its success page. The current
   service has no return-to redirect; the user revisits the consuming app.
4. Consuming server reads the shared-domain HttpOnly cookie, obtains the
   orchestrator JWKS, and verifies RS256, kid, issuer, expiry, and identity
   claims offline. Explain that the token has no audience or authorization
   claims; each app owns its authorization decisions.
5. Brief local-login alternative, plus the fixed .biztechro.com cookie domain
   limitation for localhost testing.
6. Verification snippet and README link; inspect the rendered diagrams and
   compare each step against the current contracts and implementation.

## Acceptance criteria

- [x] A standalone sample artifact exists (single `.html` file with SVG
      diagrams, or a small runnable script) that walks through the OIDC
      login flow from the consuming app's point of view, step by step.
- [x] The sample requires no changes to BTAuthOrchestrator itself to run
      or view against a locally running instance (per `README.md` setup).
- [x] README links to the sample.

## Validation requirements

If a script: run it against a locally running instance (per `README.md`
setup) and confirm it walks through the flow without errors. If an HTML
file: open it and confirm the diagrams and steps accurately reflect
CONTRACT-001 (and CONTRACT-005 if included).

## Risks and assumptions

Assumes a locally running instance is available for a script-based sample
to exercise; an HTML/SVG sample avoids that dependency entirely, which may
make it the lower-risk choice.

## Blocker

None. Patrick approved the HTML/SVG format on 2026-09-17.

## Implementation handoff

Task: TASK-022
Implementer: Codex
Date: 2026-09-17

### Changes made

Added docs/samples/external-app-integration.html, a single offline-viewable
HTML artifact with inline CSS and two accessible SVG diagrams. It explains
browser navigation, the orchestrator-owned callback, shared-cookie delivery,
server-side verification, identity claims, app-owned authorization, the local
login alternative, and integration checks. Includes an illustrative jose 6.x
verification snippet. README links to the sample.

### Validation performed

Opened the local file in headless Chromium and inspected screenshots of the
OIDC and verification diagrams/code. Checked a 390px viewport for page overflow
and inspected its screenshot. Confirmed internal navigation targets and absence
of script, stylesheet, image, or iframe dependencies. Browser execution required
sandbox escalation after Chromium's sandboxed launch failed.

Extracted the exact verification snippet from the HTML and executed it against
the installed jose library with an ephemeral RS256 key and synthetic tokens.
One stubbed startup JWKS fetch occurred; valid-token verification succeeded
with all later network calls disabled. Missing, expired, tampered, wrong-issuer,
unknown-kid, missing-kid, empty-identity, missing-expiry, and invalid-lifetime
inputs were rejected. These temporary checks live under /tmp, not in the sample.

Compared the described routes, cookie attributes, success responses, claim
mapping, and mode gating against CONTRACT-001, CONTRACT-005, src/index.ts,
and src/tokens.ts. git diff --check passed.

### Acceptance criteria evidence

The HTML opens directly through file:// without a running service or build.
Both diagrams render, the verification example is exercised, and README links
to the exact artifact. All implementation criteria above are satisfied.

### Assumptions and deviations

Patrick explicitly approved HTML/SVG on 2026-09-17. The task's context loosely
describes the consuming app receiving a callback; the sample documents actual
behavior instead: the orchestrator receives Entra's callback and displays a
success page, with manual return to the consuming app. It also documents the
fixed cookie-domain limitation on localhost and configurable issuer behavior
already implemented in TASK-012. No endpoints, contracts, or service code changed.

### Unresolved risks

No live Entra sign-in was attempted; this is the approved static walkthrough.
The illustrative startup-only JWKS snapshot is not a production refresh policy;
the sample explicitly explains refresh requirements and stale-key limitations.
Independent review and human acceptance remain pending.

### Documentation updated

README.md and docs/samples/external-app-integration.html.

## Review

Not reviewed.

## Human acceptance

Pending.
