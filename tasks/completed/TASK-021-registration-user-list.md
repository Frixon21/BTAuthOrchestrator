# TASK-021: Show local users on the registration page

Owner role: Implementation
Assigned agent: Codex
Approved by: Patrick (direct implementation request)
Approved date: 2026-09-16
Related contracts: CONTRACT-006

## Desired outcome

The public registration page lists all local usernames and their Active/Disabled
account status, including when creation is disabled. Newly created users appear
immediately. Do not expose emails, credentials, or broaden admin API access.

## Plan and acceptance criteria

Reuse the existing user store; safely render a username/status table with an
empty state and a failure state; update it after successful creation. Validate
both creation modes, mixed account states, and retained admin authorization.

## Risks and assumptions

The user explicitly requested this list on the existing public page; usernames
and active/disabled status will therefore be visible to visitors. Status refers
to the account's enabled flag, not online presence or temporary lockout.

## Implementation handoff

Task: TASK-021
Implementer: Codex
Date: 2026-09-16

### Changes made

The registration page renders a username/status table using listUsers in both
creation modes. Usernames are HTML-escaped. Empty and generic failure states
are provided. Successful registration appends the new user using DOM textContent.
No admin authorization changes or additional public API were needed.

### Validation performed

npm run build, node scripts/test-local-registration.js, and git diff --check
passed. Isolated database tests cover active and disabled rows in both modes,
excluded emails/passwords, empty/error states, escaped usernames, retained admin
authorization, and the inline script's immediate list update via DOM stand-ins.

### Assumptions and deviations

Status means Active/Disabled, matching the store's existing isActive field.
The public page lists usernames per the user's direct request. Other changes
become visible on reload; there is no automatic polling.

### Unresolved risks

No real-browser visual test or deployment/restart was performed. Existing
registration tests were retained and extended. Human acceptance pending.

### Documentation updated

README.md and docs/DEVELOPMENT.md.

## Review

Not reviewed.
