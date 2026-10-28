# Development Guide

## Technology stack

- Node.js with TypeScript.
- Node.js's built-in HTTP server and environment-file support.
- PGlite (`@electric-sql/pglite`) for the embedded PostgreSQL-compatible data
  store.
- `jose` for RS256 JWT signing and public-key/JWK conversion.

## Repository layout

- `src/`: service source code, including bootstrap configuration and the HTTP
  entry point. `src/password.ts` holds scrypt password hashing/verification
  and `src/localUsers.ts`/`src/ipThrottle.ts` hold the local-login user store
  and per-source-IP throttle (CONTRACT-005).
- `src/console/`: static browser admin console files (CONTRACT-010), served by
  `src/adminConsole.ts`. `npm run build` copies them to `dist/console/` with
  `scripts/copy-console-assets.js`, because `tsc` copies only TypeScript output.
- `scripts/seed.js`: stable bootstrap entry point that loads the compiled seed
  implementation from `dist/seed.js`.
- `dist/`: compiled JavaScript output created by the build (not committed).
- `docs/`: project documentation, contracts, decisions, and workflow guidance.
- `tasks/`: lifecycle-managed task records.

## Setup and commands

Copy `.env.example` to `.env` and replace its example values as appropriate.
`PORT`, `PGLITE_DATA_DIR`, `DB_ENCRYPTION_KEY`, `COOKIE_SECURE`,
`SERVICE_ISSUER`, `EMERGENCY_ROTATION_TOKEN`, `LOCAL_LOGIN`, and
`LOCAL_USER_ADMIN_TOKEN` are always required and must be non-empty; `PORT`
must be an integer from 1 through 65535. `TENANT_ID` and `CLIENT_ID` are
required only when `LOCAL_LOGIN=false` (see "Local username/password login"
below); four further brute-force-protection variables are optional with
sane defaults (same section).

`SERVICE_ISSUER` sets the session-token `iss` claim. Production must use
`https://orca.biztechro.com`; non-production deployments may use their own
canonical issuer value.

`EMERGENCY_ROTATION_TOKEN` is the dedicated bearer credential for
`POST /admin/emergency-rotate-keys` (CONTRACT-003). It must be at least 32
characters and is unrelated to any Entra identity, `bt_session` cookie, or
`CLIENT_SECRET`; generate it with, e.g., `openssl rand -hex 32`. The service
fails closed at startup if it is missing or shorter than 32 characters, the
same posture as `DB_ENCRYPTION_KEY`.

`LOCAL_USER_ADMIN_TOKEN` is the dedicated bearer credential for the local-user
admin API (`/admin/users*`, CONTRACT-005 §4, TASK-016). Same format/length
rule as `EMERGENCY_ROTATION_TOKEN` (at least 32 characters, fails closed at
startup otherwise) and deliberately a separate value from it on
least-privilege grounds.

```sh
npm install
npm run dev
npm run build
npm run seed
npm start
npm run verify-offline
```

`npm run dev` builds/type-checks and starts the service. `npm run build` compiles
and type-checks it into `dist/` and copies the admin console files to
`dist/console/` (run `npm run build`, not bare `tsc`, or the console returns 500), and `npm start` runs the compiled service.
The health check is available at `GET /health`. Public signing keys are
available at `GET /.well-known/jwks.json`; this response includes current and
retired keys, excludes revoked keys, and uses `Cache-Control: no-store`.

The OIDC login flow (CONTRACT-001) is implemented at `GET /auth/login`
(redirects to Entra with a freshly generated, single-use `state`/`nonce`/PKCE
`code_verifier`, held in an in-memory, 10-minute-TTL handshake store) and
`GET /auth/callback` (Entra's registered redirect URI; exchanges the
authorization code, validates the ID token against Entra's own cached
discovery document and JWKS, and on success mints and sets the `bt_session`
cookie via `src/tokens.ts`). Entra's discovery document is fetched lazily on
first use and cached in memory (a transient refetch failure falls back to the
last-known-good document rather than failing a login); Entra's JWKS is cached
by `jose`'s own remote-JWKS-set logic. `CLIENT_SECRET` is read via
`SecretsStore.getSecret("CLIENT_SECRET")` at each callback, never from `.env`.
Failure responses follow CONTRACT-001's fixed status-code tiers (502 for an
unreachable Entra, 400 for an invalid/expired handshake or a rejected/invalid
token exchange, 500 for a missing identity claim or other unexpected error)
and are always plain HTML with a generic, non-technical message.

