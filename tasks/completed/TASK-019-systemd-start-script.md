# TASK-019: Checked systemd startup entrypoint

Owner role: Implementation
Assigned agent: Codex
Proposed by: Patrick
Proposed date: 2026-09-16
Approved by: Patrick (direct request to implement)
Approved date: 2026-09-16
Related contracts: CONTRACT-004, CONTRACT-005
Related ADRs: ADR-001
Dependencies: Existing root install-service.sh

## Desired outcome

An executable root start.sh checks deployment prerequisites and starts the
application under the existing systemd installer.

## Scope

Check runtime, installed dependencies, compiled output, configuration, and
database bootstrap. Reuse existing configuration and database APIs. Preserve
the installer and application behavior. Do not install packages, build, seed,
change permissions, or remove database locks automatically.

## Plan

Add the launcher, document deployment commands, validate with isolated fixtures,
and hand off for review.

## Acceptance criteria

- Executable launcher works from any working directory.
- Missing prerequisites fail nonzero with corrective messages and no secrets.
- Database checks verify decryptable signing key and Entra secret; local mode
  verifies an active local user exists.
- Successful startup uses exec for systemd signal delivery.

## Validation requirements

Bash syntax, TypeScript build, isolated failure and successful startup checks.

## Risks and assumptions

Node must be available on the service PATH. Deployment preparation is manual.
Database preflight uses the existing exclusive lock and closes before exec;
application startup reacquires the lock. Existing migrations may run.

## Blocker

None.

## Implementation handoff

Task: TASK-019
Implementer: Codex
Date: 2026-09-16

### Changes made

Added executable root start.sh and deployment documentation. The existing
installer is unchanged. Checks reuse compiled configuration/storage modules,
release the database lock, then exec the existing application entrypoint.

### Validation performed

Bash syntax, npm run build, and git diff --check passed. Isolated temporary
fixtures verified failures for missing .env, dependencies, build, configuration,
database, signing key, and active local user. A seeded Entra fixture launched
from /tmp served HTTP /health successfully; the launcher PID became Node,
SIGTERM exited zero, and the database lock was removed. The listener test
required sandbox escalation after EPERM. No deployed database was used.

### Acceptance criteria evidence

All criteria above exercised except a real installed systemd unit; the existing
installer's executable entrypoint contract is satisfied.

### Assumptions and deviations

Preparation remains manual. Local mode requires an active user; if all existing
users are disabled, an operator can use the existing npm start entrypoint and
authenticated admin API to re-enable one. No credentials are logged by the
new checks. Preflight runs existing idempotent migrations.

### Unresolved risks

No live systemd installation was performed. Preflight and application startup
acquire the database lock separately; a competing launch fails under existing
locking rules. Build freshness remains the deployment operator's responsibility.

### Documentation updated

docs/DEVELOPMENT.md: setup, checks, systemd PATH, and journal instructions.

## Review

Not reviewed.
