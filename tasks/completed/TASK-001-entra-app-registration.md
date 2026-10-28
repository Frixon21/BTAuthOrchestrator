# TASK-001: Entra app registration & tenant confirmation

Owner role: Human (tenant administration)
Assigned agent: Patrick
Proposed by: Jarvis
Proposed date: 2026-08-11
Approved by: Patrick Moon
Approved date: 2026-08-11
Related contracts: none
Related ADRs: none
Dependencies: none

## Desired outcome

BTAuthOrchestrator exists as a registered application in the org's Entra
tenant, with the concrete values (tenant ID, client ID, redirect URI,
MFA/Conditional Access status) needed before any OIDC contract or
implementation work can proceed.

## Context

NOTES.md establishes Entra ID via OIDC as the chosen IdP (§3). This is the
first time a custom internal app will authenticate against this tenant —
whether Conditional Access/MFA applies to non-O365 app sign-in is
unconfirmed (NOTES.md §5, open question) and must be checked as part of this
registration, not assumed. The hostname does not need to be internet-
reachable — Entra redirects the user's browser to it, it never connects to
it directly — but it must resolve consistently for every user's browser on
the LAN.

Hostname: `orca.biztechro.com` (final — changed from the initial
`orca.btdomain.local` placeholder once Entra rejected a non-HTTPS redirect
URI; `.local` isn't a real domain Let's Encrypt can issue a cert for, so the
project moved to a real subdomain instead — see TLS note below). Redirect
URI: `https://orca.biztechro.com/auth/callback` — exact string, since Entra
validates redirect URIs by exact match. The `/auth/callback` path is a
placeholder choice made here so registration has a concrete value; if
CONTRACT-001 (TASK-002) settles on a different path, update the redirect URI
in the Entra app registration to match before TASK-007 is implemented —
redirect URIs can be edited after registration, this isn't a one-time lock.

**TLS finding (resolved during this task):** Entra rejected a plain-HTTP
redirect URI outright — HTTPS is required. This narrows, but does not
overturn, NOTES.md §5's "no TLS" constraint: only BTAuthOrchestrator's own
OIDC-facing endpoints need TLS; consuming apps stay on plain internal HTTP,
and the session cookie's `Secure` flag stays independently
false-by-default regardless (see CONTRACT-001). Cert strategy: split-horizon
DNS against `biztechro.com` (Cloudflare, API-capable) — a real public DNS
record for `orca.biztechro.com` resolves internally to the LAN IP, with a
Let's Encrypt cert obtained via DNS-01 challenge (no internet-facing
exposure required). Termination via Caddy reverse proxy in front of the
Node service. See TASK-003d for implementation.

## Scope

### Included

- Registering the application in Entra ID.
- Setting redirect URI(s).
- Requesting minimal scopes (`openid`, `profile`, `email`).
- Confirming MFA/Conditional Access behavior for this app.
- Confirming whether the HTTPS-redirect-URI requirement blocks the no-TLS
  plan.

### Excluded

- Any code.
- Any contract content.
- Client secret storage/handling process (see TASK-006).

## Plan

1. Register the application in Entra ID (Entra ID → App registrations → New
   registration), single-tenant ("Accounts in this organizational directory
   only").
2. Add `http://orca.btdomain.local/auth/callback` as a Web platform redirect
   URI; record whether Entra accepts, warns on, or rejects the non-HTTPS
   value.
3. Confirm `openid`, `profile`, `email` are available (these are standard
   OIDC scopes, available by default — no extra Graph API permission needed
   since this is authentication-only).
4. Generate a client secret (Certificates & secrets → New client secret).
   Do not store it in this task's output or in any repo file — hold it only
   long enough to feed into TASK-006's bootstrap script once that exists
   (a password manager entry is fine as an interim holding spot; a plaintext
   file anywhere in this repo or a shell history is not).
5. Confirm with the tenant owner whether MFA/Conditional Access applies to
   this app (Entra ID → Security → Conditional Access → Policies; check
   whether any policy targets "All cloud apps" or would otherwise apply to a
   newly registered app).
6. Record tenant ID, client ID, redirect URI, and the MFA/CA and
   HTTPS-redirect findings.

## Acceptance criteria

- [x] Application registered in Entra ID.
- [x] Tenant ID, client ID, and exact redirect URI recorded.
- [x] MFA/Conditional Access applicability confirmed and recorded.
- [x] HTTPS-redirect-URI requirement outcome confirmed and recorded
      (accepted / flagged / rejected for plain HTTP).
- [x] Client secret generated but not stored in this task's output — handed
      directly to TASK-006's bootstrap step.

## Recorded outcome

- Application (client) ID: `edcb141d-df64-46ec-8ec2-e92e05359e41`
- Directory (tenant) ID: `0adaaaf4-1740-44d0-94ef-620d1fb75045`
- Redirect URI: `https://orca.biztechro.com/auth/callback` (HTTPS required —
  Entra rejected plain HTTP; see TLS note above)
- MFA/Conditional Access: Security Defaults are **not enabled** on this
  tenant today — no MFA or Conditional Access currently applies to any
  sign-in, including this app. Microsoft recommends enabling Security
  Defaults, but that is a tenant-wide switch affecting all of O365, not
  scoped to this app — out of scope for this project; noted for Patrick to
  weigh separately as an IT security-posture decision, not acted on here.
- Client secret: generated in the Entra portal; held outside the repo,
  pending TASK-006's bootstrap script.

## Validation requirements

Findings recorded as a durable artifact — this file, plus the NOTES.md §5
correction — rather than left only in conversation.

## Risks and assumptions

- Assumes a hostname can be chosen without final production DNS in place
  (placeholder acceptable).
- Real risk: Entra may reject or flag a plain-HTTP redirect URI, which could
  force a change to the "no TLS" constraint in NOTES.md §5. If so, escalate
  to Jarvis/Patrick before TASK-002 proceeds.

## Blocker

None.

## Implementation handoff

Completed by Patrick directly in the Entra portal. Surfaced one
architecturally significant finding not anticipated at proposal time: Entra
requires HTTPS on the redirect URI, which forced a hostname change
(`orca.btdomain.local` → `orca.biztechro.com`) and a new task, TASK-003d, for
TLS provisioning. See "TLS finding" above and NOTES.md §5.

## Review

Not applicable — human-owned task, no separate reviewer.
