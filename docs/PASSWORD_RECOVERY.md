# Email password recovery

Local sign-in links to /auth/forgot-password. An eligible active local account receives a 30-minute reset link. /auth/reset-password renders the reset and confirmation form; success links back to sign-in. No admin token or dashboard is needed. Existing operator reset tools remain for authorized operations. Signup has no email-verification implementation; this change does not change signup policy or add roles.

## Configuration

Set PASSWORD_RESET_PUBLIC_ORIGIN to the exact trusted HTTP(S) origin users open, PASSWORD_RESET_FROM to a verified sender email, and RESEND_API_KEY to a server-only Resend credential. Set all three together; partial or invalid configuration fails startup. With all absent, recovery GET/POST returns an explicit 503 unavailable response for every account; normal startup logs passwordRecovery=disabled. Never put a key in client code, source control, screenshots or sample configuration. No key was obtained or configured during development.

Resend is the delivery adapter; an injectable MailDelivery function allows tests or another provider. The implementation uses Node fetch and a 10-second timeout. It does not retry ambiguous provider outcomes automatically. A failed delivery deletes only that attempt's token; request again after the one-minute cooldown. Generic responses also cover delivery or database failures. Request delivery runs asynchronously in this single process. Graceful shutdown waits for pending delivery/cleanup before closing the database; a process crash can still lose pending mail. Users can request again after cooldown; a durable mail queue is not included.

Origin must have no path, credentials, query or fragment. Links never use Host or forwarding headers. HTTP LAN origins are explicitly supported without changing production cookie security settings; use HTTPS when available because plaintext HTTP permits network interception. Reverse proxies/access logs must not record request bodies. Tokens are URL fragments, stripped from browser history on load, and never sent on GET. Do not rewrite fragments to query parameters or add third-party assets to reset pages.

## Security and compatibility

32 random bytes, base64url encoded, are stored only as SHA-256 hashes. The email contains the raw token. Only reset POST consumes it. Password hashing uses the existing scrypt parameters and a fresh salt; the 12-character minimum is unchanged, with a 1024-character reset input limit. Email/password updates and disable operations delete outstanding links transactionally, so reverting an email or re-enabling an account cannot revive an earlier link. Hash snapshot and email checks also guard consumption. Disabled or deleted accounts cannot reset. Reset clears lockout but does not activate users or create privileges. Consumption, password update, session version increment and audit are transactional. Concurrent use can succeed only once; rollback on database failure preserves the token for retry.

Requests use generic confirmation, five requests per IP per 15 minutes and one per email per minute, regardless of account existence. Database cooldown also survives restart for eligible accounts. Reset attempts are limited to ten per IP per 15 minutes. In-memory buckets expire, have a 10,000-key capacity, and reset on restart; retain perimeter rate limiting for distributed deployments. JSON, trusted Origin and fetch metadata checks prevent cross-site browser submissions. Non-browser API clients may omit Origin. No CORS access is granted.

A recovery_version column defaults to zero for existing users. Local JWTs include an optional btv generation claim; BTAuth checks it before console session authorization. Existing tokens without btv remain valid at version zero, and are rejected here after email recovery. Local login uses the version read with the password hash, so a reset racing with password verification cannot mint an authorized console session from an old password. Existing hashes, IDs, issuer, JWKS, cookie behavior and identity claims remain compatible. Current-password changes and operator resets retain their prior behavior.

**Offline consumer limitation:** ExpenseReport and BTAuthAPI consumers verifying only signature/issuer/expiry cannot see the generation change. Their existing JWTs remain valid until next local midnight (the existing lifetime). No refresh-token store exists. Immediate per-user revocation outside BTAuth requires an agreed online validation/revocation integration in each consumer; this change does not silently change that contract or rotate organization-wide keys.

## Migration and rollback

On normal startup the idempotent schema migration adds local_users.recovery_version and password_recovery, without rewriting existing hashes. Back up the deployment database before any future rollout; development tests use temporary synthetic databases only. No live migration was performed.

For rollback stop the service and restore the previous application. The added column/table may safely remain. Invalidate outstanding links by deleting password_recovery rows during an explicitly approved maintenance operation. Do not decrement recovery_version: doing so could revive revoked BTAuth console sessions. Old application versions do not enforce recovery_version, so rolling back also removes console revocation enforcement. Dropping recovery data is optional and destructive; retain audit records. Password changes already completed remain valid with the previous application.

## Validation

