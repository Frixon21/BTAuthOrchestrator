# Review Report

Task: TASK-030
Reviewer: Independent read-only security-review agent, with implementer validation
Date: 2026-10-29
Outcome: Pass for focused code review; visual QA and human acceptance pending

## Contract and acceptance review

Reviewed the implemented recovery diff against the confirmed user scope and repository guidance. Existing approved contract files were not modified. Operator reset tools, signup policy, user identifiers, existing hashes, issuer, JWKS, cookies and offline consumer behavior are preserved. No sibling repository was changed.

## Validation reviewed or performed

The independent reviewer performed static inspection, not test execution. The implementer reran build/typecheck, the extended isolated recovery suite, all six existing regression suites, the synthetic preview smoke test and git diff --check after the fixes. Final results passed. Existing suites intentionally log synthetic database exceptions while testing generic error handling; their exit codes are zero.

Extended tests include upgrade from a pre-recovery schema with an existing mixed-case user/hash, token concurrency, rollback/retry, expired/reused/replaced links, durable invalidation on account transitions, mixed-case matching/ambiguity, valid-format injection email, malformed token injection, untrusted redirect/Host inputs, cooldown after service reconstruction and database reopen, CSRF, request limits, scanner GET, token-log redaction, actual inline scripts and a full loopback HTTP reset/new-password sign-in.

Not run: visual browser QA (previous platform block; not retried), real Resend delivery, live service/database verification, and the operational verify-offline command which would rotate keys against its configured database. No lint command exists. Offline JWT compatibility is instead checked with synthetic keys/data in the recovery suite.

## Findings

### R1 - Medium - Existing mixed-case emails could not recover - Resolved

Signup stores email with original casing, but recovery initially lowercased input and used exact lookup. Recovery now requires a unique case-insensitive account match across all accounts, sends to the stored address and returns the same public confirmation when case-variant accounts are ambiguous. Tests cover existing mixed-case accounts and ambiguity without rewriting users.

### R2 - Medium - Reverting account state could revive old links - Resolved

Initially reset consumption only compared the current email/password/active state. Email A to B to A, or disable to re-enable, could revive a link before expiry. localUsers.updateUser now deletes outstanding recovery rows transactionally on email/password updates or disabling. Tests cover both reversal cases. Existing JWT revocation policy for ordinary password/admin changes remains unchanged.

The independent reviewer inspected both fixes and reported no further concrete security blocker in the reviewed boundaries.

## Regression and security assessment

Tokens contain 32 random bytes and only SHA-256 hashes are stored. GET never consumes or reflects a token; fragments keep issued links out of server GET logs and are cleared from browser history on page load. Consumption rechecks expiry/account state, and deletion/password update/version increment/audit are one transaction. Concurrent use has one successful result. SQL uses parameters and no redirect target is accepted. Base origin validation excludes paths, credentials, query/fragment and non-HTTP(S) protocols. Sender and key stay server-side; provider details are not logged. JSON, Origin and fetch metadata guard browser POST. Request confirmation does not wait for account lookup or provider delivery and remains generic for unknown/disabled/ambiguous/throttled accounts and delivery/database errors.

## Recommendations and remaining limits

- In-memory limits expire, have bounded capacity and reset on restart. The eligible-account cooldown persists while its recovery row exists. Distributed IP abuse still needs perimeter controls; this is not a durable distributed throttle.
- Asynchronous mail is not a durable queue. A restart can lose pending delivery; users can retry after cooldown. Real provider delivery remains untested.
- Console sessions are rejected on subsequent authorization checks after generation changes. Already-authorized in-flight operations are not cancelled.
- Offline consumers accept prior JWTs until next local midnight. Immediate per-user revocation requires an agreed consumer integration.
- Explicit HTTP origins preserve LAN compatibility but cannot prevent network interception. No production security setting was changed.
- Manual preview instructions and the test-only mock-mail capture are in docs/PASSWORD_RECOVERY.md. The preview requires no mail credentials, uses a new temporary DB and synthetic account, binds only 127.0.0.1 and removes disposable data on stop.

## Human decisions required

Visual browser acceptance, eventual authorized mail credential/sender/origin configuration, and any offline-consumer revocation integration remain future steps. This review performed no publication action. The human later authorized committing and pushing only the feature branch to their fork; PR creation, release and deployment remain separate.
