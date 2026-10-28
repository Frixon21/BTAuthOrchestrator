# CONTRACT-012: Cloudflare Tunnel ingress and trusted client address

Status: Approved
Approved by: Patrick
Approved date: 2026-10-28
Related tasks: TASK-029 (trusted client address), TASK-025 (container
deployment, to be revised for the tunnel), TASK-003d (made unnecessary; see
Purpose)
Related ADRs: ADR-001
Supersedes:
- CONTRACT-008, only for: the "Reverse proxy" actor; the Preconditions
  bullet that only the reverse proxy reaches the Node port; the Interfaces
  "Ingress" line; §8 in full; the Scope exclusions naming the Caddy image,
  `Caddyfile` and Caddy's certificate mode; OQ-9's deferral, which this
  contract resolves; and Resolved decision #21. Wherever CONTRACT-008 says
  "the reverse proxy", read "the Cloudflare Tunnel connector" (§1).
- CONTRACT-003, only for how `source_ip` is derived (its schema note for
  `emergency_rotation_audit.source_ip` and the assumption in its Open
  questions item 12 that Caddy is the only path to the service).
- CONTRACT-005, only for how `source_ip` is derived for `local_login_audit`
  and `local_user_admin_audit`, and for which address §3's per-source-IP
  throttle counts.

All other behavior in CONTRACT-003, CONTRACT-005, CONTRACT-008, CONTRACT-009
and CONTRACT-011 remains in force.
Superseded by:

## Purpose

Patrick decided on 2026-10-28 to drop Caddy and put the service behind a
Cloudflare Tunnel he already has:

- Cloudflare's edge terminates HTTPS for `orca.biztechro.com`.
- A `cloudflared` connector runs beside the app and connects out to
  Cloudflare. No port is published on the TrueNAS host, and no dedicated IP
  alias is needed.
- Caddy, its custom image, `tls internal` and Cloudflare DNS-01 are no
  longer part of the design. TASK-003d's goal, a browser-trusted
  certificate, is met by Cloudflare's edge certificate instead.

Behind the tunnel, every request reaches Node from the connector, so the
service must learn the real client address from Cloudflare's
`CF-Connecting-IP` header. It must trust that header only from the
connector. Today `extractSourceIp` trusts the first `X-Forwarded-For` entry
from any peer, which CONTRACT-008 §8 made safe only through Caddy's
behavior. Without the rule below, the per-IP login throttle would treat all
users as one address, audit rows would record only the connector, and
anyone reaching Node another way could forge their address.

## Scope

### Included

- The ingress topology and its deployment invariants (§1, §4).
- How the service derives a request's client address, in every deployment
  mode (§2).
- A new optional setting, `TRUSTED_PROXIES` (§3).
- Protecting `/admin/*` at Cloudflare (§5).

### Excluded

- The compose file, `cloudflared` service definition and Cloudflare
  dashboard steps themselves (TASK-025).
- Any change to what is audited, the throttle thresholds, or how
  `source_ip` is used. Only the value changes.
- Honoring `X-Forwarded-For` (OQ-2) or any other proxy's header.
- Cloudflare WAF, rate limiting or caching rules beyond §4 and §5.

## Actors

- **Client**: a browser, a consuming app, or an operator script. Reaches
  the service only at `https://orca.biztechro.com` through Cloudflare.
- **Cloudflare edge**: terminates TLS, sets `CF-Connecting-IP` to the
  address the client connected from (overwriting any value the client
  sent), and forwards the request into the tunnel.
- **Tunnel connector** (`cloudflared`): a sibling compose service. It holds
  the tunnel token and forwards requests to the app over the compose
  network as plain HTTP.
- **BTAuthOrchestrator**: derives the client address under §2.

## Inputs and outputs

| Input | Source | Notes |
|---|---|---|
| Socket peer address | the TCP connection | normalized under §2 |
| `CF-Connecting-IP` | request header | used only from a trusted peer |
| `TRUSTED_PROXIES` | environment, read at startup | §3 |
| Tunnel token | `cloudflared`'s environment | operator-supplied; never in the repo or an image |

Output: one client address per request, or none. It is used for every
`source_ip` audit value and for CONTRACT-005 §3's per-IP throttle, and the
CONTRACT-009 password-change throttle, which uses the same address.

## Preconditions

