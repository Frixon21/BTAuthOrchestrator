# TASK-029: Trusted-proxy client address for Cloudflare Tunnel

Owner role: Implementer
Assigned agent: TBD
Proposed by: Patrick Moon
Proposed date: 2026-10-28
Approved by:
Approved date:
Related contracts: CONTRACT-012 (Proposed; §2-§3 are this task's
behavior), CONTRACT-008 (its OQ-9 deferred this work; it called the
follow-up "TASK-026", a number since used for the password-change task),
CONTRACT-003 and CONTRACT-005 (`source_ip` and the per-IP throttle)
Related ADRs: ADR-001
Dependencies: CONTRACT-012 approved. Must be completed before the service
is exposed through the Cloudflare Tunnel (TASK-025).

## Desired outcome

Behind the Cloudflare Tunnel, the service records each client's real
address in audit rows and throttles sign-in attempts per real client,
trusting Cloudflare's `CF-Connecting-IP` only from the tunnel connector.
Without the setting, it uses the connection's own peer address and ignores
forwarded headers.

## Context

Patrick decided (2026-10-28) to replace Caddy with his existing Cloudflare
Tunnel. Every request then arrives from the `cloudflared` container. Today
`extractSourceIp` (`src/index.ts`) trusts the first `X-Forwarded-For` entry
from any peer, which CONTRACT-008 §8 made safe only through Caddy. With the
tunnel and no change:

- the per-IP login and password-change throttles would count every user as
  the connector's address, so one person's failures would lock everyone
  out;
- audit `source_ip` values would all be the connector;
- anyone reaching Node another way could forge their address.

## Scope

### Included

- Parse and validate optional `TRUSTED_PROXIES` in `src/config.ts`
  (CONTRACT-012 §3), failing startup closed on a bad entry. Node's built-in
  `net.BlockList` and `net.isIP` cover CIDR matching and validation without
  a new dependency.
- Replace `extractSourceIp`'s rule with CONTRACT-012 §2 for all of its
  current callers: local login, password change, admin audit, emergency
  rotation.
- Include the trusted ranges in the startup configuration log line.
- `.env.example`, `docs/DEVELOPMENT.md` and `README.md` entries for the
  new setting and the changed default.
- A new test script covering CONTRACT-012's Validation requirements.

### Excluded

- The compose file, `cloudflared` service and Cloudflare dashboard setup
  (TASK-025).
- Cloudflare Access configuration (CONTRACT-012 §5; operator work).
- `X-Forwarded-For` support (CONTRACT-012 OQ-2).
- Any change to audit schema, throttle thresholds or what is audited.

## Plan

1. `TRUSTED_PROXIES` parsing and validation in `src/config.ts`, with tests
   for valid and invalid lists.
2. Rewrite `extractSourceIp` to CONTRACT-012 §2, keeping its signature so
   callers are unchanged.
3. Startup log line and docs.
4. New `scripts/test-trusted-proxies.js`; rerun every existing test script.

## Acceptance criteria

- [ ] With `TRUSTED_PROXIES` unset, forwarded headers never affect
      `source_ip` or a throttle key.
- [ ] From a trusted peer, a valid `CF-Connecting-IP` (IPv4 or IPv6)
      becomes the client address; a missing, malformed or repeated header
      falls back to the peer address.
- [ ] From an untrusted peer, `CF-Connecting-IP` and `X-Forwarded-For` are
      ignored.
- [ ] IPv4-mapped IPv6 peer and header values are normalized.
- [ ] An invalid `TRUSTED_PROXIES` entry stops startup with the variable
      and entry named.
- [ ] Two clients behind a trusted peer are throttled separately on
      `/auth/local-login`; a forged header from an untrusted peer does not
      escape the throttle.
- [ ] Login, admin and rotation audit rows record the derived address.
- [ ] Every existing test script passes.

## Validation requirements

As listed in CONTRACT-012's Validation requirements for handler tests. The
through-the-tunnel check belongs to TASK-025.

## Risks and assumptions

- **Changed default (CONTRACT-012 OQ-1, decided (a)).** A deployment behind some other
  proxy would start recording the proxy's address until it sets
  `TRUSTED_PROXIES`. None is known.
- **The trust is only as good as the network isolation.** If the Node port
  is ever published, or another container joins the app's compose network,
  a client could forge `CF-Connecting-IP` from a trusted address
  (CONTRACT-012 §4).
- Docker's address for the connector is not fixed, so `TRUSTED_PROXIES`
  must be the pinned compose subnet, not a single address. TASK-025 pins it.

## Blocker

Waiting on Patrick's approval of CONTRACT-012. Its open questions were all
decided on 2026-10-28: forwarded headers are ignored unless
`TRUSTED_PROXIES` is set (OQ-1), and only `CF-Connecting-IP` is read
(OQ-2).

## Implementation handoff

Not started.

## Review

Not reviewed.
