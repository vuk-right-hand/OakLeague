// POST /api/admin/creator-consent — record out-of-band creator consent.
//
// FIVE_CREATOR_ONBOARDING_READINESS P0-3 (admin override). When a creator
// consented to voice cloning / likeness use via email or call, an admin
// records it here so the voice-clone / face-upload routes unblock. Writes a
// creator_consents row (source='admin_attestation') + an admin_audit_log row
// via admin_attest_creator_consent (migration 20260523000007).
//
// Calls the RPC via the JWT-bound supabaseServer() client so auth.uid()
// resolves inside _assert_caller_is_admin() and the audit attribution is the
// real admin (mirrors creator-retrieval-version / creator-publish).

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapAuthGuardStatus } from '@/lib/session/http-helpers';
import { CONSENT_VERSIONS, type ConsentType } from '@/lib/consent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_TYPES = new Set<ConsentType>(['voice_clone', 'likeness', 'content_license', 'tos', 'privacy']);

type Body = { creator_id?: unknown; consent_type?: unknown; action?: unknown };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'bad_content_type' });
  }

  let admin: { userId: string };
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }
  Sentry.setUser({ id: admin.userId });

  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return json(400, { error: 'bad_json' }); }

  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id)
    ? body.creator_id : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  const consentType = typeof body.consent_type === 'string' && CONSENT_TYPES.has(body.consent_type as ConsentType)
    ? (body.consent_type as ConsentType) : null;
  if (!consentType) return json(400, { error: 'bad_consent_type' });

  // attest (default) records consent; revoke withdraws it. Version is always
  // the pinned current value — no caller override (auditor M6: arbitrary
  // version strings pollute the legal record).
  const action: 'attest' | 'revoke' = body.action === 'revoke' ? 'revoke' : 'attest';

  const { supabaseServer } = await import('@/lib/supabase/server');
  const userSb = await supabaseServer();
  const { error } =
    action === 'revoke'
      ? await userSb.rpc('admin_revoke_creator_consent', {
          p_creator_id:   creatorId,
          p_consent_type: consentType,
        })
      : await userSb.rpc('admin_attest_creator_consent', {
          p_creator_id:   creatorId,
          p_consent_type: consentType,
          p_version:      CONSENT_VERSIONS[consentType],
        });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      return json(404, { error: 'creator_not_found' });
    }
    if (error.code === '22023' || msg.includes('bad_consent_type') || msg.includes('bad_version')) {
      return json(400, { error: 'bad_request' });
    }
    if (error.code === '42501') {
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: `admin_${action}_creator_consent`, creator_id: creatorId, consent_type: consentType, admin_user_id: admin.userId },
    });
    return json(500, { error: `${action}_failed` });
  }

  try { revalidatePath(`/admin/creators/${creatorId}`); } catch { /* non-fatal */ }

  return json(200, { ok: true, creator_id: creatorId, consent_type: consentType, action });
}
