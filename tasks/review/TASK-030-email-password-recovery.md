# TASK-030: Email password recovery

Status: Ready for review. Direct user request and confirmed scope authorize implementation; this records that authorization without claiming human acceptance.

Scope: standard forgot-password email request, reset form and success/back-to-login; preserve operator tools, signup policy, identity compatibility and live systems. No push, PR or deployment.

Acceptance: opaque expiring hashed single-use tokens, atomic consume, generic request response, IP limits/email cooldown, trusted origin, server-only mail config, scanner-safe GET, existing scrypt policy, local session revocation with offline-consumer limitation documented. Mock mail and synthetic database tests cover success, invalid/expired/reused/concurrent requests, delivery/database failures and UI validation. Existing tests/build must pass. Browser QA may remain blocked by the platform browser policy.

## Implementation report

Task: TASK-030
Implementer: Codex
Date: 2026-10-29

### Changes made

Added the public forgot-password link, email-request page, reset/confirmation form, success message and back-to-login path. Added an injectable mail boundary and server-only Resend adapter; no dependency or credential was added. Added idempotent recovery schema, SHA-256 token storage, 30-minute expiry, atomic single-use consume/password update/audit, account-state checks and session generation revocation for this service. Preserved operator reset endpoints, registration policy, hashes, user IDs, JWT identity claims, issuer, JWKS and cookie contract.

### Validation performed

Passed npm run build (TypeScript and asset build), npm run test:recovery, git diff --check and all six pre-existing isolated suites: test-local-password-change.js, test-local-registration.js, test-api-docs.js, test-admin-console.js, test-console-sign-in.js and test-trusted-proxies.js. No lint command is configured. Expected synthetic failure logs in existing regression tests are test coverage, not failed suites.

Recovery coverage includes generic known/unknown responses, disabled/deleted accounts, hashed token storage, cooldown, IP limits, malformed and oversized input, wrong Origin, cross-site request rejection, config validation, valid/invalid/expired/reused/replaced tokens, scanner GET, concurrent consumption, password/email-change invalidation, lockout clearing, transactional database failure and retry, delivery failure cleanup/retry, safe failure logging, local console revocation, login/reset race, offline JWT compatibility, migration reopen/hash preservation, actual form scripts with DOM mocks, Resend fetch stub and complete loopback HTTP recovery with fake mail. No test loads .env, contacts Resend or uses a live database.

### Acceptance criteria evidence

src/passwordRecovery.ts owns mail and transaction behavior; src/recoveryRoutes.ts owns the public pages and guarded JSON endpoints. scripts/test-password-recovery.js drives the compiled handler and actual password hashing against disposable synthetic PGlite. The final build and all test suites pass. Visual browser acceptance remains pending, not represented as completed.

### Assumptions and deviations

Direct human task authorization supersedes the previous exclusions of email recovery/server-side revocation only for this new recovery flow; existing approved contract files were not edited. Resend matches the user-provided provider context, behind an injectable MailDelivery function. Recovery is unconfigured by default and returns explicit unavailable 503 until all server-only variables are present. Five requests/IP/15 minutes, one request/email/minute and ten reset attempts/IP/15 minutes are bounded in-memory limits; the eligible-account token cooldown also persists in the DB. Password reset retains the existing minimum and adds a 1024-character request cap. Email links use fragments to keep tokens out of server/proxy GET logs. Explicit HTTP origins support the existing LAN deployment without changing production security settings.

### Unresolved risks

Visual browser QA could not run: the platform stopped Windows browser control because URL policy enforcement is unsupported. That action remains blocked and was not retried. Form-script and loopback HTTP checks passed; visual/accessibility rendering still needs a supported browser.

Offline JWT consumers, including ExpenseReport/BTAuthAPI if they only verify signature/issuer/expiry, cannot observe immediate per-user revocation. Their prior tokens remain valid until next local midnight. No refresh-token store exists. An online validation/revocation integration requires a separate consumer decision. No organization-wide key rotation or issuer change was made.

Mail delivery is asynchronous and not backed by a durable queue; graceful shutdown drains pending work, but a process crash may lose an email. Users can request again after cooldown. No actual Resend delivery was tested or authorized. Real sender/key configuration and HTTPS rollout remain deployment steps for later approval.

### Documentation updated