### Local username/password login (CONTRACT-005)

`LOCAL_LOGIN` is a strict, whole-service mode switch (`"true"`/`"false"`,
case-insensitive, no implicit default): exactly one of the two login paths
is ever live. `LOCAL_LOGIN=true` makes `POST /auth/local-login` live and
makes `GET /auth/login`/`GET /auth/callback` fall through to the same
generic `404` used by any unmatched route (no discovery fetch, no handshake
entry, no token exchange executes). `LOCAL_LOGIN=false` is the reverse:
`POST /auth/local-login` is the one that 404s, and Entra's routes behave
exactly as CONTRACT-001 already specifies. `GET /.well-known/jwks.json`,
`POST /admin/emergency-rotate-keys`, and the admin CRUD API (`/admin/users*`,
see below) are all unaffected by this flag in either state. `GET
/auth/local-login` (a minimal HTML login form, CONTRACT-005 §11, TASK-018) is
gated identically to the JSON endpoint: live only when `LOCAL_LOGIN=true`,
otherwise the same generic `404` as any unmatched route.

When `LOCAL_LOGIN=true`, `TENANT_ID`/`CLIENT_ID` are not required and may be
absent from `.env` entirely; when present anyway they are simply unused.
When `LOCAL_LOGIN=false`, `TENANT_ID`/`CLIENT_ID` are required exactly as
before.

