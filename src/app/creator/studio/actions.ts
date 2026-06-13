'use server';

// Creator studio video actions (CREATOR_STUDIO WS6). Creators create + publish
// their own videos with NO per-video admin approval (Vuk 2026-06-12) — vetting
// is creator-level. Every action: assertCreatorFromSession → ownership assert
// (service-role bypasses RLS, so the TS assert IS the guard — audit M6) →
// whitelist → mutate → revalidate. Publish runs the SAME gates as admin via
// publish-gates.ts (audit C4). admin_removed_at lock refuses creator toggles
// (audit M4 takedown-evasion).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { deleteMuxAsset } from '@/lib/mux/upload';
import { publishLongFormGated, setVideoPublishedGated } from '@/lib/videos/publish-gates';

type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_VIDEOS_PER_CREATOR = 20;

async function getCreatorOrError(): Promise<
  | { ok: true; userId: string; creatorId: string }
  | { ok: false; error: string }
> {
  try {
    const s = await assertCreatorFromSession();
    return { ok: true, ...s };
  } catch (e) {
    if (e instanceof AuthGuardError) {
      return { ok: false, error: e.status === 401 ? 'unauthenticated' : 'forbidden' };
    }
    throw e;
  }
}

// Ownership assert (audit M6): the service-role client bypasses RLS, so this
// explicit join IS the security boundary. Returns the video row or null.
async function assertOwnVideo(
  sb: ReturnType<typeof supabaseAdmin>,
  videoId: string,
  creatorId: string,
): Promise<{ id: string; admin_removed_at: string | null } | null> {
  const { data } = await sb
    .from('videos')
    .select('id, creator_id, admin_removed_at')
    .eq('id', videoId)
    .eq('creator_id', creatorId)
    .maybeSingle<{ id: string; creator_id: string; admin_removed_at: string | null }>();
  return data ?? null;
}

// ── Create ────────────────────────────────────────────────────────────────────

const CreateVideo = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
});

export async function creatorCreateVideo(
  input: unknown,
): Promise<ActionResult & { videoId?: string }> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = CreateVideo.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  // Quota (audit M7/R4): 20 videos per creator. Total long-form minutes are
  // additionally capped at the upload-mint route (600 min).
  const { count } = await sb
    .from('videos')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', caller.creatorId);
  if ((count ?? 0) >= MAX_VIDEOS_PER_CREATOR) {
    return { ok: false, error: 'video_quota_reached' };
  }

  const { data, error } = await sb
    .from('videos')
    .insert({
      creator_id: caller.creatorId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
    })
    .select('id')
    .single<{ id: string }>();
  if (error) return { ok: false, error: 'insert_failed' };
  revalidatePath('/creator/studio');
  return { ok: true, videoId: data.id };
}

const CreateHook = z.object({
  videoId: z.string().uuid(),
  lessonNumber: z.number().int().min(1).max(5),
  title: z.string().trim().min(1).max(200),
  caption: z.string().max(280).optional(),
  transcript: z.string().max(8192).optional(),
  topicTags: z.array(z.string().min(1)).min(1),
});

export async function creatorCreateHook(
  input: unknown,
): Promise<ActionResult & { hookId?: string }> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = CreateHook.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const video = await assertOwnVideo(sb, parsed.data.videoId, caller.creatorId);
  if (!video) return { ok: false, error: 'not_found' };

  const { data, error } = await sb
    .from('hooks')
    .insert({
      video_id: parsed.data.videoId,
      lesson_number: parsed.data.lessonNumber,
      title: parsed.data.title,
      caption: parsed.data.caption ?? null,
      transcript: parsed.data.transcript ?? null,
      topic_tags: parsed.data.topicTags,
    })
    .select('id')
    .single<{ id: string }>();
  // verify_hook_topic_slugs trigger rejects tags outside the creator's topics.
  if (error) return { ok: false, error: 'insert_failed' };
  revalidatePath(`/creator/studio/${parsed.data.videoId}`);
  return { ok: true, hookId: data.id };
}

// ── Publish (no per-video approval) ──────────────────────────────────────────

const PublishVideo = z.object({
  videoId: z.string().uuid(),
  publish: z.boolean(),
});

export async function creatorSetVideoPublished(
  input: unknown,
): Promise<ActionResult & { longFormWarning?: string }> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = PublishVideo.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const video = await assertOwnVideo(sb, parsed.data.videoId, caller.creatorId);
  if (!video) return { ok: false, error: 'not_found' };
  // Audit M4: a creator suspended by admin (creators.published_at NULL'd)
  // cannot republish their own catalog while suspended — feed already hides
  // it, but don't let the toggle churn state under a takedown.
  if (parsed.data.publish) {
    const { data: c } = await sb
      .from('creators')
      .select('published_at')
      .eq('id', caller.creatorId)
      .maybeSingle<{ published_at: string | null }>();
    if (!c?.published_at) return { ok: false, error: 'creator_not_live' };
  }

  const res = await setVideoPublishedGated(sb, parsed.data.videoId, parsed.data.publish);
  if (!res.ok) return res;

  // Auto-publish the long-form alongside when it passes the shared gates.
  // Audit M3: surface a non-fatal warning so the creator knows the hook is
  // live but the full lesson isn't. 'not_ready' is the expected hook-only /
  // still-processing case → stay silent; anything else is worth telling them.
  let longFormWarning: string | undefined;
  if (parsed.data.publish) {
    const lf = await publishLongFormGated(sb, parsed.data.videoId);
    if (!lf.ok && lf.error !== 'not_ready') longFormWarning = lf.error;
  }
  revalidatePath(`/creator/studio/${parsed.data.videoId}`);
  revalidatePath('/creator/studio');
  return { ok: true, longFormWarning };
}

