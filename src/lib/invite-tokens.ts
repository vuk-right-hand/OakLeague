// Invite token HMAC helpers. Rotation window: CURRENT + NEXT both checked on
// redeem, only CURRENT issued on mint. Overlap must be >= max invite lifetime
// (7d). See plan §Token strategy.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function mintInviteToken(): { token: string; hash: string } {
  const secret = requiredSecret('INVITE_TOKEN_HMAC_SECRET_CURRENT');
  const token = randomBytes(32).toString('base64url');
  const hash = hmacHex(secret, token);
  return { token, hash };
}

/**
 * Returns the set of hashes to try in the atomic redemption UPDATE.
 * Both current and next secrets are tried so a token minted just before a
 * rotation still redeems until the rotation window closes.
 */
export function candidateHashes(token: string): string[] {
  const hashes: string[] = [];
  const cur = process.env.INVITE_TOKEN_HMAC_SECRET_CURRENT;
  const nxt = process.env.INVITE_TOKEN_HMAC_SECRET_NEXT;
  if (cur) hashes.push(hmacHex(cur, token));
  if (nxt) hashes.push(hmacHex(nxt, token));
  return hashes;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function requiredSecret(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is required to mint invite tokens`);
  return v;
}