Run npm ci, npm run build, node scripts/test-password-recovery.js and the existing scripts/test-*.js suites. These do not load .env or contact Resend. Do not run npm run seed or verify-offline against a live directory: verify-offline triggers key rotation. Browser QA is separately required when a supported browser is available.

## Normal application integration (no test launcher)

The delivered application uses npm start -> node --env-file=.env dist/index.js. start() loads the normal environment, opens the configured persistent PGlite directory, applies additive schema migrations, constructs the existing users/secrets stores and the Resend recovery service, then routes the login link and both recovery pages through the ordinary request handler. No preview process is involved. The production adapter has no Alex/preview restriction: it sends to the unique existing account's stored email. Unknown addresses do not create users or receive mail. Test-only recipient restrictions live under scripts/.

For an existing configured, seeded BTAuth installation, keep the existing PORT, PGLITE_DATA_DIR, DB_ENCRYPTION_KEY, issuer, tokens, users and registration policy. Add the following settings to that SAME server-side .env file, entering the dedicated key locally in your editor:

```dotenv
PASSWORD_RESET_PUBLIC_ORIGIN=http://localhost:3210
PASSWORD_RESET_FROM=Notifications@trustbiztech.com
RESEND_API_KEY=<enter the dedicated key locally>
```

The localhost origin above is only for a normal same-PC local instance whose PORT is 3210. Set LISTEN_HOST=127.0.0.1 for that local instance. Use its actual port if different. For a later LAN rollout, set the exact user-reachable auth origin rather than localhost; do not change SERVICE_ISSUER or cookie settings just to enable recovery. HTTP rollout remains an acknowledged token-interception risk, not a production-security approval. HTTPS is deferred by the user; no live configuration was changed here.

Run the ordinary application:

```powershell
Set-Location 'F:\Projects\BT-Auth'
npm ci
npm run build
npm start
```

Open /auth/local-login on that instance, use Forgot password, and enter an email already belonging to its local account. Open the emailed link and set the new password. Sign-in still uses the existing username. Neither the test launcher nor an interactive Resend-key prompt is needed. Normal npm start reads the same .env as the other tokens. Shell environment values also reach loadConfig; do not accidentally override .env with old shell settings. No production mail base URL is derived from Host headers.

For a fresh local installation, follow the repository's normal first-install setup/seed procedure before npm start: copy .env.example only if no .env exists, replace required placeholders, choose a NEW local data directory and key, then npm run seed. Do not point it at the live database or replace the encryption key of existing data. Seed remains the repository's existing account/key bootstrap, not the preview fixture. Existing initialized installations do not need re-seeding for recovery. The isolated startup regression below supplies a pre-existing synthetic user/key/database without changing any normal application path.

Configuration behavior: all three recovery values empty means explicit 503 unavailable without account lookup or mail. Any partially filled or invalid set fails startup. Valid configuration enables actual Resend delivery. Provider/DB failures after a valid request retain generic public confirmation to prevent enumeration; server logs use generic errors without tokens/keys/provider response bodies. Normal startup reports enabled/disabled without printing secret values.

### Existing start.sh / systemd deployment

The repository's root start.sh is the existing non-interactive Linux/systemd launcher. It resolves its own directory into APP_DIR and cd's there, regardless of the invoking shell's cwd. It checks Node >=20.6, a readable APP_DIR/.env, installed node_modules and dist/index.js. It then runs node --env-file=.env scripts/startup-check.js followed by exec node --env-file=.env dist/index.js. There is no hardcoded recovery-variable whitelist: RESEND_API_KEY, PASSWORD_RESET_FROM and PASSWORD_RESET_PUBLIC_ORIGIN in that same .env reach both processes through Node's environment-file loader. It does not source .env as shell code.

Keep the deployment's existing .env/database/encryption key. Add the three recovery settings there; the key stays alongside its other server-side tokens. The public origin must be the exact auth URL users open, including the actual port. localhost is appropriate only when the user opens the email on the same host running the service; it is not the LAN deployment URL. Do not change issuer, registration or cookie settings just to enable recovery.

For an already initialized checkout, prepare and run as its intended service user:

```sh
cd /path/to/BTAuthOrchestrator
npm ci
npm run build
./start.sh
```

The path is a placeholder for the actual checkout. For an existing systemd installation, rebuild there as its service user, then restart the already-installed unit using its actual unit name during the authorized rollout. No installer or re-seed is needed for this feature, and none was executed during development. start.sh does not install dependencies, build, seed, change permissions or repair locks. Its startup-check validates configuration, data directory permissions/lock, signing-key decryption and at least one active local account in local mode before starting the HTTP service. Missing/partial recovery settings use the same disabled/fail-startup behavior described above.

