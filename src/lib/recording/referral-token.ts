// Referral token HMAC primitive — Day-4 React/duet capture.
//
// Mirrors src/lib/invite-tokens.ts (HMAC + rotation) but uses Crockford base32
// plaintext rather than base64url so the share URL `oakl.gg/r/<token>` reads
// cleanly when typed by hand from a screen-recorded video. 96-bit (12 byte)
// random tokens → 20 chars Crockford base32, no padding, URL-safe, no
// confusable {0/O, 1/I/L} pairs.
//
// Plan §8a + §23.7-8.
//
// ── Threat model ──────────────────────────────────────────────────────────
// 1. Token guess: 96-bit random. ~5e28 search space. Brute force blocked by
//    DB lookup costs + rate-limit; full enumeration is infeasible.
// 2. Token leak via end-card OCR: legitimate (the URL is meant to be public).
//    The redeemed_count + last_redeemed_at is a fraud signal, not a gate.
// 3. Replay: HMAC stored, plaintext returned to client once. Revocation flips
//    expires_at = now(). Server validates expires_at > now() on every redeem.
// 4. Server compromise: HMAC secret leak → attacker can mint hashes that
//    match arbitrary plaintexts. Rotation strategy: env-based dual-secret
//    (CURRENT + NEXT) so an emergency rotation does not break in-flight
//    minted tokens during the overlap window.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford base32 alphabet — excludes I, L, O, U.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Mint a fresh plaintext + its CURRENT-secret HMAC. The plaintext is
 *  sent to the client once and never stored. */
export function mintReferralToken(): { plaintext: string; tokenHash: string } {
  const secret = requiredSecret('RECORDING_REFERRAL_HMAC_SECRET_CURRENT');
  const plaintext = crockfordEncode(randomBytes(12));
  const tokenHash = hmacHex(secret, plaintext);
  return { plaintext, tokenHash };
}

/** Compute the candidate token_hash values for a given plaintext, trying
 *  CURRENT then NEXT (in that order). Used at validation-time (route
 *  handler hits the DB with each in turn). Returns 0–2 hashes. */
export function candidateTokenHashes(plaintext: string): string[] {
  const out: string[] = [];
  const cur = process.env.RECORDING_REFERRAL_HMAC_SECRET_CURRENT;
  const nxt = process.env.RECORDING_REFERRAL_HMAC_SECRET_NEXT;
  if (cur) out.push(hmacHex(cur, plaintext));
  if (nxt) out.push(hmacHex(nxt, plaintext));
  return out;
}

/** Constant-time hex compare. Wrap timingSafeEqual to handle length mismatch
 *  (the underlying primitive throws on unequal length). */
export function constantTimeHexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  // Reject any non-hex character so a malformed input can't slip past length.
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Build the share URL. Centralized so the in-video end-card and the
 *  /r/[token] landing handler agree on the format byte-for-byte. */
export function shareUrlForToken(plaintext: string): string {
  // Bare-minimum host. Configurable via env so prod uses oakl.gg and
  // staging uses staging.oakl.gg without hardcoding. Falls back to a
  // sensible default if env missing (dev / tests).
  const host = process.env.NEXT_PUBLIC_REFERRAL_HOST || 'oakl.gg';
  return `${host}/r/${plaintext}`;
}

/** Validate a plaintext is well-formed without hitting the DB. Cheap
 *  pre-filter for the route handler so a malformed URL doesn't produce
 *  an SQL injection surface or a wasted RPC call. */
export function isValidTokenPlaintext(plaintext: string): boolean {
  // Crockford base32, 20 chars (12 bytes input → ceil(96/5) = 20 chars).
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(plaintext);
}

// ── helpers ───────────────────────────────────────────────────────────────

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function requiredSecret(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is required to mint referral tokens`);
  return v;
}

function crockfordEncode(bytes: Buffer): string {
  // Standard MSB-first base32. Output length for n bytes = ceil(n*8/5).
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  }
  return out;
}
