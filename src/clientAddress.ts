import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

// CONTRACT-012 §2-§3: the client address used for every audit source_ip and
// for the per-IP sign-in and password-change throttles.

/** One validated TRUSTED_PROXIES entry; a single address has the full prefix. */
export interface TrustedProxyRange {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

// `::ffff:a.b.c.d` is how Node reports an IPv4 peer on a dual-stack socket.
export function normalizeAddress(value: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped !== null && isIP(mapped[1]!) === 4 ? mapped[1]! : value;
}

/**
 * Parses TRUSTED_PROXIES (comma-separated addresses or CIDR ranges). Each bad
 * entry is reported through `invalid` so configuration loading fails closed.
 */
export function parseTrustedProxies(raw: string | undefined, invalid: string[]): TrustedProxyRange[] {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return [];
  const ranges: TrustedProxyRange[] = [];
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    const [rawAddress = "", prefixText, extra] = entry.split("/");
    const address = normalizeAddress(rawAddress);
    const version = isIP(address);
    const maxPrefix = version === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? maxPrefix : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
    if (version === 0 || extra !== undefined || !(prefix >= 0 && prefix <= maxPrefix)) {
      invalid.push(`TRUSTED_PROXIES (invalid entry "${entry}"; expected an IP address or CIDR range)`);
      continue;
    }
    ranges.push({ address, prefix, family: version === 4 ? "ipv4" : "ipv6" });
  }
  return ranges;
}

export function formatTrustedProxies(ranges: readonly TrustedProxyRange[]): string {
  return ranges.length === 0 ? "none" : ranges.map((range) => `${range.address}/${range.prefix}`).join(",");
}

/**
 * CONTRACT-012 §2. Forwarded headers count only when the socket peer is inside
 * TRUSTED_PROXIES, and then only a single valid CF-Connecting-IP value.
 * X-Forwarded-For is never read. Node joins a repeated header into one
 * comma-separated string, which fails the IP check and falls back to the peer.
 */
export function createClientAddressResolver(
  ranges: readonly TrustedProxyRange[],
): (request: IncomingMessage) => string | null {
  const trusted = new BlockList();
  for (const range of ranges) trusted.addSubnet(range.address, range.prefix, range.family);
  return (request) => {
    const rawPeer = request.socket.remoteAddress;
    if (rawPeer === undefined || rawPeer === "") return null;
    const peer = normalizeAddress(rawPeer);
    const peerVersion = isIP(peer);
    if (ranges.length === 0 || peerVersion === 0) return peer;
    if (!trusted.check(peer, peerVersion === 4 ? "ipv4" : "ipv6")) return peer;
    const header = request.headers["cf-connecting-ip"];
    if (typeof header !== "string") return peer;
    const forwarded = normalizeAddress(header.trim());
    return isIP(forwarded) !== 0 ? forwarded : peer;
  };
}
