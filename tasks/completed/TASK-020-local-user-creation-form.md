# TASK-020: Local user creation form and server switch

Owner role: Implementation
Assigned agent: Codex
Proposed by: Patrick
Proposed date: 2026-09-16
Approved by: Patrick (direct implementation request)
Approved date: 2026-09-16
Related contracts: CONTRACT-005, CONTRACT-006 (partial supersession)
Related ADRs: ADR-001, ADR-003
Dependencies: TASK-016, TASK-018

## Desired outcome

A minimal form like local sign-in creates local users through POST /admin/users.
The server refuses creation unless ALLOW_NEW_LOCAL_LOGIN_CREATION is true.

## Scope

Include the form, server-side creation gate, configuration, documentation, and
focused validation. Keep hashing, validation, duplicate checks, and auditing in
the existing API. Do not change deployed .env or restart the running service.

## Plan

Patrick confirmed public registration when enabled. Implement the shared
creation gate and minimal form; test disabled/enabled and authorization paths.

## Acceptance criteria

- Only a trimmed, case-insensitive True enables new local user creation.
- Missing, false, empty, or other values refuse saving, including direct API calls.
- Form uses same-origin POST /admin/users and renders API errors as text.
- Existing password hashing and unique username/email checks are reused.
- Other admin operations and local sign-in retain their behavior.

## Validation requirements

Build/type-check; isolated handler and database tests for the gate, authorization,
valid and invalid inputs, duplicate users, and generated form behavior.

## Risks and assumptions

Use the conventional uppercase spelling ALLOW_NEW_LOCAL_LOGIN_CREATION, with
the supplied AllOW_NEW_LOCAL_LOGIN_CREATION spelling as fallback alias.
The new switch applies to HTTP creation; bootstrap seed remains available.
Public registration was explicitly confirmed in conversation.

## Blocker

None.

## Implementation handoff

Task: TASK-020
Implementer: Codex
Date: 2026-09-16

### Changes made

Added GET /auth/local-register with a minimal form submitting to the existing
POST /admin/users handler; linked it from local sign-in. Added an opt-in config
flag and server-side 403 gate, public creation when enabled, JSON Content-Type
enforcement, and fixed public-registration audit attribution. Existing user
validation, hashing, uniqueness checks, and store are reused. Other admin
operations retain bearer authorization.

### Validation performed

`npm run build`, `node scripts/test-local-registration.js`, and
`git diff --check` passed. Tests use an isolated temporary PGlite database and
the real request handler: flag parsing/alias precedence, anonymous and admin
disabled requests without user writes, public success and hashing, bad input,
duplicate username/email, other admin authentication, and mode gating. The
form's actual inline script was exercised in a VM with DOM/fetch stand-ins for
submission, successful reset, and text-only error rendering.

### Acceptance criteria evidence

All task criteria covered by the checks above. Browser layout was not tested
in a real browser; the form follows the existing unstyled HTML approach.

### Assumptions and deviations

Patrick explicitly chose public registration. CONTRACT-006 partially supersedes
the old authorization/self-service rules without editing CONTRACT-005's body.
The original mixed-case environment name remains supported; canonical uppercase
wins if both are set. The switch applies in either login mode and to HTTP
creation even with an admin token; seed remains independent. Registration
does not sign users in. The deployed .env and running service were not changed.

### Unresolved risks

No additional registration throttle or email-verification workflow was added.
The existing start.sh still requires a seeded active local user in local mode;
initial deployment continues to use npm run seed. Human acceptance is pending.

### Documentation updated

README.md, docs/DEVELOPMENT.md, .env.example, CONTRACT-006, and CONTRACT-005's
supersession header.

## Review

Not reviewed.