- Patrick's Cloudflare Tunnel exists, and its public hostname
  `orca.biztechro.com` routes to the app's compose service name and port.
- `SERVICE_ISSUER` is `https://orca.biztechro.com` and `COOKIE_SECURE` is
  `true`, because clients use HTTPS at the edge even though Node receives
  plain HTTP.
- The Entra redirect URI stays `https://orca.biztechro.com/auth/callback`.

## Required behavior

### 1. Ingress topology

- The compose project has the app service and a `cloudflared` service. No
  service publishes a host port.
- The app and the connector share a dedicated compose network whose subnet
  is fixed in the compose file. No other container joins it.
- The tunnel is the only ingress. Clients on the LAN also reach the service
  through Cloudflare.
- Cloudflare's edge serves HTTPS with its own certificate and redirects
  HTTP to HTTPS ("Always Use HTTPS").

### 2. Client address

For each request:

1. Take the socket peer address. Normalize an IPv4-mapped IPv6 address
   (`::ffff:a.b.c.d`) to `a.b.c.d`.
2. If `TRUSTED_PROXIES` is empty or unset, the client address is the peer
   address. Forwarded headers are ignored (OQ-1).
3. If the peer address is not inside `TRUSTED_PROXIES`, the client address
   is the peer address. Forwarded headers are ignored.
4. If the peer is inside `TRUSTED_PROXIES` and the request has exactly one
   `CF-Connecting-IP` header whose trimmed value is a valid IPv4 or IPv6
   literal, the client address is that value, normalized as in step 1.
5. Otherwise, the client address is the peer address.

`X-Forwarded-For` is never consulted (OQ-2). The derived value is
always an IP literal, never raw header text. If the socket has no peer
address, the client address is `null`, as today.

### 3. `TRUSTED_PROXIES`

- Optional. A comma-separated list of IPv4 or IPv6 addresses or CIDR
  ranges, for example `172.30.10.0/29`. Whitespace around entries is
  ignored, and empty entries are not allowed.
- Read and validated once at startup. Any invalid entry fails startup
  closed, with an error that names the variable and the bad entry.
- In the container deployment it is set to the fixed subnet of §1's compose
  network.
- The startup configuration log line includes the trusted ranges. They are
  not secret.

### 4. Deployment invariants

These replace CONTRACT-008 §8:

- No compose service publishes a host port.
- `TRUSTED_PROXIES` covers only the dedicated compose network, which holds
  only the app and the connector.
- If the Node port is ever published, or another container joins that
  network, a client could forge `CF-Connecting-IP` from a trusted address.
  TASK-025's documentation states this.

### 5. Admin paths at Cloudflare

- A Cloudflare Access application covers `orca.biztechro.com/admin/*`.
  Only people allowed by its policy reach the console, the admin API,
  `/admin/session`, `/admin/reset-password` or emergency rotation.
- Scripts that call admin endpoints, such as an emergency rotation from a
  shell, use a Cloudflare Access service token in addition to the bearer
  token.
- `/auth/*`, `/.well-known/jwks.json`, `/health`, `/api/*`, `/docs` and
  `/openapi.json` stay
  reachable without Access, because users sign in through them and
  consuming apps fetch JWKS from servers that cannot complete Access.
- This is configured in Cloudflare and needs no code change. The bearer
  tokens and CONTRACT-011 session rules still apply behind it.

## Postconditions and invariants

- A forwarded header from a peer outside `TRUSTED_PROXIES` never affects
  any `source_ip` or throttle key.
- With `TRUSTED_PROXIES` unset, behavior is peer address only on every
  route.
- Two clients signing in through Cloudflare are counted separately by the
  per-IP throttle.
- `source_ip` values are always IP literals or `null`.

## Failure behavior

| Condition | Result |
|---|---|
| Invalid `TRUSTED_PROXIES` entry | Startup fails closed, naming the variable and entry |
| Trusted peer, no `CF-Connecting-IP` | Peer address used |
| Trusted peer, malformed or repeated `CF-Connecting-IP` | Peer address used |
| Untrusted peer sends `CF-Connecting-IP` or `X-Forwarded-For` | Ignored; peer address used |
| Tunnel down | Service unreachable for everyone, including the LAN; no data effect |

## Interfaces

- Configuration: `TRUSTED_PROXIES` (optional), §3.
- No HTTP endpoints are added or changed.
- Internally, every caller that derives a client address uses one function
  implementing §2. Today that is `extractSourceIp` in `src/index.ts`.