`POST /auth/local-login` accepts `{"username": string, "password": string}`
and authenticates against the `local_users` table, populated either by
`scripts/seed.js`'s first-user bootstrap step (below) or by the admin API's
`POST /admin/users` (see "Local user admin API" below). Passwords are hashed
with
Node's built-in `crypto.scrypt` (`N=131072`, `r=8`, `p=1`, 64-byte derived
key, a fresh 16-byte salt per password, `maxmem` explicitly set to 256 MiB
on every call — the default 32 MiB `maxmem` is too small for these
parameters and throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` otherwise).
Verification always performs a same-cost scrypt derivation — against a
fixed dummy salt/password when the username doesn't match any row — before
deciding the outcome, so response timing cannot distinguish an unknown
username from a known username with the wrong password. The response is a
two-tier scheme: unknown username and wrong password both produce an
identical `401 {"error":"Invalid username or password."}`; a disabled
account produces its own `403`; a locked account produces its own `423`
naming the exact unlock time. On success, the response is
`200 {"status":"signed_in","username":"<username>"}` plus a `Set-Cookie`
header — the `bt_session` cookie is minted via the same `mintSessionToken`
(`src/tokens.ts`) and cookie-construction logic CONTRACT-001's callback uses,
not a reimplementation.

`GET /auth/local-login` (CONTRACT-005 §11, TASK-018) serves a minimal,
unstyled, self-contained HTML page (a username/password form) at the same
gating as the JSON endpoint above. The page contains no credential
verification of its own: its inline `<script>` calls `POST
/auth/local-login` via `fetch()` on submit and only renders that response —
on success it replaces the form with a plain "You're signed in." message on
the same page (no redirect); on failure it displays the JSON response's
`error` string verbatim (no reinterpretation), so disabled/locked/merged
unknown-username-or-bad-password messages appear exactly as `POST
/auth/local-login` produced them. No CSS, branding, or responsive design is
included, per CONTRACT-005 §11.

Brute-force protection has two layers, both configurable via optional
`.env` variables (each validated as a positive integer if present; silently
defaulted if absent — the one exception in this project to the
required-with-no-implicit-default posture):
`LOCAL_LOGIN_MAX_FAILED_ATTEMPTS` (default `10`) consecutive wrong-password
attempts locks a `local_users` account for `LOCAL_LOGIN_LOCKOUT_MINUTES`
(default `15`) minutes (`locked_until`); attempts made while already locked
do not extend the lockout, and a correct password after it passes clears
both `failed_login_attempts` and `locked_until`. Separately,
`LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS` (default `20`) failed attempts from
one source IP (across any usernames) within a rolling
`LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES` (default `5`) minute window produce
`429` on further attempts from that IP until the window rolls forward; this
in-memory counter (`src/ipThrottle.ts`) resets on process restart, the same
accepted tradeoff as the OIDC handshake store. Every `/auth/local-login`
attempt (success or failure) writes one row to `local_login_audit`,
best-effort — a malformed request (missing/invalid body) is rejected `400`
before any lookup, hashing, or audit write occurs.

#### Client address and `TRUSTED_PROXIES` (CONTRACT-012, TASK-029)

The "source IP" used by the per-IP throttles and every `source_ip` audit
column comes from `createClientAddressResolver` in `src/clientAddress.ts`:

- With `TRUSTED_PROXIES` unset (the default), it is the connection's own peer
  address. `X-Forwarded-For` and `CF-Connecting-IP` are ignored, so a client
  cannot pick its own address.
- With `TRUSTED_PROXIES` set to comma-separated addresses or CIDR ranges, a
  request whose peer is inside them may supply a single valid
  `CF-Connecting-IP`, which then becomes the client address. A missing,
  repeated or malformed header falls back to the peer address.
  `X-Forwarded-For` is never read.
- IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are reported as plain IPv4.
- An invalid entry stops startup with `TRUSTED_PROXIES (invalid entry "...")`.
  The startup log line shows the trusted ranges (`trustedProxies=none` when
  unset).

Behind the Cloudflare Tunnel, set it to the pinned subnet of the compose
network the app shares with `cloudflared`, and keep that network to those two
containers with no published host port. Otherwise a client could forge
`CF-Connecting-IP` from a trusted address. Validate with
`node scripts/test-trusted-proxies.js`.

#### Local password change and admin reset (CONTRACT-009)

With `LOCAL_LOGIN=true`, open `/auth/local-change-password` (also linked from
sign-in). Its JSON POST accepts `username`, `currentPassword`, and `newPassword`.
The new password must be at least 12 characters and differ from the current
password. Both routes return generic 404 in Entra mode. Verification shares
sign-in's full-cost scrypt and account lockout. The change endpoint has its own
IP counter using `LOCAL_LOGIN_IP_THROTTLE_*`; only unknown/wrong credentials
consume that counter. Throttling precedes body validation. Non-JSON returns
415; invalid fields, short or unchanged passwords return 400 without lookup,
hashing, or auditing. Credential errors match sign-in (401/423/403).

Success returns `{"status":"password_changed","username":"<normalized>"}`,
uses a fresh salt, clears lockout and sets no cookie. JSON responses are
`Cache-Control: no-store`. Each validated, unthrottled attempt writes one
best-effort `local_user_admin_audit` update with `actor_label=self-service`,
`changed_fields=password` on success (null on failure), and no login audit.

Operators can open `/admin/reset-password` directly in either login mode.
This uncached static page is not linked from public pages; it links to the
admin console (`/admin/console`). Enter the dedicated
admin token, username, password/confirmation, and optional acted-by label.
The browser resolves the username through authorized `GET /admin/users`, then
calls the existing `PATCH /admin/users/:id`. The token stays in its input field
and is sent only to those same-origin API calls; it is never persisted.
Admin resets may reuse the same password, clear lockout, and preserve disabled
status. Both forms render API errors as text. Neither flow revokes existing
sessions; emergency key rotation remains the way to invalidate them globally.

Validate with `npm run build`, `node scripts/test-local-password-change.js`,
`node scripts/test-local-registration.js`, `node scripts/test-api-docs.js`, and
`node scripts/test-admin-console.js`.
The password-change tests use temporary PGlite, real handler/password functions,
and VM execution of both inline form scripts; they do not load `.env`.

#### Local user admin API (CONTRACT-005 §4, TASK-016)

Public account creation is now defined by [CONTRACT-006](contracts/CONTRACT-006-public-local-registration.md)
(TASK-020), superseding CONTRACT-005's creation authorization.
Set `ALLOW_NEW_LOCAL_LOGIN_CREATION=True` in `.env` and restart the service to
enable the minimal form at `/auth/local-register` (for example,
`http://localhost:3210/auth/local-register`). The local sign-in page links to it.
The original spelling `AllOW_NEW_LOCAL_LOGIN_CREATION` also works when the
uppercase spelling is absent. Only trimmed, case-insensitive `true` enables
creation; missing or any other value disables it.

The form posts username, email, and password to the same-origin `/admin/users`
as JSON. Without an `Authorization` header this POST is public while enabled,
recorded as `public-registration`. [CONTRACT-011](contracts/CONTRACT-011-console-sign-in-for-local-users.md)
§7 (TASK-028) replaced CONTRACT-006's `403`: while creation is disabled the POST
needs the user-admin token or a console session and otherwise returns `401`,
and the user-admin token creates users in both states, recorded with its
`actedBy`. A wrong token is always `401`, never public. Public creation uses the
existing validation, password hashing, duplicate handling, and audit storage.
Non-JSON creation requests return 415. The switch is independent of LOCAL_LOGIN
and does not affect operator bootstrap via `npm run seed`.