PGLITE_DATA_DIR remains the persistent path already configured in .env. An absolute path stays absolute; a relative path resolves against APP_DIR because start.sh cd's there. The installed systemd unit also sets WorkingDirectory=APP_DIR and ExecStart to the script. It does not use EnvironmentFile: Node loads .env directly. Systemd and shell environment settings are inherited; Node gives existing environment variables precedence over --env-file values, so any stale service-manager override should be corrected by the operator rather than changing the database/issuer to work around it. Systemd does not load an interactive shell's Node version-manager setup; Node must already be on the service user's service PATH. exec preserves direct signal delivery, including the new recovery delivery drain on graceful shutdown.

Validation: node scripts/test-normal-recovery-startup.js --bash=/usr/bin/bash can exercise this exact launcher in the disposable mocked fixture on Linux. Development ran it with installed Git Bash on Windows (LF-normalized disposable shell copy, Windows Node), from a different starting cwd. Bash syntax, pre-start checks, same-.env settings, existing-user migration, adapter/HTTP reset, pending-delivery drain, password/token restart persistence and missing/partial config checks passed. This is an actual Bash launcher test, not native Linux/systemd acceptance. Native Linux service/runtime validation was not available in this Windows session; WSL inventory returned access denied and was not retried. No live service, real .env value, key or email was used.

### Delivery and rate-limit deployment assessment

This application currently enforces one process per PGlite directory. The bounded in-memory IP limits follow the existing login throttle's single-process model; email cooldown/token state persists in PGlite across clean restarts. Graceful shutdown now drains pending provider work (provider timeout: 10 seconds) before DB close. It has no durable mail queue: a crash can lose an accepted delivery, and users must request again after cooldown. This is an explicit retry-based design for a small single-instance internal deployment, not guaranteed delivery or a multi-replica/distributed rate limiter. An external shared throttle/durable queue would be additional deployment work if those guarantees are required. Do not run independent replicas against copied databases to scale this feature.

### Container audit

This checkout has no Dockerfile, Docker Compose file or container entrypoint. TASK-025-docker-image-and-compose.md remains a separate pending task with TrueNAS/bootstrap/tunnel requirements; this recovery change does not claim those are implemented or tested. A new .dockerignore excludes .env/.env.* and data from future build contexts, with the secret-free .env.example exception.

When that container task is implemented, the same three settings must reach the app at runtime through its environment. Compose's automatic .env interpolation alone DOES NOT inject all variables into a container: the app service must use env_file: [.env] or explicitly map the recovery variables under environment. The runtime must preserve its configured mounted data directory and original encryption key. The planned container entrypoint runs node dist/index.js with injected environment (no baked .env); the adapter/migrations are the same code. Never COPY .env into an image. No image/build/deployment validation is claimed here.

### Normal-startup proof

Run npm run build, then node scripts/test-normal-recovery-startup.js. This copies the actual application package/compiled code into a disposable location and executes its unchanged npm start command using an isolated synthetic .env and persistent pre-recovery user database. Only outbound fetch is substituted by a test preload; actual routes, migrations, adapter construction and normal start()/shutdown code run. It proves existing account/hash preservation, mail to a stored address other than Alex/preview, graceful mail drain, a reset token/password surviving restart, explicit unavailable behavior and partial-config startup rejection. The mock transport refuses other external requests; no real key or email is used. Temporary data is removed on completion.


## Isolated manual preview

In PowerShell:

```powershell
Set-Location 'F:\Projects\BT-Auth'
npm run build
node scripts/preview-password-recovery.js
```

Open http://127.0.0.1:43210/auth/local-login manually, choose Forgot password, and request for preview@example.test. This disposable account's username is preview and initial password is Preview-password-1234. The script prints the exact temporary mock-mail.json path. Read that test capture to copy the reset link into your browser; for example:

```powershell
(Get-Content -Raw -LiteralPath '<printed mock-mail.json path>' | ConvertFrom-Json | Select-Object -Last 1).link
```

Complete the reset, return to sign-in, and use your new synthetic password. Test mismatch, short-password validation, and reuse/invalid-link errors. Ctrl+C stops the preview and removes its temporary database and mock-mail capture. Restarting creates a fresh fixture. Use --port=43211 if the default loopback port is occupied. The preview never reads .env, opens an existing database, contacts Resend, or binds a LAN address. No mail configuration is required for this preview. Raw links are intentionally available only in its test-only capture. Do not use real account data. The existing .biztechro.com cookie domain is preserved, so a localhost browser cannot retain that session cookie for admin-console testing; basic sign-in still reports the API outcome.