## UX expectations

None for end users. Operators see the trusted ranges in the startup log,
and an explicit error if they mistype one.

## Validation requirements

Isolated handler tests, in the style of the existing `scripts/test-*.js`
files, cover:

- Every row of §2: unset setting; untrusted peer with forged
  `CF-Connecting-IP` and `X-Forwarded-For`; trusted peer with a valid IPv4
  and a valid IPv6 header; trusted peer with a missing, malformed, or
  repeated header; IPv4-mapped peer addresses; CIDR and single-address
  entries.
- Startup validation: valid lists load; each kind of invalid entry fails
  with the variable and entry named.
- The per-IP login throttle counts two `CF-Connecting-IP` values from a
  trusted peer separately, and a forged header from an untrusted peer does
  not escape the throttle.
- Audit rows on login, admin and rotation paths record the derived address.
- Every existing test script still passes.

Deployment check, recorded in TASK-025's handoff: through the real tunnel,
two clients' sign-ins record their own public addresses; a client-supplied
`CF-Connecting-IP` does not change the recorded address; no host port is
open on TrueNAS for the app; and, if OQ-3 is accepted, `/admin/console`
requires Cloudflare Access while `/auth/local-login` and
`/.well-known/jwks.json` do not.

## Open questions

All open questions were decided by Patrick on 2026-10-28. The draft is
ready for approval.

1. **Should forwarded headers be ignored unless `TRUSTED_PROXIES` is set?**
   Today the service believes the first `X-Forwarded-For` entry from anyone.
   On a systemd or Windows install that clients reach directly, a client can
   send that header with any address it likes, getting past the per-IP
   login throttle and writing false addresses into audit rows.
   - (a) **Yes, as drafted in §2.** With no `TRUSTED_PROXIES`, the service
     uses only the connection's own address. This closes the gap. The cost:
     a deployment behind some other proxy would record that proxy's address
     until it sets `TRUSTED_PROXIES`. None is known to exist; TASK-003d's
     host Caddy was never built.
   - (b) **No.** Keep believing `X-Forwarded-For` when `TRUSTED_PROXIES` is
     unset, and apply the new rule only when it is set. Nothing changes for
     existing installs, and the gap stays open on them.

   Recommended: (a).
   **Decided (Patrick, 2026-10-28): (a).** See §2.
2. **Which forwarded header.** **Decided (Patrick, 2026-10-28): whichever
   suits Cloudflare best.** That is `CF-Connecting-IP`, which Cloudflare
   documents as the header for the original client address. It holds a
   single address that Cloudflare's edge sets itself, overwriting any value
   the client sent, so no chain parsing is needed. `X-Forwarded-For` is not
   read; a later contract can add it if another proxy appears.
3. **Should Cloudflare Access protect `/admin/*` before go-live?** Through
   the tunnel, every path is on the public internet, not just the LAN. Under
   `/admin/` are the admin console, the user-management API, the password
   reset page and emergency key rotation. Without Access, the only things
   protecting them are:
   - the two bearer tokens, and
   - since CONTRACT-011, the password of *any* active local user, because
     every active local user is an admin.

   Anyone on the internet could try passwords at the console. The login
   throttle and lockout slow this down but do not stop a patient attacker,
   and a single weak or reused password among the local users would give
   full user management. Cloudflare Access puts a second login (for
   example, a one-time code sent to an approved email address) in front of
   `/admin/*` at Cloudflare's edge. Requests from anyone not on the list
   never reach the server at all. It is configured in the Cloudflare
   dashboard and needs no code change.
   - (a) **Yes, as drafted in §5.** Access on `/admin/*` only. Sign-in,
     JWKS and docs stay open, so consuming apps are unaffected.
   - (b) **Access on the whole hostname during internal testing.** Tighter,
     but consuming apps' servers then cannot fetch JWKS without an Access
     service token.
   - (c) **No Access.** Rely on tokens and passwords alone.

   Recommended: (a).
   **Decided (Patrick, 2026-10-28): (a).** Cloudflare Access on `/admin/*`
   is required before the service goes live. See §5.
4. **TASK-003d.** **Decided (Patrick, 2026-10-28): Patrick will retire it
   himself.** Its goal is met by Cloudflare's edge certificate, and its
   method (Caddy with DNS-01) is gone.
