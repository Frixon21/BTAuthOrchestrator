# TASK-025: Docker image and compose stack behind Cloudflare Tunnel for TrueNAS SCALE

Owner role: Implementer
Assigned agent: TBD
Proposed by: Patrick Moon
Proposed date: 2026-10-20
Approved by: Patrick Moon
Approved date: 2026-10-20
Related contracts: CONTRACT-008 (Approved 2026-10-28; supersedes
CONTRACT-007, now Retired); CONTRACT-012 (Approved 2026-10-28; replaces
Caddy with Cloudflare Tunnel ingress and supersedes CONTRACT-008 §8);
CONTRACT-011 (console sign-in, which works only at a `biztechro.com` host and
is therefore first usable through this deployment)
Related ADRs: ADR-001
Dependencies: CONTRACT-008 and CONTRACT-012 approved (done 2026-10-28).
TASK-029 (trusted client address) must be complete before traffic goes
through the tunnel. TASK-028 is accepted.

## Desired outcome

BTAuthOrchestrator can be installed on TrueNAS SCALE as a Docker Compose app:
the Node service container plus a `cloudflared` connector for Patrick's
existing Cloudflare Tunnel, which serves `https://orca.biztechro.com`. No host
port is published. Data persists on an operator-chosen host path, and the
service seeds itself on first boot per CONTRACT-008.

## Context

Rewritten 2026-10-28 for CONTRACT-012. Caddy, its custom image, `tls internal`,
Cloudflare DNS-01 and the dedicated TrueNAS IP alias are no longer part of
this task. Cloudflare's edge terminates HTTPS; TASK-003d is being retired by
Patrick.

Patrick's decisions (2026-10-20), still in force:

- `/data` is the fixed in-container data path (`PGLITE_DATA_DIR=/data`).
  The host path is supplied by the operator through TrueNAS app
  configuration.
- The container runs `scripts/startup-check.js` then `dist/index.js`
  directly, not `start.sh`, which is a systemd entrypoint that requires a
  `.env` file.
- Deployment target is a TrueNAS SCALE 25.10.0.1 (Goldeye) **Custom App**
  (form or "Install via YAML").
- The base image is **Node 22 LTS**.

CONTRACT-012 decisions (2026-10-28):

- A `cloudflared` service in the same compose project connects out to the
  tunnel. The tunnel's public hostname `orca.biztechro.com` routes to the
  app's compose service name and port. No service publishes a host port.
- The app and `cloudflared` share a dedicated compose network with a pinned
  subnet; no other container joins it. `TRUSTED_PROXIES` is set to that
  subnet.
- `SERVICE_ISSUER=https://orca.biztechro.com`, `COOKIE_SECURE=true`. LAN
  clients also go through Cloudflare.
- Cloudflare Access protects `/admin/*` before the service goes live.
  `/auth/*`, `/.well-known/jwks.json`, `/health`, `/api/*`, `/docs` and
  `/openapi.json` stay open.

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
- **OQ-9:** option (a), since resolved by CONTRACT-012 and TASK-029:
  `CF-Connecting-IP` is trusted only from `TRUSTED_PROXIES`.
- **OQ-10:** a `PGLITE_DATA_DIR` other than `/data`, or no operator mount at
  `/data`, fails closed in container mode.

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
- Bump `engines.node` and `@types/node` to Node 22.
- `docker-compose.yml` suitable for TrueNAS SCALE "Install via YAML": the app
  service, a `cloudflared` service using the official image with the tunnel
  token from operator configuration (never the repo or an image), the
  dedicated network with its pinned subnet, and clearly marked
  operator-supplied values (host path, secrets, tunnel token).
- `docs/DEVELOPMENT.md` / `README.md` section on container deployment,
  including the Cloudflare dashboard steps (tunnel public hostname, Access
  application on `/admin/*`, "Always Use HTTPS") and CONTRACT-012 §4's
  invariants.

