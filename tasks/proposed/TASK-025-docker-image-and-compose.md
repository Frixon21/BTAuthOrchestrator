# TASK-025: Docker image, compose stack, and Caddy for TrueNAS SCALE

Owner role: Implementer
Assigned agent: TBD
Proposed by: Patrick Moon
Proposed date: 2026-10-20
Approved by:
Approved date:
Related contracts: CONTRACT-008 (Approved 2026-10-28; supersedes
CONTRACT-007, now Retired); CONTRACT-011 (console sign-in, which works only
at a `biztechro.com` host and is therefore first usable through this
deployment)
Related ADRs: ADR-001
Dependencies: CONTRACT-008 approved (done 2026-10-28). TASK-028 should be
accepted first: both change `src/index.ts`/`src/database.ts`, and TASK-028
adds an audit-table migration. Overlaps TASK-003d (see Context). Real
certificate issuance remains blocked on the Cloudflare API credential, the
same blocker as TASK-003d.

## Desired outcome

BTAuthOrchestrator can be installed on TrueNAS SCALE as a Docker Compose app:
a Node service container plus a Caddy container that terminates TLS for
`orca.biztechro.com`. Data persists on an operator-chosen host path, and the
service seeds itself on first boot per CONTRACT-008.

## Context

Patrick's decisions (2026-10-20):

- `/data` is the fixed in-container data path (`PGLITE_DATA_DIR=/data`).
  The host path is supplied by the operator through TrueNAS app
  configuration.
- Caddy runs as a second service in the same compose project, built as a
  small custom image with the `caddy-dns/cloudflare` module for DNS-01.
  Only Caddy publishes ports. The Node service is reachable only on the
  internal compose network.
- The container runs `scripts/startup-check.js` then `dist/index.js`
  directly, not `start.sh`, which is a systemd entrypoint that requires a
  `.env` file.

