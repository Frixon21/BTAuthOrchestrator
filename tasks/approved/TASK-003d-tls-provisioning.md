# TASK-003d: TLS provisioning & termination

Owner role: Implementer
Assigned agent: openai-coder
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick
Approved date: 2026-09-14
Related contracts: none
Related ADRs: none
Dependencies: TASK-001 (completed — hostname `orca.biztechro.com` and
redirect URI confirmed); TASK-004 (scaffold, service to sit behind the
proxy). Requires Cloudflare API credentials for `biztechro.com` DNS as a
human-provided prerequisite (same shape as TASK-001's tenant-admin
dependency).

## Desired outcome

BTAuthOrchestrator's public-facing endpoints are served over TLS at
`https://orca.biztechro.com`, satisfying Entra's requirement that the OIDC
redirect URI be HTTPS, without requiring any consuming app to adopt TLS and
without changing the session cookie's `Secure` flag default.

## Context

Entra rejected a plain-HTTP redirect URI during TASK-001, contradicting
NOTES.md §5's original "no TLS" constraint for this one surface — see the
NOTES.md §5 correction and `tasks/completed/TASK-001-entra-app-registration.md`
for the full finding. Resolved design:

- TLS covers BTAuthOrchestrator's own origin only. Consuming apps never
  talk to Entra directly and never see a redirect URI — nothing here forces
  TLS onto them.
- Cert strategy: split-horizon DNS. `orca.biztechro.com` gets a real public
  DNS record on Cloudflare; a Let's Encrypt certificate is obtained via the
  DNS-01 challenge (does not require the host to be internet-reachable,
  only DNS control). Internal DNS resolves the same name to the LAN-internal
  IP, so nothing is actually exposed to the internet.
- Termination point: Caddy, as a reverse proxy in front of the Node
  process — not Node's built-in `https` module. Caddy automates the
  ACME/DNS-01 flow and certificate renewal outside the application process,
  keeping certificate lifecycle separate from the process already carrying
  PGlite/secret-handling responsibility (CONTRACT-002).
- The session cookie's `COOKIE_SECURE` flag stays false by default,
  independent of this task. It's governed by whether *all* consuming apps
  have TLS (they don't) — the orchestrator having TLS does not change this.
  Do not flip `COOKIE_SECURE` to true as a side effect of this task.

## Scope

### Included

- Caddy installed/configured as a reverse proxy in front of the Node
  service on the dedicated host.
- Caddy configured for automatic Let's Encrypt certificate acquisition via
  DNS-01 against `biztechro.com` on Cloudflare, with automated renewal.
- Cloudflare API credentials sourced from a human-provided value (not
  hardcoded, not committed) — coordinate with Patrick for the actual
  credential.
- Confirm `https://orca.biztechro.com` serves the health-check endpoint
  from TASK-004 with a browser-trusted certificate (no warnings).

### Excluded

- Any TLS requirement on consuming apps.
- Any change to `COOKIE_SECURE`'s default value.
- Internal CA or self-signed certificate setup (ruled out — no existing
  internal CA, Cloudflare API access confirmed available instead).

## Plan

1. Install Caddy on the dedicated host.
2. Configure Caddy to reverse-proxy `orca.biztechro.com` to the Node
   service's local port.
3. Configure Caddy's Cloudflare DNS-01 provider with the supplied API
   credential (stored outside the repo, e.g. as a Caddy-local
   environment/config value, not in `.env` or PGlite — this is
   infrastructure-level, not application-level, secret material).
4. Verify certificate acquisition and automatic renewal configuration.
5. Confirm the TASK-004 health-check endpoint is reachable over HTTPS with
   no certificate warnings from a normal browser.

## Acceptance criteria

- [ ] `https://orca.biztechro.com` resolves (internally) and serves the
      Node service through Caddy with a valid, browser-trusted certificate.
- [ ] Certificate renewal is automated (DNS-01 via Cloudflare), not a manual
      process.
- [ ] `COOKIE_SECURE` remains false by default; nothing in this task changes
      that.
- [ ] Consuming apps' plain-HTTP operation is unaffected (no scope creep
      onto other hosts).

## Validation requirements

Load `https://orca.biztechro.com/<health-check-path>` in a normal browser
from an internal machine; confirm no certificate warning and a valid
response. Confirm renewal configuration (e.g., Caddy's automatic renewal
logs/behavior) rather than assuming it works.

## Risks and assumptions

- Assumes Cloudflare API credentials for `biztechro.com` are made available
  by Patrick; this task cannot proceed without them.
- If DNS-01 automation turns out not to work as expected against this
  Cloudflare account (e.g., permission scoping issues), escalate rather than
  falling back silently to a manual or self-signed alternative.

## Blocker

Blocked on a Cloudflare API credential for `biztechro.com` DNS (scoped for
the DNS-01 challenge), needed before Caddy can be configured per this
task's Plan §3. Only Patrick can provide this (same shape as TASK-001's
tenant-admin dependency). Effect: this task cannot start — no Caddy/TLS
configuration work should begin until the credential is available.
Confirmed with Patrick on 2026-09-14 that it is not yet ready; task stays
in `tasks/approved/` until it is.

**Additionally deprioritized (2026-09-15):** Entra/Azure integration work
is on hold while CONTRACT-005's local-login system (ADR-003) is built out
and tested, so this task has no near-term urgency even once the Cloudflare
credential is available — TLS matters for Entra's redirect-URI requirement
(CONTRACT-001) and for CONTRACT-003's bearer-credential-over-the-wire
requirement, neither of which is on the critical path while local-only
testing is the priority. Per `docs/workflow/lifecycle.md` ("Blocked is a
condition, not a lifecycle directory"), this task stays in `tasks/approved/`
rather than moving to `proposed/` or `review/` — neither reflects its
actual state (it's still approved; it's just not being worked right now).

## Implementation handoff

Not started.

## Review

Not reviewed.
