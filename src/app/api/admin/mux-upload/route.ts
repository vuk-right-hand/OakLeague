import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createDirectUpload } from '@/lib/mux/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  target: z.enum(['hook', 'welcome_hook']),
  id: z.string().uuid(),
});

// States where minting a direct-upload is safe. Any other state
// (uploading, processing, ready) must go through replaceHookTake.
const MINTABLE_STATES = new Set(['pending', 'failed']);

export async function POST(req: Request): Promise<Response> {
  let session;
  try {
    session = await assertAdminFromSession();
  } catch (err) {
    if (err instanceof AuthGuardError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Content-type pin (audit S7). Mux-upload is a POST with JSON only.
  if (!req.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ error: 'unsupported content-type' }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const { target, id } = parsed.data;
  const admin = supabaseAdmin();

  // 20 mints/min/admin (audit M5). Accidental mint loops in the client would
  // otherwise burn Mux upload URLs — each completed upload is billable.
  const { data: allowed, error: rlErr } = await admin.rpc('rate_limit_hit', {
    p_scope: 'admin_mux_upload',
    p_key: session.userId,
    p_window: '1 minute',
    p_limit: 20,
  });
  if (rlErr) {
    return NextResponse.json({ error: 'rate_limit_failed' }, { status: 500 });
  }
  if (allowed === false) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Look up the row's passthrough UUID — we mint the upload against that
  // exact value so the webhook dispatcher can reverse-lookup the row.
  const table = target === 'hook' ? 'hooks' : 'welcome_hooks';
  const { data: row, error: rowErr } = await admin
    .from(table)
    .select('id, mux_passthrough, mux_status')
    .eq('id', id)
    .maybeSingle<{ id: string; mux_passthrough: string; mux_status: string }>();

  if (rowErr || !row) {
    return NextResponse.json({ error: 'row not found' }, { status: 404 });
  }
  // Audit C2: only pending | failed can mint a fresh direct-upload. For any
  // other state (uploading / processing / ready) the admin must call
  // replaceHookTake which cancels the old asset and regenerates the
  // passthrough UUID — preventing two assets racing the same webhook row.
  if (!MINTABLE_STATES.has(row.mux_status)) {
    return NextResponse.json(
      { error: `cannot mint upload from state '${row.mux_status}' — use replaceHookTake` },
      { status: 409 },
    );
  }

  // Audit S4: pin corsOrigin to NEXT_PUBLIC_SITE_URL. Never trust the
  // Origin header — a third-party page could steer Mux's cors_origin.
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

  const upload = await createDirectUpload({
    passthrough: row.mux_passthrough,
    corsOrigin: origin,
  });

  // Record the upload id immediately (webhook will confirm, but we want
  // the admin UI to show "uploading" right away).
  await admin
    .from(table)
    .update({ mux_upload_id: upload.uploadId, mux_status: 'uploading' })
    .eq('id', id);

  return NextResponse.json({
    uploadUrl: upload.uploadUrl,
    uploadId: upload.uploadId,
  });
}