Automated preview check: npm run build followed by node scripts/preview-password-recovery.js --smoke. It uses an ephemeral loopback port and cleans up on completion.

For future real delivery, supply the three server-only variables described above: PASSWORD_RESET_PUBLIC_ORIGIN (exact trusted auth origin), PASSWORD_RESET_FROM (verified sender), RESEND_API_KEY (dedicated authorized credential). Do not reuse another application's key without authorization. None is required or used by the preview.

Recovery email matching supports existing mixed-case stored addresses without rewriting them. If more than one existing account has the same address ignoring case, no link is sent; an authorized operator must resolve the ambiguity. BTAuth revocation takes effect at subsequent authorization checks; already-authorized in-flight operations are not cancelled.

## Explicit real-email test on this PC

This is separate from the default mocked preview. It creates only a disposable local account whose email is alex@trustbiztech.com, uses Notifications@trustbiztech.com as sender, and allows one attempted Resend delivery per run. It never opens the live auth database/service, never reads ExpenseReport credentials, and does not change real accounts. The mailbox receives a token for this temporary local account only.

Run in a normal PowerShell terminal:

```powershell
Set-Location 'F:\Projects\BT-Auth'
npm run build
powershell -NoProfile -File .\scripts\start-real-mail-recovery-test.ps1
```

At the masked prompt, enter the dedicated Resend key locally. Do not put it in chat or paste it as part of a command. The launcher passes it only through the child process environment variable BT_RECOVERY_TEST_RESEND_KEY, removes its own copy immediately after starting the child, and clears the temporary unmanaged buffer. The child removes that environment variable after reading it; the server-only adapter retains the key in memory while running. The key is not written to a file, command argument, mock mailbox or log.

No email is sent at startup. Open http://127.0.0.1:43210/auth/local-login on this same PC, click Forgot password, and enter alex@trustbiztech.com. Submit once. That action transmits the recipient, sender and local test reset URL/token through Resend to Alex's mailbox. It does not send a live-account token. The terminal reports whether Resend accepted the message without logging the key or reset link; acceptance does not guarantee inbox delivery. Check inbox/spam and provider delivery status if needed.

Open the emailed link on this PC while the terminal stays running. The link starts with http://127.0.0.1:43210/auth/reset-password and carries its token in the URL fragment. Set a password for the temporary account, then return to sign-in using username preview and that password. The synthetic initial password is Preview-password-1234. A second submission of the used link fails. The existing production cookie domain is preserved, so loopback sign-in cannot retain the .biztechro.com session cookie for console testing; the sign-in API still reports success/failure.

Ctrl+C stops the local server and removes the temporary database. Restarting creates a different disposable account/database and invalidates the previous test link. If a delivery fails or another delivery attempt is needed, stop and restart the launcher, re-enter the key, and request a fresh link. The helper does not automatically retry delivery. For an occupied port, add -Port 43211 to the launcher command and use the new printed URL. It always binds IPv4 loopback; no LAN listener or arbitrary recipient option exists.

The localhost reset URL works only on the same PC, and only while this test server is running. Do not open it on a phone or forward it. HTTP loopback is deliberately for local testing and does not change production HTTPS/cookie settings. The sender domain and dedicated key must be authorized in Resend; the helper neither creates nor configures credentials. Agent validation uses injected mail only and has not sent a real message.

### Environment loading and ignore rules

Normal application configuration is read by loadConfig(process.env). Plain node commands do not automatically read .env. The existing npm start command explicitly runs node --env-file=.env dist/index.js; this is not the command for the isolated real-email test. Both preview helpers construct fresh synthetic settings and ignore existing PGLITE_DATA_DIR, service/admin configuration and .env files. The real-mail helper reads only its dedicated child-process key variable through its explicit launcher. The mocked preview continues to send no external mail.

.gitignore excludes .env and .env.* variants while keeping the secret-free .env.example trackable. Ignore rules do not protect a file already committed; no .env, .env.local or .env.test file is tracked in this checkout. This test needs no environment file. Do not add the key to .env.example or any tracked file.

Automated checks that send no email:

```powershell
npm run build
node scripts/test-real-mail-recovery-test.js
node scripts/preview-password-recovery.js --smoke
npm run test:recovery
```