The registration page also publicly lists every local username and its
Active/Disabled status, even when creation is disabled (TASK-021). Status is
the account's enabled flag, not online presence or temporary lockout. The page
loads the list on each visit and appends a newly created account immediately;
reload to see changes made elsewhere. Emails and credential data are excluded.
This page uses the user store directly; GET `/admin/users` remains protected.

`POST /admin/users`, `GET /admin/users`, `GET /admin/users/:id`,
`PATCH /admin/users/:id`, and `DELETE /admin/users/:id` create, list, fetch,
update, and hard-delete `local_users` rows. Every one of these endpoints is
reachable **regardless of `LOCAL_LOGIN`'s value** — this surface is not
gated by that switch, so an operator can provision/curate local user records
whether or not local-login mode is currently active. Except for public creation
(`POST /admin/users`, gated above), each request must carry
`Authorization: Bearer <LOCAL_USER_ADMIN_TOKEN>`, checked with
`crypto.timingSafeEqual` (never `===`), the same constant-time-comparison
helper `POST /admin/emergency-rotate-keys` uses, or be session-authorized as
described under "Console sign-in" below. A missing, malformed, or incorrect
credential always returns a generic `401 {"error":"Unauthorized"}` that never
distinguishes which check failed. All admin responses include
`Cache-Control: no-store`.

`POST /admin/users` accepts `{"username": string, "email": string,
"password": string, "actedBy"?: string}` and returns `201` with the created
user's public fields (`id`, `username`, `email`, `isActive`, `createdAt`,
`updatedAt` — never a password hash or hashing parameter). `username` is
normalized to lowercase and validated as 3-64 characters of lowercase
letters, digits, `.`, `-`, or `_`; `password` must be at least 12 characters
(hashed via the same `src/password.ts` `hashPassword` the local-login path
verifies against); a duplicate `username` or `email` returns `409` naming
which field collided. `GET /admin/users` returns `200 {"users": [...]}` (no
pagination); `GET /admin/users/:id` returns the same shape for one user or
`404 {"error":"No such user."}`. `PATCH /admin/users/:id` updates `email`,
`password`, and/or `isActive` (at least one required); a password change
resets `failed_login_attempts`/`locked_until`. **Username is not renamable
via `PATCH`** — a `username` field in the request body is rejected `400`;
delete and recreate the user instead. An `email` collision returns `409`; an
unknown `id` returns `404`. `DELETE /admin/users/:id` hard-deletes the row
and returns `200 {"status":"deleted","id":string,"username":string}`, or
`404` if the id doesn't exist; existing `local_login_audit`/
`local_user_admin_audit` rows referencing that user are never deleted.
Because the caller already holds `LOCAL_USER_ADMIN_TOKEN`, error messages on
this surface are specific (e.g. naming which field is invalid or which value
conflicted) — unlike the enumeration-resistant, merged responses on the
public `/auth/local-login` surface.

Every `create`/`update`/`delete` action (success or failure) and every
admin-API authentication failure writes exactly one row to
`local_user_admin_audit` (`action`, `target_user_id`, `target_username`,
`changed_fields`, `result`, `failure_reason`, `actor_label`, `source_ip`),
best-effort — a database failure never blocks the caller's response, falling
back to a server-side log-line backstop instead. A successful read (`GET
/admin/users`, `GET /admin/users/:id`) is not itself audited (only an
authentication failure on those endpoints is), since CONTRACT-005 §6 and the
audit table's `action` values (`create`/`update`/`delete`/`auth_failure`)
scope the audit trail to write actions and auth failures, not reads.
`actedBy`, when supplied on `POST`/`PATCH`, is stored verbatim as
`actor_label`/`created_by` — an unverified, operator-self-asserted label,
the same caveat CONTRACT-003 already accepts for `triggeredBy`.

After configuring `.env` and building, bootstrap a fresh database with the
normative command `node scripts/seed.js`. The launcher starts the compiled
implementation with Node's `--env-file=.env` support. It prompts for
`CLIENT_SECRET` without echoing input and generates the initial RS256 signing
key. For non-interactive setup, use
`node scripts/seed.js --client-secret-file=<path>`; the input
file is deleted immediately after it is read and before the database is opened.
Never pass the secret itself on the command line. `npm run seed` is a convenience
alias that builds first and then runs the same entry point.

