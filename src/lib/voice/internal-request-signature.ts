// internal-request-signature.ts — HMAC envelope for the Fly proxy ↔ Vercel
// internal-trust channel (Day-13 audit C2).
//
// The /api/internal/retrieve-knowledge route is publicly addressable on
// Vercel and accepts a user_id from the request body that authorizes a
// budget increment + cogs_log write. Plain Bearer auth is insufficient
// because a single leaked secret (Sentry screenshot, support log, stray
// .env) becomes:
//   * cross-tenant retrieval-pwnage (read any creator's parents)
//   * any-user budget-burn (200/day cap exhaustion)
//   * unlimited cogs_log mis-attribution
//   * unbounded replay (no nonce, no timestamp)
//
// This module produces and verifies a signed envelope:
//
//   X-Internal-Timestamp:  <unix-seconds, integer string>
//   X-Internal-Body-Sha256: <hex sha256 of the raw request body bytes>
//   Authorization:         Bearer <hex hmacSha256(SECRET, method|path|timestamp|bodyHash)>
//
// Verification gates:
//   1. timestamp within ±SKEW_SECONDS of server now (default 60s)
//   2. body-hash matches recomputed sha256(raw body bytes)
//   3. constant-time HMAC equality of Authorization vs expected
//
// Replay resistance: timestamp window. Per CLAUDE.md "production from line
// one" we do NOT yet add a server-side seen-nonce store (Redis would be
// the right thing at scale; for dogfood the 60s window is acceptable and
// each request is single-shot — the proxy never retries (audit M3)).
//
// SECRET rotation: INTERNAL_API_SECRET is shared between Fly proxy + Vercel
// route. Rotation is "set new secret on both, redeploy". The HMAC is
// computed at signing time and verified at receive time; nothing is
// stored, so rotation = atomic env flip + redeploy.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Acceptable clock-skew window in seconds. Fly and Vercel are NTP-synced
 * but routinely drift ±50-200ms in practice; a 60s window leaves headroom
 * for clock drift, NTP step-corrections, and HTTP round-trip latency.
 * Below 30s we start rejecting legitimate requests during DST transitions
 * or DC failovers; above 300s the replay window becomes meaningfully
 * exploitable to anyone watching the wire.
 */
export const INTERNAL_SIGNATURE_SKEW_SECONDS = 60;

/** Minimum acceptable secret length — short secrets are brute-force-attackable. */
export const INTERNAL_SECRET_MIN_LENGTH = 32;

export type SignedHeaders = {
  Authorization: string;
  'X-Internal-Timestamp': string;
  'X-Internal-Body-Sha256': string;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_body_hash' | 'bad_signature' };

/**
 * Compute sha256 hex of raw request body bytes. Caller MUST pass the
 * exact bytes that go over the wire (post-JSON.stringify) — any whitespace
 * difference between sign and verify breaks the hash.
 */
export function bodyHashHex(body: string | Buffer | Uint8Array): string {
  const h = createHash('sha256');
  h.update(body);
  return h.digest('hex');
}

/**
 * Sign an outbound request. Caller serializes the body to a string FIRST,
 * passes the exact same string here as `bodySerialized`, then sends both
 * the headers and body bytes-identical to what was signed.
 *
 * Throws if `secret` is shorter than INTERNAL_SECRET_MIN_LENGTH chars —
 * fail-loud at module use, not at the HMAC layer.
 */
export function signRequest(args: {
  secret: string;
  method: string;
  path: string;
  bodySerialized: string;
  timestampSec?: number; // for tests
}): SignedHeaders {
  if (typeof args.secret !== 'string' || args.secret.length < INTERNAL_SECRET_MIN_LENGTH) {
    throw new Error(
      `INTERNAL_API_SECRET must be at least ${INTERNAL_SECRET_MIN_LENGTH} chars (got ${args.secret?.length ?? 0})`,
    );
  }
  const ts = args.timestampSec ?? Math.floor(Date.now() / 1000);
  const bh = bodyHashHex(args.bodySerialized);
  const sig = createHmac('sha256', args.secret)
    .update(`${args.method.toUpperCase()}|${args.path}|${ts}|${bh}`)
    .digest('hex');
  return {
    Authorization: `Bearer ${sig}`,
    'X-Internal-Timestamp': String(ts),
    'X-Internal-Body-Sha256': bh,
  };
}

/**
 * Verify an inbound request. Returns { ok: true } if the request is
 * authentic and fresh; otherwise { ok: false, reason: ... } with a typed
 * reason for telemetry. Callers should return 401 on all non-ok reasons
 * — do NOT leak the reason to the client (that gives an attacker a probe
 * oracle). The reason is for server-side logging only.
 *
 * `nowSec` is injectable for testing. Default = current wall clock.
 */
export function verifyRequest(args: {
  secret: string;
  method: string;
  path: string;
  rawBody: string | Buffer | Uint8Array;
  headers: {
    authorization?: string | null;
    'x-internal-timestamp'?: string | null;
    'x-internal-body-sha256'?: string | null;
  };
  nowSec?: number;
  skewSec?: number;
}): VerifyResult {
  if (typeof args.secret !== 'string' || args.secret.length < INTERNAL_SECRET_MIN_LENGTH) {
    throw new Error(
      `INTERNAL_API_SECRET must be at least ${INTERNAL_SECRET_MIN_LENGTH} chars`,
    );
  }
  const auth = args.headers.authorization ?? '';
  const tsStr = args.headers['x-internal-timestamp'] ?? '';
  const bhStr = args.headers['x-internal-body-sha256'] ?? '';
  if (!auth.startsWith('Bearer ') || !tsStr || !bhStr) {
    return { ok: false, reason: 'missing_headers' };
  }
  const ts = Number(tsStr);
  if (!Number.isInteger(ts) || ts <= 0) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = args.skewSec ?? INTERNAL_SIGNATURE_SKEW_SECONDS;
  if (Math.abs(now - ts) > skew) {
    return { ok: false, reason: 'stale' };
  }
  // Recompute body hash from the bytes we actually received. Equality of
  // the hex string is fine here (the hash is non-secret); the SIGNATURE
  // check below is what enforces integrity.
  const expectedBodyHash = bodyHashHex(args.rawBody);
  if (expectedBodyHash !== bhStr) {
    return { ok: false, reason: 'bad_body_hash' };
  }
  const expectedSig = createHmac('sha256', args.secret)
    .update(`${args.method.toUpperCase()}|${args.path}|${ts}|${bhStr}`)
    .digest('hex');
  const provided = auth.slice('Bearer '.length);
  // timingSafeEqual requires equal-length buffers; pad shorter side with
  // zeros so the comparison itself never short-circuits on length.
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSig);
  // audit-build S10: pin expected length to sha256-hex = 64. A future
  // algorithm change on one side (e.g. sha512 → 128 chars) would otherwise
  // leak the algorithm via length-only side-channel. Refuse anything that
  // isn't exactly the expected hex length up front.
  if (a.length !== 64 || b.length !== 64) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
