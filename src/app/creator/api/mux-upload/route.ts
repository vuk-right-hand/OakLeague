// POST /creator/api/mux-upload — creator mints a Mux direct-upload URL for
// their OWN hook or long-form (CREATOR_STUDIO WS6). Sibling of the admin mint
// route, NOT a wrapper (the trap): creator-scoped auth, ownership joins,
// NO welcome_hook target, per-creator rate limit, and a total long-form
// minutes cap (audit M7 — 20 videos alone doesn't bound Mux COGS; minutes do).

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createDirectUpload } from '@/lib/mux/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  target: z.enum(['hook', 'video_long_form']),
  id: z.string().uuid(),
});

const MINTABLE_STATES = new Set(['pending', 'failed']);
const MAX_LONG_FORM_MINUTES = 600; // audit M7: minutes, not asset count, bound Mux COGS

export async function POST(req: Request): Promise<Response> {
  let creator: { userId: string; creatorId: string };
  try {
    creator = await assertCreatorFromSession();
  } catch (err) {
    if (err instanceof AuthGuardError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (!req.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ error: 'unsupported content-type' }, { status: 415 });
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const { target, id } = parsed.data;
  const sb = supabaseAdmin();

  // 20 mints/min/creator (mirrors admin M5 — burned upload URLs are billable).
  const { data: allowed, error: rlErr } = await sb.rpc('rate_limit_hit', {
    p_scope: 'creator_mux_upload',
    p_key: creator.userId,
    p_window: '1 minute',
    p_limit: 20,
  });
  if (rlErr) return NextResponse.json({ error: 'rate_limit_failed' }, { status: 500 });
  if (allowed === false) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  // Ownership + row state. Service-role bypasses RLS → the joins below ARE
  // the security boundary (audit M6).
  let passthrough: string;
  let status: string;
  let table: 'hooks' | 'videos';
  let statusCol: string;
  let uploadIdCol: string;

  if (target === 'hook') {
    const { data: row } = await sb
      .from('hooks')
      .select('id, mux_passthrough, mux_status, videos!inner(creator_id)')
      .eq('id', id)
      .eq('videos.creator_id', creator.creatorId)
      .maybeSingle<{ id: string; mux_passthrough: string; mux_status: string }>();
    if (!row) return NextResponse.json({ error: 'row not found' }, { status: 404 });
    passthrough = row.mux_passthrough;
    status = row.mux_status;
    table = 'hooks'; statusCol = 'mux_status'; uploadIdCol = 'mux_upload_id';
  } else {
    const { data: row } = await sb
      .from('videos')
      .select('id, long_form_mux_passthrough, long_form_mux_status, admin_removed_at')
      .eq('id', id)
      .eq('creator_id', creator.creatorId)
      .maybeSingle<{
        id: string; long_form_mux_passthrough: string;
        long_form_mux_status: string; admin_removed_at: string | null;
      }>();
    if (!row) return NextResponse.json({ error: 'row not found' }, { status: 404 });
    if (row.admin_removed_at) return NextResponse.json({ error: 'admin_removed' }, { status: 403 });
    passthrough = row.long_form_mux_passthrough;
    status = row.long_form_mux_status;
    table = 'videos'; statusCol = 'long_form_mux_status'; uploadIdCol = 'long_form_mux_upload_id';

    // Minutes cap (audit M7): sum of existing ready/processing long-form for
    // this creator. A fresh mint that could push past the cap is refused.
    const { data: durs } = await sb
      .from('videos')
      .select('long_form_mux_duration_ms')
      .eq('creator_id', creator.creatorId)
      .not('long_form_mux_duration_ms', 'is', null);
    const usedMin =
      (durs ?? []).reduce((a, r) => a + (Number(r.long_form_mux_duration_ms) || 0), 0) / 60000;
    if (usedMin >= MAX_LONG_FORM_MINUTES) {
      return NextResponse.json({ error: 'long_form_minutes_quota' }, { status: 429 });
    }
  }

  if (!MINTABLE_STATES.has(status)) {
    return NextResponse.json(
      { error: `cannot mint upload from state '${status}' — reset first` },
      { status: 409 },
    );
  }

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const upload = await createDirectUpload({ passthrough, corsOrigin: origin });

  await sb
    .from(table)
    .update({ [uploadIdCol]: upload.uploadId, [statusCol]: 'uploading' })
    .eq('id', id);

  return NextResponse.json({ uploadUrl: upload.uploadUrl, uploadId: upload.uploadId });
}
