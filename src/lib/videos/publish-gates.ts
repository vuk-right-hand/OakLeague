import 'server-only';

// Shared video publish gates (CREATOR_STUDIO audit C4). These rules used to
// live ONLY inside the admin publishLongForm action; with creators publishing
// their own videos (no per-video approval — Vuk 2026-06-12), both actors MUST
// run the identical checks or the two paths drift (a 9:16 or 3-hour long-form
// slips out via whichever path forgot a rule). The DB CHECK is intentionally
// loose (60–3600s, webhook-safe); THIS is the policy boundary.
//
// Callers do their own authz first (assertAdminFromSession / ownership), then
// hand off here. The .is('long_form_published_at', null) filter preserves
// first-publish-wins idempotency (admin audit M4).

type SbClient = ReturnType<typeof import('@/lib/supabase/admin').supabaseAdmin>;

export type LongFormPublishError =
  | 'not_found'
  | 'not_ready'
  | 'duration_out_of_range'
  | 'aspect_ratio_unsupported'
  | 'aspect_ratio_missing'
  | 'admin_removed'
  | string;

export async function publishLongFormGated(
  sb: SbClient,
  videoId: string,
): Promise<{ ok: true } | { ok: false; error: LongFormPublishError }> {
  const { data: row, error: readErr } = await sb
    .from('videos')
    .select(
      'id, long_form_mux_status, long_form_mux_aspect_ratio, long_form_mux_duration_ms, admin_removed_at',
    )
    .eq('id', videoId)
    .maybeSingle<{
      id: string;
      long_form_mux_status: string;
      long_form_mux_aspect_ratio: string | null;
      long_form_mux_duration_ms: number | null;
      admin_removed_at: string | null;
    }>();
  if (readErr || !row) return { ok: false, error: 'not_found' };

  // Audit M4: admin takedown lock wins over any publish attempt.
  if (row.admin_removed_at) return { ok: false, error: 'admin_removed' };

  if (row.long_form_mux_status !== 'ready') return { ok: false, error: 'not_ready' };
  if (row.long_form_mux_aspect_ratio === null) return { ok: false, error: 'aspect_ratio_missing' };
  if (row.long_form_mux_aspect_ratio !== '16:9') return { ok: false, error: 'aspect_ratio_unsupported' };
  if (row.long_form_mux_duration_ms === null) return { ok: false, error: 'not_ready' };
  const seconds = row.long_form_mux_duration_ms / 1000.0;
  if (seconds < 300 || seconds > 3300) return { ok: false, error: 'duration_out_of_range' };

  const { error: updErr } = await sb
    .from('videos')
    .update({ long_form_published_at: new Date().toISOString() })
    .eq('id', videoId)
    .is('long_form_published_at', null);
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true };
}

// Hook-side publish (videos.published_at). The DB trigger
// guard_published_requires_ready_hooks enforces ≥1 ready hook; the
// admin_removed_at lock is enforced here for both actors.
export async function setVideoPublishedGated(
  sb: SbClient,
  videoId: string,
  publish: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: row } = await sb
    .from('videos')
    .select('id, admin_removed_at')
    .eq('id', videoId)
    .maybeSingle<{ id: string; admin_removed_at: string | null }>();
  if (!row) return { ok: false, error: 'not_found' };
  if (row.admin_removed_at) return { ok: false, error: 'admin_removed' };

  const { error } = await sb
    .from('videos')
    .update({ published_at: publish ? new Date().toISOString() : null })
    .eq('id', videoId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
