# TASK-025: Docker image, compose stack, and Caddy for TrueNAS SCALE

Owner role: Implementer
Assigned agent: TBD
Proposed by: Patrick Moon
Proposed date: 2026-10-20
Approved by:
Approved date:
Related contracts: CONTRACT-008 (from TASK-024; supersedes CONTRACT-007)
Related ADRs: none
Dependencies: TASK-024 (CONTRACT-008 approved). Overlaps TASK-003d (see
Context). Real certificate issuance remains blocked on the Cloudflare API
credential, the same blocker as TASK-003d.

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

- Multi-stage `Dockerfile`: a build stage (`npm ci`, `tsc`) and a slim Node
  runtime stage (`npm ci --omit=dev`). Runs as non-root,
  `PGLITE_DATA_DIR=/data`, `VOLUME /data`, `HEALTHCHECK` on `GET /health`.
- `.dockerignore` excluding `.env`, `data/`, `node_modules/`, `dist/`,
  `.git/`.
- Container entrypoint implementing CONTRACT-008's first-boot seed and
  normal-start behavior.
- Seed/database code changes required by CONTRACT-008 (input channels,
  read-only secret files, exit status, stale-lock recovery).
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

To be finalised once CONTRACT-008 is approved. Expected shape: Dockerfile and
.dockerignore → entrypoint and contract-required code changes → Caddy image
and Caddyfile → compose file → docs → validation on a local Docker host, then
on TrueNAS.

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
- Moving to Node 22: `package.json`'s `engines` and `@types/node` should be
  bumped to match. Run the existing verify scripts on 22 before relying on
  it.

## Blocker

Blocked until TASK-024 produces an approved CONTRACT-008.

## Implementation handoff

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
