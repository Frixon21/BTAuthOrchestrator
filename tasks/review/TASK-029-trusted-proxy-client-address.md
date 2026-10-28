# TASK-029: Trusted-proxy client address for Cloudflare Tunnel

Owner role: Implementer
Assigned agent: Claude
Proposed by: Patrick Moon
Proposed date: 2026-10-28
Approved by: Patrick Moon
Approved date: 2026-10-20
Related contracts: CONTRACT-012 (Approved 2026-10-28; §2-§3 are this task's
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

None. CONTRACT-012 was approved on 2026-10-28: forwarded headers are
ignored unless `TRUSTED_PROXIES` is set (OQ-1), and only `CF-Connecting-IP`
is read (OQ-2).

## Implementation handoff

Completed 2026-10-28 against CONTRACT-012 §2-§3.

### Changes

- New `src/clientAddress.ts`: `parseTrustedProxies` (validation, reporting
  each bad entry), `createClientAddressResolver` (the §2 rule, using Node's
  built-in `net.BlockList` and `net.isIP`; no new dependency),
  `normalizeAddress` and `formatTrustedProxies`.
- `src/config.ts`: optional `TRUSTED_PROXIES` parsed into
  `config.trustedProxies`; a bad entry fails startup through the existing
  "invalid environment variable(s)" error.
- `src/index.ts`: the old module-level `extractSourceIp` (first
  `X-Forwarded-For` entry from any peer) is replaced by a per-handler
  resolver with the same name and signature, so all nine call sites
  (login, password change, admin audit, emergency rotation) are unchanged.
  The startup log line adds `trustedProxies=`.
- `.env.example` and `docs/DEVELOPMENT.md` document the setting and the new
  default.
- New `scripts/test-trusted-proxies.js`.
- `scripts/test-local-password-change.js` set each simulated client's
  address through `X-Forwarded-For`, which is now ignored by design; it now
  sets the connection's peer address instead. Its assertions are unchanged.

### Validation

`npm run build`, then all six test scripts pass:
`test-trusted-proxies.js`, `test-console-sign-in.js`,
`test-admin-console.js`, `test-api-docs.js`,
`test-local-password-change.js`, `test-local-registration.js`. The new
script covers each CONTRACT-012 Validation requirement for handler tests:
every §2 row (unset, untrusted peer with forged headers, trusted peer with
IPv4 and IPv6 values, missing/malformed/repeated header, mapped addresses,
the range boundary), startup validation for ten kinds of bad entry, separate
throttling of two clients behind the connector, a forged header not escaping
the throttle without `TRUSTED_PROXIES`, and the derived address in login,
admin and rotation audit rows. The through-the-tunnel check belongs to
TASK-025.

### Implementation judgment calls

1. **Repeated `CF-Connecting-IP`.** Node joins repeated headers into one
   comma-separated string, which fails the IP check, so the peer address is
   used, as §2 step 5 requires. An array value is also treated as repeated.
2. **IPv4-mapped entries in `TRUSTED_PROXIES`** (`::ffff:a.b.c.d`) are
   normalized to IPv4 like peer addresses.
3. **IPv6 values** are kept as written after trimming (not re-compressed),
   so the same client could appear in two spellings only if Cloudflare
   changed its formatting.
4. **A peer that is not an IP literal** (not expected from Node) is used as
   is, as before.

## Review

Not reviewed.
