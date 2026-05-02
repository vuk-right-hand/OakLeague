// /api/recording/discard — POST. Revokes a referral token (sets expires_at
// = now()) when the user explicitly discards the recording in the preview
// modal. NOT called on RESET / unmount / route-away — those are not
// user-intent discards (audit C3 Day 4: dismissPreview is overloaded; only
// the user-initiated discardByUser path hits this route).
//
// Idempotent on the RPC side (UPDATE WHERE expires_at > now() — second
// call is a no-op).

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin } from '@/lib/session/http-helpers';
import { isValidTokenPlaintext, candidateTokenHashes } from '@/lib/recording/referral-token';

type Body = { token?: unknown };

export async function POST(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED !== '1') {
    return new Response(null, { status: 404 });
  }
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const plaintext = typeof body.token === 'string' ? body.token : '';
  if (!isValidTokenPlaintext(plaintext)) return json(400, { error: 'bad_token' });

  const hashes = candidateTokenHashes(plaintext);
  if (hashes.length === 0) {
    // No HMAC secret configured at runtime — can't revoke. Tell the caller
    // 503 rather than 500; they can drop the token and move on.
    return json(503, { error: 'hmac_not_configured' });
  }

  const admin = supabaseAdmin();
  // Try CURRENT then NEXT — same rotation pattern as mint. The RPC is
  // idempotent (UPDATE WHERE expires_at > now()), so a revoke that already
  // ran is a no-op. Audit M5 Day-4-fix: the original loop kept iterating
  // even after a successful revoke; if the second secret is misconfigured
  // it would surface a spurious 500 on a token that was already revoked.
  // Stop on the first successful no-error response.
  for (const tokenHash of hashes) {
    const { error } = await admin.rpc('recording_referral_revoke', {
      p_user:       callerUserId,
      p_token_hash: tokenHash,
    });
    if (!error) break;
    Sentry.captureException(error, { extra: { op: 'recording_referral_revoke', user_id: callerUserId } });
  }

  return json(200, { ok: true });
}
