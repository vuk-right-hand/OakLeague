// /api/recording/open-check — POST. Mints a referral token for the user
// at recording arm-time AFTER getUserMedia has resolved (audit C2 Day 4 —
// minting before permission burns tokens on every denied prompt). The
// recording controller fetches this in its onTap path between the
// permission grant and recorder.start, then patches the compositor's
// referralUrl so the in-video end-card URL is identical to the share-modal
// URL (Plan R3-M3).
//
// Per-user daily mint cap (default 20/day, admin-flippable via
// profiles.recording_share_daily_cap) enforced atomically inside the RPC
// recording_referral_mint. On cap hit we return 429 with reason =
// 'daily_share_cap'; the client degrades gracefully to recording without
// a referral token (audit M3 Day 4 — record without share is still a win).
//
// NEXT_PUBLIC_REACT_CAPTURE_ENABLED gate kept consistent with the
// permission lib: feature off → 404 (the route doesn't exist as far as the
// world knows). Audit Plan §20.10 (kill-switch defense in depth).

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin } from '@/lib/session/http-helpers';
import { mintReferralToken, shareUrlForToken } from '@/lib/recording/referral-token';

type Body = {
  creator_id?: unknown;
  clip_id?: unknown; // hook_id or video_id
};

function asUuid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

export async function POST(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED !== '1') {
    return new Response(null, { status: 404 });
  }
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const creatorId = asUuid(body.creator_id);
  const clipId    = asUuid(body.clip_id);
  if (!creatorId || !clipId) return json(400, { error: 'bad_params' });

  // Mint plaintext + hash. Plaintext returned to client; hash sent to RPC.
  const { plaintext, tokenHash } = mintReferralToken();

  const admin = supabaseAdmin();
  const { data: minted, error } = await admin.rpc('recording_referral_mint', {
    p_user:       callerUserId,
    p_creator:    creatorId,
    p_clip:       clipId,
    p_token_hash: tokenHash,
  });

  if (error) {
    // Discriminate profile_not_found (42704) from generic mint failures so
    // the client doesn't retry on a permanent error (audit M3 Day-4-fix).
    // PostgresError.code is forwarded by supabase-js as `code`.
    if ((error as { code?: string }).code === '42704') {
      return json(409, { error: 'profile_missing' });
    }
    Sentry.captureException(error, { extra: { op: 'recording_referral_mint', user_id: callerUserId } });
    return json(500, { error: 'mint_failed' });
  }
  if (minted === false) {
    // Daily cap hit. Return 429 with a structured reason; client shows a
    // toast and proceeds with a generic end-card (no referral token).
    return json(429, { error: 'daily_share_cap' });
  }

  return json(200, {
    token: plaintext,
    short_url: shareUrlForToken(plaintext),
  });
}
