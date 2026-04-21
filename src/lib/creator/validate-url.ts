import { isIP, isIPv4, isIPv6 } from 'node:net';

// SSRF-hardened URL validator. Canonicalizes IPv4 (decimal/octal/hex/short-form),
// strips trailing hostname dots, rejects non-ASCII hostnames, and checks IPv6
// against CIDR blocks by expanding to a 128-bit BigInt. This is submit-time
// validation only — the downstream fetcher MUST re-check + pin DNS at fetch
// time to prevent rebinding (see TODO-SSRF.md).

export class UrlValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'UrlValidationError';
    this.code = code;
  }
}

const DENY_HOSTNAME_EXACT = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

const DENY_HOSTNAME_SUFFIX = ['.local', '.internal', '.localhost', '.home.arpa'];

const IPV4_DENY_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// IPv6 CIDRs as (network BigInt, prefix).
const IPV6_DENY_CIDRS: Array<[bigint, number]> = [
  [ipv6ToBigInt('::'), 128],         // unspecified (exact)
  [ipv6ToBigInt('::1'), 128],        // loopback (exact)
  [ipv6ToBigInt('fc00::'), 7],       // ULA
  [ipv6ToBigInt('fe80::'), 10],      // link-local
  [ipv6ToBigInt('ff00::'), 8],       // multicast
];

export function assertSafePublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlValidationError('invalid_url');
  }

  if (u.protocol !== 'https:') {
    throw new UrlValidationError('insecure_scheme');
  }

  // Only allow default port (empty) or explicit 443 — prevents port-scanning
  // probes to SSH/Redis/Postgres on otherwise-public hosts.
  if (u.port !== '' && u.port !== '443') {
    throw new UrlValidationError('blocked_port');
  }

  // Userinfo (user:pass@host) is a classic phishing + bypass vector.
  if (u.username !== '' || u.password !== '') {
    throw new UrlValidationError('userinfo_forbidden');
  }

  // Canonicalize hostname.
  let hostname = u.hostname.toLowerCase();
  // WHATWG URL preserves [] around IPv6 literals in hostname — strip them.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname === '') throw new UrlValidationError('empty_hostname');

  // WHATWG URL parser auto-punycodes non-ASCII. Treat any xn-- label as an
  // IDN (reject in v1 — no IDN support yet). Also defensively reject any
  // raw non-ASCII if somehow the parser let it through.
  if (/[^\x00-\x7f]/.test(hostname)) {
    throw new UrlValidationError('non_ascii_hostname');
  }
  if (/(^|\.)xn--/.test(hostname)) {
    throw new UrlValidationError('non_ascii_hostname');
  }

  // IPv6 literal (brackets already stripped).
  if (isIPv6(hostname)) {
    // Canonicalize mixed notation ::ffff:a.b.c.d → ::ffff:xxxx:xxxx.
    const canonical = canonicalizeIpv6(hostname);
    if (isIpv6InDenyList(canonical)) throw new UrlValidationError('private_address');

    // IPv4-mapped IPv6: recurse through IPv4 check regardless of deny-list hit.
    const mapped = ipv6ExtractMappedIpv4(canonical);
    if (mapped && isIpv4InDenyList(mapped)) {
      throw new UrlValidationError('private_address');
    }
    return u;
  }

  // IPv4 literal — try dotted-quad first, then non-standard forms.
  if (isIPv4(hostname)) {
    if (isIpv4InDenyList(hostname)) throw new UrlValidationError('private_address');
    return u;
  }

  const coercedIpv4 = coerceToIpv4(hostname);
  if (coercedIpv4) {
    if (isIpv4InDenyList(coercedIpv4)) throw new UrlValidationError('private_address');
    return u;
  }

  // Name-based blocklist.
  if (DENY_HOSTNAME_EXACT.has(hostname)) {
    throw new UrlValidationError('blocked_hostname');
  }
  for (const suffix of DENY_HOSTNAME_SUFFIX) {
    if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
      throw new UrlValidationError('blocked_hostname');
    }
  }

  return u;
}