Alongside `CLIENT_SECRET`/the signing key, `scripts/seed.js` also provisions
the first `local_users` row (CONTRACT-005 §5, TASK-017), extending the same
idempotent "what needs seeding" check with one more piece: on every
invocation it also checks whether any row exists in `local_users`. If one or
more rows already exist, this piece is reported as already seeded
(`local_users already seeded; skipping.`) and no row is added, changed, or
removed. If zero rows exist, it prompts for a username, an email, and a
password using the same class of input handling as `CLIENT_SECRET`: username
and email are prompted visibly (echoed) so an operator can see and correct
typos, and the password prompt is hidden (not echoed), matching
`CLIENT_SECRET`'s own hidden prompt. For non-interactive setup, use
`node scripts/seed.js --local-user-file=<path>`; the file must contain
exactly three lines, in order — username, then email, then password — with an
optional single trailing newline. Exactly like `--client-secret-file`, this
file is read once and deleted immediately afterward (before the database is
even opened), and if the delete fails the whole run aborts with nothing
written to PGlite and an instruction to delete the file manually, rather than
proceeding with a leftover plaintext file on disk. Username/email/password
are validated against the same format rules `POST /admin/users` applies
(username: normalized lowercase, 3-64 characters,
`[a-z0-9._-]`; password: at least 12 characters); an invalid file or
interactive value aborts the run with a clear error naming the problem
without revealing the invalid value itself. The password is hashed via the
same `src/password.ts` `hashPassword` function (and the same scrypt
parameters) the admin API and the local-login path use — not a separate or
simplified routine — and the resulting row is inserted with
`is_active = true`, zeroed lockout state (`failed_login_attempts = 0`,
`locked_until = NULL`), and `created_by = 'seed-script'`. This step runs
regardless of `LOCAL_LOGIN`'s value: pre-staging a local user is harmless in
a deployment currently running Entra-only, since `/auth/local-login` never
consults `local_users` while `LOCAL_LOGIN=false`. As with `CLIENT_SECRET`/the
signing key, the seed script only ever provisions the *first* local user;
creating additional users, or updating/deleting any of them (including the
one the seed script created), goes through the admin API
(`POST`/`PATCH`/`DELETE /admin/users*`) described above.

The emergency key-rotation trigger (CONTRACT-003, "kill switch") is
implemented at `POST /admin/emergency-rotate-keys`. It authenticates via a
`Authorization: Bearer <EMERGENCY_ROTATION_TOKEN>` header only — a valid
`bt_session` cookie never substitutes for this credential, and the token is
compared with `crypto.timingSafeEqual` (never `===`) to avoid a timing side
channel. On success it generates a fresh RS256 key pair in-process,
atomically (one PGlite transaction) revokes the previously current signing
key (`status = 'revoked'`, `revoked_at` set, no `retired` intermediate
state), inserts the new key as `current`, and writes a
`result = 'success'` row to `emergency_rotation_audit`, then responds `200`
with `{"status":"rotated","previousKid","newKid","rotatedAt"}` and
`Cache-Control: no-store`. A missing/malformed/incorrect `Authorization`
header returns a generic `401 {"error":"Unauthorized"}`; a failure during key
generation or rotation returns a generic
`500 {"error":"Unable to complete emergency rotation"}`; any other method or
path falls through to the existing generic `404`. Every trigger attempt
(success or failure) writes one row to `emergency_rotation_audit`
(`id`, `triggered_at`, `result`, `triggered_by`, `source_ip`, `previous_kid`,
`new_kid`, `failure_reason`); if that write itself cannot be performed, the
service emits a server-side log line backstop naming only a timestamp and
failure category, never the credential value or any secret material. The
optional JSON request body `{"triggeredBy"?: string}` is an unverified,
operator-self-asserted label stored verbatim when present and `null`
otherwise — it is never part of the authorization decision and a malformed
value never causes the request to fail. Concurrent trigger requests are not
rejected or deduplicated; each independently rotates, and PGlite's
transactional guarantee (exactly one `current` row) serializes them into
consecutive rotations, which is the intended outcome, not an error.

