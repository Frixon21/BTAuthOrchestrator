# BTAuthOrchestrator

BTAuthOrchestrator is the org's unified authentication service for
internally-built tools. Today each internal tool rolls its own local
login — that doesn't scale past one app and makes deprovisioning a leaver
error-prone. BTAuthOrchestrator fixes that by being the one thing that
authenticates users (via Microsoft Entra ID / O365, over standard OIDC) and
mints a signed session token every internal tool can verify on its own,
without a hard runtime dependency on this service being up.

It is not a general-purpose IdP product and does not support external or
non-employee identities — see `NOTES.md` for the full design rationale.

## Status

Milestone 1-2 (Entra app registration through the offline-verification
proof) is implemented and accepted. The one open item is TASK-003d: TLS
termination in front of the service, blocked on Cloudflare DNS
credentials. See `tasks/completed/` for what's shipped and
`tasks/approved/` for what's next.

## Setup

```sh
npm install
cp .env.example .env   # fill in the values below
npm run build
npm run seed            # one-time: stores CLIENT_SECRET and the initial signing key
npm start
```

`.env` requires eight variables (see `.env.example`): `PORT`,
`PGLITE_DATA_DIR`, `DB_ENCRYPTION_KEY`, `COOKIE_SECURE`, `TENANT_ID`,
`CLIENT_ID`, `SERVICE_ISSUER`, and `EMERGENCY_ROTATION_TOKEN`. The service
fails closed at startup if any is missing or invalid — there is no silent
default.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Build, then start. |
| `npm run build` | Type-check and compile to `dist/`, and copy the admin console files to `dist/console/`. |
| `npm run seed` | Build, then run the one-time bootstrap (stores `CLIENT_SECRET`, generates the initial signing key). Safe to re-run; refuses if already seeded. |
| `npm start` | Run the compiled service. |
| `npm run verify-offline` | Build, then run a standalone, re-runnable proof that a minted token verifies completely offline and that a rotated-out key's tokens correctly fail. |

## Endpoints

To enable public local account creation, set
`ALLOW_NEW_LOCAL_LOGIN_CREATION=True` in `.env`, rebuild, and restart the
service. Open `/auth/local-register` (for example,
`http://localhost:3210/auth/local-register`), also linked from local sign-in.
The form uses `POST /admin/users`. Missing or non-true values block creation
on the server. Listing, editing, and deleting users still require the admin token.
The registration page publicly shows local usernames and Active/Disabled status,
including when creation is disabled. The full admin list API remains protected.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check. |
| `GET /auth/login` | Starts the OIDC flow: redirects to Entra with PKCE/state/nonce. |
| `GET /auth/callback` | Entra's registered redirect URI; on success, sets the `bt_session` cookie. |
| `GET /.well-known/jwks.json` | Public signing keys (current + retired), for any consuming app to verify tokens independently. |
| `GET /admin/console` | Browser admin console for users and signing keys. Actions use the existing API with the dedicated bearer tokens. |
| `POST /admin/emergency-rotate-keys` | Break-glass "kill switch": immediately rotates the signing key and invalidates every outstanding session, org-wide. Bearer-token authenticated, separate from any user session. |

## Learn more

- [External app integration walkthrough](docs/samples/external-app-integration.html)
  — open the standalone HTML file in a browser for login diagrams, cookie
  delivery, an offline verification example, and the local-login alternative.
- `docs/DEVELOPMENT.md` — full technical detail: tech stack, repository
  layout, exact request/response behavior, and every command above in
  depth.
- `docs/contracts/` — the behavioral contracts (`CONTRACT-001` login flow,
  `CONTRACT-003` emergency rotation, `CONTRACT-007` encrypted storage)
  this service is built against.
- `NOTES.md` — the original design rationale and open questions.
- `CLAUDE.md` / `AGENTS.md` — how work on this repo is planned, approved,
  and reviewed.
- `tasks/` — the authoritative record of what's done, in progress, or
  planned; the directory a task file lives in is its status.

## License

MIT — see [LICENSE](LICENSE).

## API documentation

Open `/api/docs` on the running service for interactive Swagger documentation
(for example, `http://localhost:3210/api/docs`). Download the OpenAPI document
at `/api/openapi.json`. Documentation reflects the configured login mode and
registration switch. Try it out calls the running API; protected operations
require their dedicated bearer tokens in Authorize.

Local users can change their password at `/auth/local-change-password` when
`LOCAL_LOGIN=true`, using their current password and a different new password
of at least 12 characters. Operators can open `/admin/reset-password` directly
in either login mode and use `LOCAL_USER_ADMIN_TOKEN` to reset a password via
the existing admin API. Resets clear lockout but do not re-enable disabled
accounts. Existing sessions remain valid after either operation. See
[development guidance](docs/DEVELOPMENT.md) for behavior and validation.

## Admin console

Open `/admin/console` (for example, `http://localhost:3210/admin/console`) in
either login mode to manage local users and signing keys from a browser, with
System, Light and Dark themes. Enter `LOCAL_USER_ADMIN_TOKEN` and
`EMERGENCY_ROTATION_TOKEN` separately in Settings. They stay in that tab's
session storage until it closes, and Forget all removes them. Each token is sent
only to its own endpoints. Creating users uses the public registration endpoint,
so it works only while `ALLOW_NEW_LOCAL_LOGIN_CREATION=true`. Deleting a user
requires typing its username, and emergency rotation requires typing `ROTATE`.
The console is not linked from public pages. See
[development guidance](docs/DEVELOPMENT.md#browser-admin-console-contract-010).
