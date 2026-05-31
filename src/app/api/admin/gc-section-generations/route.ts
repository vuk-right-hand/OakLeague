// /api/admin/gc-section-generations — deferred GC of stale v3 section
// generations (Step-9 audit C2/C3 / M5). Wraps admin_gc_stale_section_generations.
//
//   POST { creator_id } → deletes sections whose section_generation <
//     active_section_generation - 1 per sample (keeps active + immediately-prior
//     for rollback); CASCADE wipes their units + chunks. Recoverable in the
//     sense that it only removes OLD generations — never touches active/prior.
//   GET ?creator_id=X → preview: how many sections WOULD be GC'd (advisory).
//
// Same JWT-bound-client requirement as purge (the RPC asserts admin via
// auth.uid()). Preview computes the per-sample `< active - 1` predicate in JS
// (PostgREST can't compare a column to another table's column in a filter) —
// read-only, admin-gated.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { creator_id?: unknown };

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

  const { supabaseServer } = await import('@/lib/supabase/server');
  const userSb = await supabaseServer();
  const { data, error } = await userSb.rpc('admin_gc_stale_section_generations', {
    p_creator_id: creatorId,
  });

  if (error) {
    if (error.code === '42501') {
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_gc_stale_section_generations', creator_id: creatorId, admin_user_id: admin.userId },
    });
    return json(500, { error: 'gc_failed' });
  }

  try { revalidatePath(`/admin/creators/${creatorId}`); }
  catch (e) {
    Sentry.captureException(e, { extra: { op: 'revalidate_after_gc', creator_id: creatorId } });
  }

  return json(200, { ok: true, creator_id: creatorId, result: data ?? null });
}

// Preview — advisory count of sections a GC WOULD delete. The RPC deletes
// section_generation < active_section_generation - 1 PER SAMPLE; we replicate
// that join in JS (read-only, admin-gated).
export async function GET(req: NextRequest) {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  const creatorId = req.nextUrl.searchParams.get('creator_id');
  if (!creatorId || !UUID_RE.test(creatorId)) return json(400, { error: 'bad_creator_id' });

  const sb = supabaseAdmin();

  // active_section_generation per sample (a creator has a handful of samples —
  // not capped). Sections are capped (code-audit M2: a book-scale corpus could
  // be thousands of rows); if we hit the cap the count is a floor → `capped`
  // flag + the UI shows "≥N". The preview is advisory anyway — the POST returns
  // the authoritative deleted count from the RPC.
  const SECTION_CAP = 1000;
  const { data: samples, error: sErr } = await sb
    .from('sample_content')
    .select('id, active_section_generation')
    .eq('creator_id', creatorId);
  const { data: sections, error: secErr } = await sb
    .from('sample_content_sections')
    .select('sample_id, section_generation')
    .eq('creator_id', creatorId)
    .limit(SECTION_CAP);
  if (sErr || secErr) {
    Sentry.captureException(sErr || secErr, { extra: { op: 'gc_preview', creator_id: creatorId } });
    return json(500, { error: 'preview_failed' });
  }

  const activeBySample = new Map<string, number>();
  for (const s of (samples ?? []) as Array<{ id: string; active_section_generation: number }>) {
    activeBySample.set(s.id, s.active_section_generation);
  }
  let staleSections = 0;
  for (const sec of (sections ?? []) as Array<{ sample_id: string; section_generation: number }>) {
    const active = activeBySample.get(sec.sample_id);
    // Mirror the RPC EXACTLY: s.section_generation < sc.active_section_generation - 1.
    if (active !== undefined && sec.section_generation < active - 1) staleSections += 1;
  }

  const capped = (sections?.length ?? 0) >= SECTION_CAP;
  return json(200, { available: true, stale_sections: staleSections, capped });
}