`node scripts/verify-offline.js` (alias: `npm run verify-offline`, which builds
first) is TASK-010's standalone, re-runnable offline-verification proof
against the real compiled service and a real, already-seeded
`PGLITE_DATA_DIR`. It mints a session token directly via `mintSessionToken`
against the current signing key (no interactive Entra login is needed or
used), fetches `/.well-known/jwks.json` once, and verifies the token
completely offline using `jose`'s `createLocalJWKSet` (a global-`fetch`
instrumentation confirms zero network calls happen during the `jwtVerify`
call itself). It then triggers `POST /admin/emergency-rotate-keys`, re-fetches
JWKS, and confirms the same token now fails offline verification because its
`kid` is absent from the fresh JWKS response. Because CONTRACT-002 enforces a
strict single-process lock on `PGLITE_DATA_DIR`, this script reads the
current signing key directly from the database first (releasing the lock
immediately afterward) and only then launches the real compiled service
(`dist/index.js`) itself as a child process against the same `.env`, so the
whole proof remains a single self-contained command rather than requiring the
operator to separately start the service first. If a separate instance of
the service is already running against the same `PGLITE_DATA_DIR`, this
script fails fast with a clear "already locked" error rather than hanging or
corrupting state; stop the other instance first. If the sandbox/host does not
permit live socket binding, the script automatically falls back to invoking
the exported `createRequestHandler` function directly (no real HTTP socket,
no child process) and says so plainly in its output, matching TASK-008/012's
validation precedent. The script prints one clear PASS/FAIL line per
acceptance criterion and exits non-zero if any fail.

On startup, the service creates `PGLITE_DATA_DIR` with mode `0700` when it is
absent, verifies an existing directory is mode `0700` and owned by the running
user, acquires a single-process lock, opens PGlite, and applies the idempotent
schema migration before listening. Existing directories with different mode or
ownership are rejected with a corrective `chmod` or `chown` message; the service
does not modify their permissions or ownership automatically. A lock left after
an unclean process termination must be removed manually after confirming no
other service process is using the directory.

## Console monitoring

The running service (TASK-023, `src/logging.ts`) prefixes every console line
with an ISO timestamp, a level (`INFO`/`WARN`/`ERROR`), and, while handling a
request, an 8-character request id. Each completed request logs one summary
line, `METHOD /path -> status (duration)`, at `ERROR` for 5xx, `WARN` for 4xx,
and `INFO` otherwise; successful `GET /health` checks are not logged. Query
strings are never logged (`/auth/callback` carries the OAuth `code`/`state`).
To trace a 5xx, find its summary line and read the earlier lines with the same
request id: unexpected-failure paths log a stack trace, and all error log
lines include the error `code` and full `cause` chain (Node's `fetch` reports
only "fetch failed" and puts the DNS/TLS/connection reason in `cause`).

An exception escaping a route handler is logged with its stack and answered
with a generic `500 {"error":"Internal server error"}` instead of leaving
the request hanging. Unhandled promise rejections are logged, and an uncaught
exception is logged before the process exits. Startup logs the Node version,
pid, port, login mode, registration switch, issuer, and data directory (no
secrets). The monitoring wrapper is applied only to the real HTTP server in
`start()`; `createRequestHandler` is unchanged for in-process callers.

## systemd startup

Prepare the checkout with `npm ci`, configure `.env`, run `npm run build`,
and run `npm run seed` as the intended service user. Then install and start:

```sh
sudo ./install-service.sh --start
```

The installer uses executable `start.sh` in the repository root. It works
from any working directory and requires Node >=20.6.0 on the systemd service
PATH (interactive shell/version-manager setup is not loaded). It checks the
runtime, dependencies, compiled modules, configuration, database permissions
and lock, and decryptability of the current signing key. Entra mode also checks
the stored CLIENT_SECRET; local mode requires at least one active local user.
Database checks use the existing migration and locking code, then close the
database before starting the application. It does not install, build, seed,
repair permissions, or delete stale locks. Rebuild after source updates.

The launcher replaces itself with Node so systemd delivers shutdown signals
directly. Failures go to the journal with setup guidance; inspect them using
`journalctl -u btauthorchestrator -e` (substitute the installer-selected service
name if the checkout directory or SERVICE_NAME differs).

## Windows startup

Run `start.bat` (it invokes `start.ps1` with `-ExecutionPolicy Bypass`).

The batch wrapper clears its inherited `PSModulePath` inside `setlocal`, so
Windows PowerShell rebuilds its own default module paths. This prevents a
PowerShell 7 parent session from causing Windows PowerShell to load incompatible
versions of built-in modules such as `Microsoft.PowerShell.Security` (`Get-Acl`).
The parent session's environment is unchanged.

