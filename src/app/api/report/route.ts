// POST /api/report — public content report (CREATOR_STUDIO audit C3
// mitigation). The counterweight to no-per-video-approval: anyone (anon
// included) can flag a hook/video/creator/comment; admins triage in the
// console. Writes content_reports via service-role (table is deny-all).

import 'server-only';
import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { isSameOrigin, json } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  target_kind: z.enum(['hook', 'video', 'creator', 'comment']),
  target_id: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

function normalizeIp(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
  const isV6 = v.includes(':') && /^[0-9a-fA-F:.]+$/.test(v);
  return isV4 || isV6 ? v : null;
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'bad_content_type' });
  }
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return json(400, { error: 'bad_json' }); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return json(400, { error: 'invalid_input' });

  const ip = normalizeIp(
    req.headers.get('x-real-ip') ||
    req.headers.get('x-vercel-forwarded-for') ||
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0] || '',
  );

  const sb = supabaseAdmin();
  // 5 reports/min per IP bucket (junk IPs collapse to one shared bucket).
  const { data: allowed, error: rlErr } = await sb.rpc('rate_limit_hit', {
    p_scope: 'content_report',
    p_key: ip ?? 'no-ip',
    p_window: '1 minute',
    p_limit: 5,
  });
  if (rlErr) return json(500, { error: 'rate_check_failed' });
  if (allowed === false) return json(429, { error: 'rate_limited' });

  const reporterUserId = await getCallerUserId(); // null for anon — allowed

  const { error } = await sb.from('content_reports').insert({
    target_kind: parsed.data.target_kind,
    target_id: parsed.data.target_id,
    reason: parsed.data.reason || null,
    reporter_user_id: reporterUserId,
    created_ip: ip,
  });
  if (error) return json(500, { error: 'insert_failed' });
  return json(200, { ok: true });
}
