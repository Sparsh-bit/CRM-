/**
 * SSRF guard shared by every outbound fetch in the research pipeline
 * (WebFetchService, the Instagram OG-tag fetch). A URL is validated before
 * the FIRST request AND before every redirect hop — a public hostname that
 * resolves to a public IP today can still redirect to a private one, so
 * checking once at the top is not enough.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';

export class UnsafeAddressError extends Error {}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** IPv4 ranges that are never a legitimate target for a "fetch this public page" request. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — refuse, don't guess
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — includes the 169.254.169.254 cloud metadata endpoint
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  return false;
}

/** IPv6 ranges: loopback, link-local, unique-local, and the IPv4-mapped form of the above. */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  return net.isIP(ip) === 4 ? isPrivateIPv4(ip) : net.isIP(ip) === 6 ? isPrivateIPv6(ip) : true;
}

/**
 * Resolves the hostname and throws UnsafeAddressError if it's a blocked name
 * or if ANY resolved address is private/reserved — a hostname that resolves
 * to both a public and a private IP (DNS rebinding) is refused outright
 * rather than racing which address the eventual fetch happens to use.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower) || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new UnsafeAddressError(`"${hostname}" is a blocked/internal hostname.`);
  }
  // A literal IP in the URL skips DNS lookup entirely.
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new UnsafeAddressError(`"${hostname}" is a private/reserved address.`);
    return;
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new UnsafeAddressError(`Could not resolve "${hostname}": ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!records.length) throw new UnsafeAddressError(`"${hostname}" resolved to no addresses.`);
  for (const r of records) {
    if (isPrivateOrReservedIp(r.address)) {
      throw new UnsafeAddressError(`"${hostname}" resolves to a private/reserved address (${r.address}).`);
    }
  }
}

/** Full URL validation: scheme + hostname, used before the initial request and before following each redirect. */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeAddressError(`"${rawUrl}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeAddressError(`Unsupported URL scheme "${url.protocol}" — only http/https are allowed.`);
  }
  await assertPublicHostname(url.hostname);
  return url;
}
