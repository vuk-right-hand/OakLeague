// internal-request-signature.js — proxy mirror of
// src/lib/voice/internal-request-signature.ts. Behavior MUST stay
// byte-identical; the canonical TS file has unit-test coverage and any
// change to one MUST land in the other.
//
// Same envelope:
//   X-Internal-Timestamp:    <unix-seconds, integer string>
//   X-Internal-Body-Sha256:  <hex sha256 of the raw request body bytes>
//   Authorization:           Bearer <hex hmac(SECRET, method|path|ts|bodyHash)>
//
// See the TS header for full design rationale (Day-13 audit C2).

import { createHmac, createHash } from 'node:crypto';

export const INTERNAL_SIGNATURE_SKEW_SECONDS = 60;
export const INTERNAL_SECRET_MIN_LENGTH = 32;

export function bodyHashHex(body) {
  const h = createHash('sha256');
  h.update(body);
  return h.digest('hex');
}

/**
 * signRequest({ secret, method, path, bodySerialized, timestampSec? })
 *   → { Authorization, 'X-Internal-Timestamp', 'X-Internal-Body-Sha256' }
 *
 * `bodySerialized` MUST be the byte-identical string sent on the wire
 * (post-JSON.stringify). Any whitespace difference between sign + verify
 * breaks the hash.
 */
export function signRequest({ secret, method, path, bodySerialized, timestampSec }) {
  if (typeof secret !== 'string' || secret.length < INTERNAL_SECRET_MIN_LENGTH) {
    throw new Error(
      `INTERNAL_API_SECRET must be at least ${INTERNAL_SECRET_MIN_LENGTH} chars (got ${secret?.length ?? 0})`,
    );
  }
  const ts = typeof timestampSec === 'number' ? timestampSec : Math.floor(Date.now() / 1000);
  const bh = bodyHashHex(bodySerialized);
  const sig = createHmac('sha256', secret)
    .update(`${method.toUpperCase()}|${path}|${ts}|${bh}`)
    .digest('hex');
  return {
    Authorization: `Bearer ${sig}`,
    'X-Internal-Timestamp': String(ts),
    'X-Internal-Body-Sha256': bh,
  };
}