README.md, docs/DEVELOPMENT.md, docs/PASSWORD_RECOVERY.md, .env.example and OpenAPI describe setup, behavior, security and migration/rollback. This task is handed off for review, not accepted.

## Repository state

Verified connected GitHub account Frixon21. The user-created public fork https://github.com/Frixon21/BTAuthOrchestrator has parent/source mrdatawolf/BTAuthOrchestrator according to GitHub API metadata. Local origin points to the fork; upstream points to the original. Branch: feature/email-password-recovery. Base: f62524ab2d704bfdfd610bcbcf1ee9aa11eea3d6. The human subsequently authorized a local commit and push of this feature branch to the fork. PR creation, release and deployment remain separate; see branch history for the implementation commit.

## Review

Independent focused security review passed after two resolved findings; see docs/REVIEW-TASK-030.md. Final build, recovery/preview checks and all six regression suites passed. Visual QA and human acceptance remain pending.



## Local real-mail test preparation (2026-10-29)

Added scripts/start-real-mail-recovery-test.ps1 and the explicitly gated scripts/real-mail-recovery-test.js entry point. The default preview remains mock-only. The opt-in helper binds only 127.0.0.1, creates a fresh temporary synthetic account/database, fixes recipient to alex@trustbiztech.com and sender to Notifications@trustbiztech.com, and permits one attempted message per run. It never sends at startup. The user enters their dedicated key through a masked prompt, passed only in the child environment; the agent has not read/configured a key or sent real mail. No real-mail token is logged or saved to the mock capture.

Documented exact commands, environment loading, .gitignore protections and limitations in docs/PASSWORD_RECOVERY.md. Added .env.* ignore with .env.example exception. Mocked real-mode smoke/guard tests and mock preview smoke passed; no real provider validation was attempted. No live, sibling repository, push, PR or deployment action occurred.

## Normal application integration audit

Normal npm start already constructed the production recovery service from the same .env as other tokens, ran additive persistent DB migrations and served the integrated login link/routes. The test launcher was never a production dependency. Fixed two concrete gaps: absent mail configuration now returns explicit unavailable 503 instead of silent confirmation, and graceful shutdown drains pending mail/cleanup before DB close. Added optional validated LISTEN_HOST for ordinary loopback-only local runs while preserving the existing all-interface default. Same-.env sample assignments and safe startup enabled/disabled diagnostic are present.

No Dockerfile/Compose implementation exists in this checkout; TASK-025 remains separate. Added .dockerignore secret/data exclusions and documented required runtime env_file/explicit mapping for that future task, without claiming a container deployment is tested. HTTP TLS deferral remains a rollout risk, not a blocker to local integration and not production security approval.

New test-normal-recovery-startup.js executes the actual npm start command in an isolated copy with persistent synthetic pre-recovery users/keys and mocked outbound fetch. It passes migration/hash/ID preservation, non-Alex recipient delivery, reset token/password across restarts, graceful shutdown delivery drain, missing config 503 and partial configuration failure. No live settings/keys/data or real mail were used. Documentation includes minimal normal startup/config instructions; test helpers remain optional.


Final integration validation: build/typecheck, test-normal-recovery-startup.js, test-password-recovery.js, test-real-mail-recovery-test.js (injected mock), mock preview smoke, all six pre-existing regression suites and git diff --check passed. Visual browser QA remains blocked/not retried; real credentials/delivery, Docker build/Compose rollout and live systems were not used. No lint command is configured. The normal startup proof uses the unchanged package start command with a disposable .env, not a preview app entrypoint.

## Existing start.sh deployment verification

Found root start.sh and install-service.sh. No functional launcher change was needed: start.sh cd's to its own directory, validates prerequisites, loads that directory's same .env through Node for startup-check.js and dist/index.js, and execs the application. Relative data paths resolve there; existing inherited variables take precedence. The systemd installer sets WorkingDirectory and ExecStart, not EnvironmentFile. It does not build/seed automatically.

Extended test-normal-recovery-startup.js with optional --bash= launcher execution. Git Bash on Windows passed Bash syntax and actual isolated pre-check/app startup/recovery/restart/config tests with synthetic persistent data and mocked transport. Native Linux/systemd runtime was not tested; WSL inventory access was denied and not retried. No live service/config/key/mail was accessed. Exact operator startup guidance is in docs/PASSWORD_RECOVERY.md.