- Deployment target is a TrueNAS SCALE 25.10.0.1 (Goldeye) **Custom App**
  (form or "Install
  via YAML").
- The base image is **Node 22 LTS**.
- TrueNAS's own UI keeps ports 80/443, and they cannot be changed in this
  environment. Patrick will assign a **dedicated IP** on the TrueNAS host for
  this app. Caddy's published ports bind to that IP only
  (`"<ORCA_IP>:443:443"`, `"<ORCA_IP>:80:80"`). Internal DNS for
  `orca.biztechro.com` points at that IP.

Patrick's answers to CONTRACT-008's open questions (2026-10-28). Where an
answer differs from the contract body's draft text, the answer governs:

- **OQ-1, input channels: environment variables only.** No `*_FILE`
  variants are implemented, so §7.2's `*_FILE` rules and the "exactly one
  channel" check do not apply. Every input, including `DB_ENCRYPTION_KEY`,
  the two tokens, `CLIENT_SECRET` and `INITIAL_LOCAL_USER_*`, comes from the
  container environment. The exposure tradeoff (values visible in
  `docker inspect` and the TrueNAS app configuration) is accepted.
- **OQ-2:** seed inputs left set after seeding are ignored with a per-start
  warning naming them.
- **OQ-3:** as recommended. The CLI's `--client-secret-file` and
  `--local-user-file` keep read-then-unlink unchanged; with OQ-1 there are no
  container secret files to protect.
- **OQ-4:** option (a), a separate `--non-interactive` seed mode that exits 0
  when already seeded; the plain CLI keeps its non-zero exit.
- **OQ-5:** default UID:GID `568:568`, operator override through compose
  `user:` allowed, UID 0 refused in container mode, never auto-`chown`.
- **OQ-6:** option (b), the liveness-socket stale-lock mechanism, on POSIX
  hosts and in containers; Windows keeps today's behavior.
- **OQ-7:** Docker's default stop grace period; no `stop_grace_period`.
- **OQ-8:** CONTRACT-008 also supersedes CONTRACT-005 §5's input-channel
  sentence for container first boot.
- **OQ-9:** option (a). Trusted-proxy `X-Forwarded-For` handling is deferred
  to a follow-up task (number to be assigned; OQ-9's "TASK-026" is taken).
  Until it exists, Caddy must not be configured with `trusted_proxies` and
  Cloudflare proxying must not be enabled.
- **OQ-10:** a `PGLITE_DATA_DIR` other than `/data`, or no operator mount at
  `/data`, fails closed in container mode.

**Relationship to TASK-003d:** TASK-003d stays separate and remains blocked
on the Cloudflare side; testing is internal-only for now. This task
therefore ships Caddy in a mode that works without Cloudflare, using Caddy's
internal CA (`tls internal`), whose root certificate internal test clients
can trust. The Cloudflare DNS-01 configuration is included but disabled,
with one documented switch to enable it. Switching to it and verifying a
browser-trusted Let's Encrypt certificate remains TASK-003d's job once the
credential exists. This task does not edit TASK-003d.

## Scope

### Included

- Multi-stage `Dockerfile`: a build stage (`npm ci`, then `npm run build`,
  which also copies the admin console files to `dist/console/`; bare `tsc`
  would leave `/admin/console` returning 500) and a slim Node runtime stage
  (`npm ci --omit=dev`) that copies `dist/` including `dist/console/`, and
  `scripts/`. Runs as non-root (`568:568` by default),
  `PGLITE_DATA_DIR=/data`, `HEALTHCHECK` on `GET /health`. Whether to declare
  `VOLUME /data` is settled against OQ-10: an anonymous volume must not
  silently satisfy a missing operator mount.
- `.dockerignore` excluding `.env`, `data/`, `node_modules/`, `dist/`,
  `.git/`.
- Container entrypoint implementing CONTRACT-008's first-boot seed and
  normal-start behavior.
- Seed/database code changes required by CONTRACT-008 as answered:
  environment-only container inputs (OQ-1), the `--non-interactive` seed
  mode (OQ-4), seed-input warnings (OQ-2), root refusal (OQ-5), data-path
  guards (OQ-10) and liveness-socket stale-lock recovery (OQ-6).
- Caddy `Dockerfile` (`caddy:builder` + `xcaddy --with
  github.com/caddy-dns/cloudflare`) and a `Caddyfile` reverse-proxying
  `orca.biztechro.com` to `app:3000`. It defaults to `tls internal`, with
  the Cloudflare DNS-01 configuration present but disabled (see Context).
  The Cloudflare token comes from operator configuration, never from the
  repo. Caddy keeps a persistent volume for certificates and CA/ACME state.
- Bump `engines.node` and `@types/node` to Node 22.
- `docker-compose.yml` suitable for TrueNAS SCALE "Install via YAML", with
  clearly marked operator-supplied values (host paths, secrets, the
  Cloudflare token, the host IP/ports Caddy binds to).
- `docs/DEVELOPMENT.md` / `README.md` section on container deployment.

### Excluded

- Changing `COOKIE_SECURE`'s default (same exclusion as TASK-003d).
- Publishing images to a registry or CI image builds, unless Patrick adds
  them.
- A TrueNAS catalog app (questions.yaml-style templates), unless Patrick
  adds it.

## Plan

1. Contract code changes, testable without Docker: liveness-socket lock
   (OQ-6), `--non-interactive` seed mode and environment inputs (OQ-1/2/4),
   container-mode guards (OQ-5/10). Unit tests in the style of the existing
   `scripts/test-*.js`.
2. Node 22 bump (`engines.node`, `@types/node`); rerun every test script.
3. `Dockerfile`, `.dockerignore` and entrypoint.
4. Caddy image and `Caddyfile` (`tls internal`, Cloudflare block present but
   disabled, no `trusted_proxies`).
5. `docker-compose.yml` for "Install via YAML", operator values marked.
6. Docs.
7. Validation on a local Docker host, then on TrueNAS.

## Acceptance criteria

- [ ] `docker compose build` succeeds and the app image runs as non-root.
- [ ] A fresh install with an empty host path seeds itself on first start
      from the CONTRACT-008 inputs. Restarting it does not re-seed and does
      not fail.
- [ ] Data survives `docker compose down` and `up` (signing keys, users,
      `CLIENT_SECRET`).
- [ ] After an unclean stop (`docker kill`), the service starts again per
      CONTRACT-008's stale-lock rule. Two concurrent instances against one
      data path are still refused.
- [ ] The Node service publishes no host port; `/health` is reachable
      through Caddy.
- [ ] `/admin/console` and its three assets load through Caddy, and console
      sign-in (CONTRACT-011) works at `https://orca.biztechro.com` once the
      client trusts Caddy's internal root CA.
- [ ] A client-supplied `X-Forwarded-For` sent through Caddy does not appear
      as `source_ip` in `local_login_audit` (CONTRACT-008 §8).
- [ ] Running as UID 0, a `PGLITE_DATA_DIR` other than `/data`, or no
      operator mount at `/data` each fail closed.
- [ ] `docker stop` produces a clean shutdown (existing SIGTERM handling).
- [ ] No secret value is baked into an image layer or committed to the repo.
- [ ] Container deployment is documented, including TrueNAS host-path
      ownership (UID/GID) and the port-binding note below.

## Validation requirements

Run the acceptance checks on a local Docker host, then install on TrueNAS
SCALE via YAML. Inspect the image (`docker history`, layer contents) for
leaked `.env` or secret material. Certificate issuance is validated only
once the Cloudflare credential is available (TASK-003d's blocker).

## Risks and assumptions

- **The dedicated IP must exist on the TrueNAS host before install.** Add
  it as an alias on the TrueNAS network interface. TrueNAS's UI must not
  also listen on that IP; check its "Web Interface IPv4 Address" setting,
  since "0.0.0.0" binds every address, alias included. If TrueNAS's UI
  binds all addresses and that can't be narrowed, Caddy needs a macvlan
  network giving the container its own LAN IP instead. Confirm this on the
  real host early.
- With `tls internal`, test clients see a certificate warning unless they
  trust Caddy's root CA. That is acceptable for internal testing and is
  documented, not worked around.
- Host-path ownership must match the container UID (TrueNAS convention
  `568:568`), or CONTRACT-008's permission check fails closed at startup.
- **Open question — restricting `/admin/*` at Caddy.** Everything under
  `/admin/` (console, user-management API, `/admin/reset-password`,
  emergency rotation) is administrative and is otherwise reachable by anyone
  who can reach the dedicated IP, protected only by tokens and, after
  TASK-028, by local user passwords. End users and consuming apps need only
  `/auth/*` and `/.well-known/jwks.json`. Caddy could serve `/admin/*` only
  to LAN/VPN source ranges. While deployment is internal-only (`tls
  internal`, LAN IP) this adds little; Patrick to decide before the service
  is reachable from the internet (e.g. when TASK-003d enables Cloudflare).
- Moving to Node 22: `package.json`'s `engines` and `@types/node` should be
  bumped to match. Run every test script on 22 before relying on it,
  including `test-admin-console.js`, `test-local-password-change.js` and
  `test-console-sign-in.js`.
- **Environment-only secrets (OQ-1).** `DB_ENCRYPTION_KEY` and the tokens are
  visible to anyone who can run `docker inspect` or open the app's TrueNAS
  configuration, for the life of the install. Docs should say so and tell
  operators to remove `CLIENT_SECRET` and `INITIAL_LOCAL_USER_PASSWORD` after
  the first successful boot (OQ-2).
- **CONTRACT-008's body still describes `*_FILE` channels.** The approved
  OQ-1 answer overrides them; per ADR-001 the body is not edited. Reviewers
  should read the answers alongside §7.2.
- **Audit-table growth on the host volume.** The local-login and admin audit
  tables are never pruned (TASK-014); on TrueNAS they grow on the host
  dataset.

## Blocker

None in the repository since CONTRACT-008's approval (2026-10-28). Ready
for Patrick's approval. Before validating on TrueNAS, Patrick needs to:
add the dedicated IP alias, confirm the TrueNAS web UI does not bind that
IP, create the host dataset owned by `568:568`, and point internal DNS for
`orca.biztechro.com` at the IP. A local Docker host is needed for the first
validation pass.

## Implementation handoff

Not started.

## Review

Not reviewed.
