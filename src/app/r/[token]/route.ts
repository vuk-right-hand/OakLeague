// Day 4 — referral landing.
//
// REACT_DUET_PLAN §12 + §23.7.
//
// Audit C1 Day 4: This is a Route Handler (not a Server Component) because
// the Sec-Fetch-Dest gate must return raw 204 / redirect responses, and a
// Server Component can only return JSX. Route handlers serve URLs that
// preview-fetchers and image preloaders may hit; we must answer 204 to those
// without writing a redemption row, otherwise self-credit via
// `<img src="/r/my-token">` is a free credit harvest (audit R3-M1).
//
// Flow on a real navigation:
//   1. Sec-Fetch-Dest gate — 204 if not 'document'.
//   2. Validate plaintext format (cheap pre-filter).
//   3. Validate against DB — try CURRENT then NEXT secret hashes.
//   4. Set httpOnly 'oak_ref' cookie with the token plaintext (90d).
//   5. Insert referral_redemptions(credit_event='landing'). Idempotent on
//      (token_hash, device_fp) for anon visitors.
//   6. 302 redirect to `/`. Day 5 will redirect to the creator's drawer.
//
// Cookie failure (Safari ITP / private mode) is recorded via cookie_set_ok
// = false (audit M7 Day 4) — a redemption row still exists for fraud-review,
// but first_session credit will not fire because /api/sessions/open won't
// see the cookie.

import 'server-only';
import { type NextRequest, NextResponse, after } from 'next/server';
import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  candidateTokenHashes,
  isValidTokenPlaintext,
} from '@/lib/recording/referral-token';
import { captureServerSafe } from '@/lib/posthog-server';

export const dynamic = 'force-dynamic';

const COOKIE_NAME = 'oak_ref';
const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60; // 90d, matches token expires_at default

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  // Audit R3-M1: only credit on document navigations. Image/preload/fetch
  // don't get credited; they 204 without a side effect.
  const dest = req.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') {
    return new Response(null, { status: 204 });
  }

  const { token: plaintext } = await params;

  if (!isValidTokenPlaintext(plaintext)) {
    // Malformed token URL — silently 404 to / so the user lands somewhere
    // useful. Don't leak "this URL would be valid if you tried harder."
    return NextResponse.redirect(new URL('/', req.url), { status: 302 });
  }

  const hashes = candidateTokenHashes(plaintext);
  if (hashes.length === 0) {
    // No HMAC secrets configured (dev / misconfig). Surface to Sentry but
    // still redirect — landing is a soft credit, not a hard gate.
    Sentry.captureMessage('referral_landing_no_hmac_secret');
    return NextResponse.redirect(new URL('/', req.url), { status: 302 });
  }

  // Device fingerprint + IP prefix (first 3 octets only — privacy + dorm-room
  // false positive avoidance per plan §8a). UA + accept-language + the IP
  // /24 are signal-only; not enforced.
  const ua = req.headers.get('user-agent') ?? '';
  const accept = req.headers.get('accept-language') ?? '';
  const xff = req.headers.get('x-forwarded-for') ?? '';
  const ip = xff.split(',')[0]?.trim() ?? '';
  const ipPrefix = ip.includes('.') ? ip.split('.').slice(0, 3).join('.') : ip.split(':').slice(0, 4).join(':');
  const deviceFp = createHash('sha256').update(`${ua}|${accept}|${ipPrefix}`).digest('hex').slice(0, 32);

  const admin = supabaseAdmin();
  let creatorId: string | null = null;

  // Try CURRENT then NEXT — same rotation pattern as mint.
  for (const tokenHash of hashes) {
    const { data, error } = await admin.rpc('recording_referral_redeem_landing', {
      p_token_hash:    tokenHash,
      p_device_fp:     deviceFp,
      p_ip_prefix:     ipPrefix,
      p_cookie_set_ok: true, // optimistic; client-side tracking would correct, but we don't have that yet
    });
    if (error) {
      Sentry.captureException(error, { extra: { op: 'recording_referral_redeem_landing' } });
      continue;
    }
    if (data) { creatorId = data as string; break; }
  }

  // PostHog landing event (plan §11). Wrapped in after() so the user's
  // 302 redirect is NOT blocked on the PostHog flush — landing is the
  // first thing a referred visitor sees and the cold-start critical path.
  // distinctId = device_fp for anon visitors; ref_id_prefix is the first
  // 6 chars of the plaintext (non-secret per Plan §S10 — full token has
  // 96 bits of entropy, prefix is analytics-only).
  if (creatorId) {
    after(async () => {
      await captureServerSafe(deviceFp, 'referral_landing', {
        ref_id_prefix: plaintext.slice(0, 6),
        creator_id: creatorId,
        // Mirror cookie_set_ok column so dashboards can split landing
        // volume by Safari ITP / private-mode failure rate later.
        cookie_set_ok: true,
      });
    });
  }

  // Even if no token_hash matched (invalid / expired), still redirect to
  // home. Don't reveal token validity. Cookie is set unconditionally so
  // first_session promotion can still fire if the redemption row exists from
  // an earlier landing.
  const res = NextResponse.redirect(new URL('/', req.url), { status: 302 });
  // Audit C3 Day-4-fix: if NEXT_PUBLIC_REFERRAL_HOST and NEXT_PUBLIC_SITE_URL
  // resolve to different (sub)domains in prod, the cookie set on the referral
  // host won't be visible on the app host. Setting `domain` to the public
  // suffix's parent shares the cookie across subdomains. Local dev (localhost)
  // ignores domain attributes that don't match the request host, so leave
  // unset there.
  const cookieDomain = process.env.RECORDING_COOKIE_DOMAIN || undefined;
  res.cookies.set(COOKIE_NAME, plaintext, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_S,
    path: '/',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
  void creatorId; // Day 5 — use creatorId to redirect to creator drawer instead of '/'
  return res;
}