Before starting, it checks Node >=20.6.0, `node_modules`, and `dist/index.js`, then:

- Creates `.env` from `.env.example` if absent.
- Generates a 64-character lowercase hex `DB_ENCRYPTION_KEY` and writes it to
  `.env` (UTF-8, no BOM) when the value is empty or still the
  `.env.example` placeholder. It refuses if `PGLITE_DATA_DIR` already holds
  data, because a new key cannot decrypt existing secrets. Back the key up.
- Generates `EMERGENCY_ROTATION_TOKEN` and `LOCAL_USER_ADMIN_TOKEN` (64 hex
  characters each) when either is empty or still the placeholder. A value
  that is set but too short is left alone and reported by the configuration
  check.
- Locks an existing `PGLITE_DATA_DIR` to the Windows equivalent of `0700`:
  owner-only full control, inheritance removed, children reset to inherit
  it. It refuses (no auto-ownership change) if the directory is owned by
  another account.
- Stops with `npm run seed` instructions when `PGLITE_DATA_DIR` is missing or
  empty, and repeats them when the shared check reports an incomplete
  bootstrap or no active local user.
- Runs the same configuration and database checks as `start.sh`
  (`scripts/startup-check.js`).

Because Windows has no POSIX mode bits or uids, the service's own
`0700`/owner check is skipped on `win32`; `start.ps1` is the enforcement point
there (CONTRACT-007 §5), so start the service through it rather than
`npm start`.

First setup on Windows:

```bat
npm ci
npm run build
start.bat
npm run seed
start.bat
```

The first `start.bat` writes the key and tokens to `.env`, then stops
because the database is not seeded. Check the other `.env` values (Entra IDs,
`SERVICE_ISSUER`, `LOCAL_LOGIN`) before seeding. `npm run seed` prompts for
the Entra `CLIENT_SECRET` and the first local user's username, email, and
password. The second `start.bat` locks down the data directory and starts the
service.

## Console sign-in (CONTRACT-011, TASK-028)

Any active local user can sign in to the admin console and manage users
without a token. The bearer tokens still work and remain the last-resort path.

- **Session authorization.** `GET`/`PATCH`/`DELETE /admin/users*` and
  `POST /admin/users` accept a `bt_session` cookie instead of the user-admin
  token when every rule holds: `ALLOW_NEW_LOCAL_LOGIN_CREATION` is off,
  `LOCAL_LOGIN=true`, exactly one `bt_session` cookie is sent, it verifies
  against this service's current or retired keys (never revoked) with our
  `SERVICE_ISSUER` and an unexpired `exp`, its `sub` is a `local_users` row
  with `is_active = true` at request time (Entra sessions never match), and
  the request carries `X-BT-Admin-Console: 1` plus, when the browser sends
  them, an `Origin` equal to `SERVICE_ISSUER`'s origin and
  `Sec-Fetch-Site: same-origin`. A temporary lockout does not remove session
  admin. A request with any `Authorization` header is judged by the token
  alone. Logic lives in `authorizeAdminRequest` in `src/index.ts`.
- **Failures** return the generic `401` and an `auth_failure` audit row whose
  `failure_reason` is `bad_credential`, `session_registration_open`,
  `session_local_login_off`, `session_invalid`, `session_user_not_active` or
  `session_csrf_rejected`. A key or user lookup failure returns `500`.
- **Emergency rotation** never reads the cookie.
- **`GET /admin/session`** (both modes, no credential) returns
  `{sessionAdmin, reason, signedIn, user}` for the console.
- **`POST /auth/logout`** (both modes) needs the same header and origin checks
  (`403` otherwise) and expires `bt_session` for every `*.biztechro.com` app in
  that browser. It does not revoke the token.
- **Audit.** `local_user_admin_audit` gained `auth_method` (`token`, `session`,
  `public`) and `actor_user_id`, added idempotently at startup; older rows and
  self-service password changes keep `NULL`. Session-authorized writes record
  the user's username as `actor_label` and ignore `actedBy`; users they create
  get `created_by` set to that username.

The `bt_session` cookie is set for `.biztechro.com`, so a browser keeps it only
when the console is opened at a `biztechro.com` host (over HTTPS when
`COOKIE_SECURE=true`). At `localhost` the console explains that the cookie was
not kept and points to the token. To try sign-in locally, map a name such as
`orca.biztechro.com` to `127.0.0.1` in your hosts file and set
`COOKIE_SECURE=false` and `SERVICE_ISSUER` to that address. Validate with
`node scripts/test-console-sign-in.js` and `node scripts/test-admin-console.js`.