// Coerce decimal/octal/hex/short-form IPv4 strings to canonical dotted-quad.
// Returns null if the string isn't a recognizable IPv4 numeric form.
function coerceToIpv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  // Each part must parse to an integer (decimal, octal 0-prefixed, hex 0x-prefixed).
  const nums: bigint[] = [];
  for (const p of parts) {
    if (p === '' || p.length > 16) return null;
    let n: bigint;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      n = BigInt('0x' + p.slice(2));
    } else if (/^0[0-7]+$/.test(p)) {
      n = BigInt('0o' + p.slice(1));
    } else if (/^[0-9]+$/.test(p)) {
      n = BigInt(p);
    } else {
      return null;
    }
    nums.push(n);
  }

  // Pack into a single 32-bit integer per inet_aton rules.
  // Each leading part occupies one octet; the last part fills remaining octets.
  let packed: bigint;
  const last = nums[nums.length - 1];
  const leading = nums.slice(0, -1);
  const leadingOctets = leading.length;
  const remainingBits = (4 - leadingOctets) * 8;
  const maxLast = 1n << BigInt(remainingBits);

  for (const p of leading) {
    if (p < 0n || p > 255n) return null;
  }
  if (last < 0n || last >= maxLast) return null;

  packed = 0n;
  for (let i = 0; i < leadingOctets; i++) {
    packed = (packed << 8n) | leading[i];
  }
  packed = (packed << BigInt(remainingBits)) | last;

  if (packed > 0xffffffffn) return null;

  const a = Number((packed >> 24n) & 0xffn);
  const b = Number((packed >> 16n) & 0xffn);
  const c = Number((packed >> 8n) & 0xffn);
  const d = Number(packed & 0xffn);
  const canonical = `${a}.${b}.${c}.${d}`;
  if (!isIPv4(canonical)) return null;
  return canonical;
}

function isIpv4InDenyList(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // parse failure → fail closed
  for (const [net, prefix] of IPV4_DENY_CIDRS) {
    const netInt = ipv4ToInt(net);
    if (netInt === null) continue;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if ((n & mask) === (netInt & mask)) return true;
  }
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function isIpv6InDenyList(ip: string): boolean {
  const n = ipv6ToBigInt(ip);
  for (const [net, prefix] of IPV6_DENY_CIDRS) {
    const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
    if ((n & mask) === (net & mask)) return true;
  }
  return false;
}

function canonicalizeIpv6(ip: string): string {
  // Convert mixed notation like ::ffff:127.0.0.1 into ::ffff:7f00:0001.
  const mixedMatch = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (!mixedMatch) return ip;
  const prefix = mixedMatch[1];
  const quad = mixedMatch[2].split('.').map((s) => parseInt(s, 10));
  if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return ip;
  const hi = ((quad[0] << 8) | quad[1]).toString(16).padStart(4, '0');
  const lo = ((quad[2] << 8) | quad[3]).toString(16).padStart(4, '0');
  return `${prefix}${hi}:${lo}`;
}

function ipv6ToBigInt(ip: string): bigint {
  // Expand :: shorthand to full 8 groups.
  if (!isIP(ip) && ip !== '::' && ip !== '::1') return 0n;
  const hasDouble = ip.includes('::');
  let head: string[];
  let tail: string[] = [];
  if (hasDouble) {
    const [h, t] = ip.split('::');
    head = h === '' ? [] : h.split(':');
    tail = t === '' ? [] : t.split(':');
  } else {
    head = ip.split(':');
  }
  const zeros = 8 - head.length - tail.length;
  const full = [...head, ...Array(zeros).fill('0'), ...tail];
  let out = 0n;
  for (const g of full) {
    out = (out << 16n) | BigInt(parseInt(g || '0', 16));
  }
  return out;
}

function ipv6ExtractMappedIpv4(ip: string): string | null {
  // ::ffff:a.b.c.d — upper 80 bits zero, next 16 bits 0xffff, lower 32 bits IPv4.
  const n = ipv6ToBigInt(ip);
  const upper96 = n >> 32n;
  if (upper96 === 0xffffn) {
    const low = Number(n & 0xffffffffn);
    const a = (low >>> 24) & 0xff;
    const b = (low >>> 16) & 0xff;
    const c = (low >>> 8) & 0xff;
    const d = low & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }
  return null;
}