### Excluded

- The `TRUSTED_PROXIES` code itself (TASK-029).
- Creating the tunnel or the Access policy in Patrick's Cloudflare account
  (operator work, documented here).
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
4. `docker-compose.yml` with the app, `cloudflared` and the pinned network.
5. Docs, including the Cloudflare steps.
6. Validation on a local Docker host (without the tunnel, using
   `docker compose exec` or a temporary test-only port mapping that is not
   part of the shipped compose file), then on TrueNAS through the real
   tunnel.

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
- [ ] No compose service publishes a host port. `https://orca.biztechro.com/health`
      responds through the tunnel.
- [ ] `/admin/console` and its three assets load through the tunnel, and
      console sign-in (CONTRACT-011) works at `https://orca.biztechro.com`.
- [ ] Cloudflare Access is required for `/admin/console`, and not for
      `/auth/local-login` or `/.well-known/jwks.json`.
- [ ] Through the tunnel, two clients' sign-ins record their own public
      addresses, and a client-supplied `CF-Connecting-IP` does not change the
      recorded address (CONTRACT-012 Validation requirements).
- [ ] Running as UID 0, a `PGLITE_DATA_DIR` other than `/data`, or no
      operator mount at `/data` each fail closed.
- [ ] `docker stop` produces a clean shutdown (existing SIGTERM handling).
- [ ] No secret value, including the tunnel token, is baked into an image
      layer or committed to the repo.
- [ ] Container deployment is documented, including TrueNAS host-path
      ownership (UID/GID), the Cloudflare steps and CONTRACT-012 §4.

## Validation requirements

Run the acceptance checks that do not need the tunnel on a local Docker host,
then install on TrueNAS SCALE via YAML and run the rest through the real
tunnel. Inspect the image (`docker history`, layer contents) for leaked
`.env`, tunnel token or secret material.

## Risks and assumptions

- **The trust is only as good as the network isolation** (CONTRACT-012 §4).
  Publishing the app's port or adding another container to its network would
  let a client forge `CF-Connecting-IP` from a trusted address.
- **Everything depends on Cloudflare and the internet.** If the tunnel or the
  internet connection is down, nobody can sign in, including on the LAN.
- **Public from the first deploy.** The tunnel exposes the service to the
  internet immediately; the Access policy on `/admin/*` must be in place
  before the tunnel's public hostname is enabled.
- Host-path ownership must match the container UID (TrueNAS convention
  `568:568`), or CONTRACT-008's permission check fails closed at startup.
- Moving to Node 22: `package.json`'s `engines` and `@types/node` should be
  bumped to match. Run every test script on 22 before relying on it,
  including `test-admin-console.js`, `test-local-password-change.js` and
  `test-console-sign-in.js`.
- **Environment-only secrets (OQ-1).** `DB_ENCRYPTION_KEY`, the admin tokens
  and the tunnel token are visible to anyone who can run `docker inspect` or
  open the app's TrueNAS configuration, for the life of the install. Docs
  should say so and tell operators to remove `CLIENT_SECRET` and
  `INITIAL_LOCAL_USER_PASSWORD` after the first successful boot (OQ-2).
- **CONTRACT-008's body still describes `*_FILE` channels.** The approved
  OQ-1 answer overrides them; per ADR-001 the body is not edited. Reviewers
  should read the answers alongside §7.2.
- **Audit-table growth on the host volume.** The local-login and admin audit
  tables are never pruned (TASK-014); on TrueNAS they grow on the host
  dataset.

## Blocker

None in the repository. TASK-029 must be complete before the tunnel is
enabled. Before validating on TrueNAS, Patrick needs to create the host
dataset owned by `568:568`, add the tunnel's public hostname for
`orca.biztechro.com` pointing at the app's service name and port, and create
the Access application for `/admin/*`. A local Docker host is needed for the
first validation pass.

## Implementation handoff

Not started.

## Review

Not reviewed.