## Browser admin console (CONTRACT-010)

Open `/admin/console` (for example, `http://localhost:3210/admin/console`) in
either login mode. The page is a static single-page app served by this service,
with no authentication of its own: every action calls the existing API, which
authorizes and audits it exactly as before. It covers:

- **Overview:** `GET /health`, the login mode (local when `/api/openapi.json`
  contains `/auth/local-login`, otherwise Entra; unknown if the document cannot
  be loaded) and links to `/api/docs`, `/auth/local-register`,
  `/admin/reset-password` and the active mode's sign-in/change-password pages.
- **Users:** list, filter, view, create, change email, enable/disable, reset
  password and delete. Delete requires typing the exact username.
- **Signing keys:** JWKS `kid`/`alg`/`use` with show/copy modulus, and
  emergency rotation, which requires typing `ROTATE`.
- **Settings:** console sign-in and sign-out (CONTRACT-011), the user-admin
  and emergency tokens (entered separately), an optional, unverified acting-as
  label (sent as `actedBy`/`triggeredBy`, and hidden and not sent while signed
  in), Forget all, and the System/Light/Dark theme. The Users area also offers
  sign-in when neither a session nor a token is available.

Tokens are kept in the tab's `sessionStorage` (in memory, with a notice, if
storage is blocked) and never in `localStorage`, cookies or the URL. While
signed in, `/admin/users*` requests send no `Authorization` header and rely on
the cookie; otherwise the user-admin token is sent to them, including
`POST /admin/users` (which needs no credential while public registration is on).
Every `/admin/users*` request carries `X-BT-Admin-Console: 1`. The emergency
token goes only to `POST /admin/emergency-rotate-keys`. A token `401` forgets
only that token; a session `401` returns the console to signed out and keeps
saved tokens. Password fields are cleared after
every request. Only the theme preference is stored in `localStorage`.

The page and its allow-listed assets (`app.js`, `theme.js`, `app.css` under
`/admin/console/`) are served with `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
Any other path under `/admin/console/` returns the generic 404; request paths
are never resolved against the filesystem. The files contain no inline scripts,
styles or event handlers, render all dynamic text with `textContent`, and use no
frameworks, CDN, web fonts or third-party assets. Edit them in `src/console/`
and rebuild. When adding a console file, add it to both the allow-list in
`src/adminConsole.ts` and `scripts/copy-console-assets.js`.

No public page links to the console. The console and `/admin/reset-password`
link to each other. Validate with `npm run build` and
`node scripts/test-admin-console.js`, which checks serving and headers, static
rules, computed palette contrast, and runs the console scripts in a VM with
DOM, `fetch` and storage stand-ins against the real handler and a temporary
PGlite database. Layout, focus visibility and real-browser behavior still need
a manual browser check.

## Interactive API documentation

Open `/api/docs` (or `/docs`) on the running service, for example
`http://localhost:3210/api/docs`. Swagger UI and its assets are served locally;
no CDN is required. `/api/openapi.json` (alias `/openapi.json`) exposes the
OpenAPI 3.0 document used by the UI and client generators.

The document is generated from `src/openapi.ts` and the startup configuration.
It includes only the active local/Entra login routes and describes the current
registration switch. Both docs endpoints are public and contain no credential
values. Swagger's Authorize dialog accepts the dedicated user-admin and
emergency-rotation bearer tokens separately. The document also lists the
`ConsoleSession` cookie scheme for user management (CONTRACT-011), which
Swagger cannot send for you. Try it out sends real requests to this service. Authorization
is not persisted across reloads, and the external spec validator is disabled.

When changing endpoints, update their schemas, responses, and security in
`src/openapi.ts` in the same change. Swagger renders this explicit description;
it does not infer behavior from handler code. Verify with `npm run build`
and `node scripts/test-api-docs.js`. Rebuild and restart existing deployments
after installing dependencies to enable these routes.

## Coding conventions

- Use TypeScript with strict type checking and ES module-compatible imports.
- Use camel case for variables and functions, Pascal case for interfaces, and
  uppercase snake case for environment variable names.
- Keep bootstrap configuration validation separate from HTTP route setup.

## Testing philosophy

Document required test levels, coverage expectations, fixtures, and manual checks.

## Security and privacy

Document secrets handling, data classification, dependency, and reporting rules.