export async function creatorPublishLongForm(input: unknown): Promise<ActionResult> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = z.object({ videoId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const video = await assertOwnVideo(sb, parsed.data.videoId, caller.creatorId);
  if (!video) return { ok: false, error: 'not_found' };

  // Audit C4: a suspended/unpublished creator must not be able to flip
  // long_form_published_at on. publishLongFormGated only checks the video's
  // admin_removed_at (shared with admin, who may publish regardless), so the
  // creator-live gate lives here — mirrors creatorSetVideoPublished.
  const { data: c } = await sb
    .from('creators')
    .select('published_at')
    .eq('id', caller.creatorId)
    .maybeSingle<{ published_at: string | null }>();
  if (!c?.published_at) return { ok: false, error: 'creator_not_live' };

  const res = await publishLongFormGated(sb, parsed.data.videoId);
  if (!res.ok) return res;
  revalidatePath(`/creator/studio/${parsed.data.videoId}`);
  return { ok: true };
}

export async function creatorUnpublishLongForm(input: unknown): Promise<ActionResult> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = z.object({ videoId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const video = await assertOwnVideo(sb, parsed.data.videoId, caller.creatorId);
  if (!video) return { ok: false, error: 'not_found' };
  // Unpublish is allowed even under an admin takedown — it only ever hides
  // content further, never re-exposes it.

  const { error } = await sb
    .from('videos')
    .update({ long_form_published_at: null })
    .eq('id', parsed.data.videoId)
    .eq('creator_id', caller.creatorId);
  if (error) return { ok: false, error: 'update_failed' };
  revalidatePath(`/creator/studio/${parsed.data.videoId}`);
  return { ok: true };
}

// ── Replace / reset (mirrors admin mechanics; ownership-guarded) ─────────────

export async function creatorReplaceHookTake(input: unknown): Promise<ActionResult> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = z.object({ hookId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from('hooks')
    .select('id, mux_asset_id, video_id, videos!inner(creator_id)')
    .eq('id', parsed.data.hookId)
    .eq('videos.creator_id', caller.creatorId)
    .maybeSingle<{ id: string; mux_asset_id: string | null; video_id: string }>();
  if (!row) return { ok: false, error: 'not_found' };

  if (row.mux_asset_id) {
    try {
      await deleteMuxAsset(row.mux_asset_id);
    } catch (e) {
      console.error('[creatorReplaceHookTake] Mux delete failed', e);
      await sb.from('cogs_log').insert({
        service: 'mux', operation: 'asset.delete', units: 0,
        unit_label: 'seconds_encoded', cost_usd: 0,
        metadata: {
          orphaned_asset_id: row.mux_asset_id, reason: 'delete_failed',
          hook_id: parsed.data.hookId,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  const { error: updErr } = await sb
    .from('hooks')
    .update({
      mux_asset_id: null, mux_upload_id: null, mux_playback_id: null,
      mux_status: 'pending', mux_aspect_ratio: null, mux_duration_ms: null,
      processing_error: null, mux_passthrough: crypto.randomUUID(),
    })
    .eq('id', parsed.data.hookId);
  if (updErr) return { ok: false, error: 'reset_failed' };
  revalidatePath(`/creator/studio/${row.video_id}`);
  return { ok: true };
}

export async function creatorResetLongForm(input: unknown): Promise<ActionResult> {
  const caller = await getCreatorOrError();
  if (!caller.ok) return caller;
  const parsed = z.object({ videoId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const video = await assertOwnVideo(sb, parsed.data.videoId, caller.creatorId);
  if (!video) return { ok: false, error: 'not_found' };
  if (video.admin_removed_at) return { ok: false, error: 'admin_removed' };

  const { data: row } = await sb
    .from('videos')
    .select('id, long_form_mux_asset_id')
    .eq('id', parsed.data.videoId)
    .maybeSingle<{ id: string; long_form_mux_asset_id: string | null }>();
  if (!row) return { ok: false, error: 'not_found' };

  if (row.long_form_mux_asset_id) {
    try {
      await deleteMuxAsset(row.long_form_mux_asset_id);
    } catch (e) {
      console.error('[creatorResetLongForm] Mux delete failed', e);
      await sb.from('cogs_log').insert({
        service: 'mux', operation: 'asset.delete', units: 0,
        unit_label: 'seconds_encoded', cost_usd: 0,
        metadata: {
          orphaned_asset_id: row.long_form_mux_asset_id, reason: 'delete_failed',
          video_id: parsed.data.videoId, target: 'video_long_form',
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  const { error: updErr } = await sb
    .from('videos')
    .update({
      long_form_mux_asset_id: null, long_form_mux_upload_id: null,
      long_form_mux_playback_id: null, long_form_mux_status: 'pending',
      long_form_mux_aspect_ratio: null, long_form_mux_duration_ms: null,
      long_form_duration_seconds: null, long_form_processing_error: null,
      long_form_mux_passthrough: crypto.randomUUID(),
      long_form_published_at: null,
    })
    .eq('id', parsed.data.videoId);
  if (updErr) return { ok: false, error: 'reset_failed' };
  revalidatePath(`/creator/studio/${parsed.data.videoId}`);
  return { ok: true };
}
