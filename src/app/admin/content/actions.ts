'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertAdminFromSession } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { deleteMuxAsset } from '@/lib/mux/upload';

type ActionResult = { ok: true } | { ok: false; error: string };

const CreateVideo = z.object({
  creatorId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
});

export async function createVideo(input: unknown): Promise<ActionResult & { videoId?: string }> {
  await assertAdminFromSession();
  const parsed = CreateVideo.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('videos')
    .insert({
      creator_id: parsed.data.creatorId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
    })
    .select('id')
    .single<{ id: string }>();

  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/content/videos');
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

export async function createHook(input: unknown): Promise<ActionResult & { hookId?: string }> {
  await assertAdminFromSession();
  const parsed = CreateHook.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data, error } = await admin
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

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/admin/content/videos/${parsed.data.videoId}`);
  return { ok: true, hookId: data.id };
}

const PublishVideo = z.object({
  videoId: z.string().uuid(),
  publish: z.boolean(),
});

export async function setVideoPublished(input: unknown): Promise<ActionResult> {
  await assertAdminFromSession();
  const parsed = PublishVideo.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { error } = await admin
    .from('videos')
    .update({ published_at: parsed.data.publish ? new Date().toISOString() : null })
    .eq('id', parsed.data.videoId);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/admin/content/videos/${parsed.data.videoId}`);
  return { ok: true };
}

const ReplaceHook = z.object({ hookId: z.string().uuid() });

export async function replaceHookTake(input: unknown): Promise<ActionResult> {
  await assertAdminFromSession();
  const parsed = ReplaceHook.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data: row, error: readErr } = await admin
    .from('hooks')
    .select('id, mux_asset_id, video_id')
    .eq('id', parsed.data.hookId)
    .maybeSingle<{ id: string; mux_asset_id: string | null; video_id: string }>();
  if (readErr || !row) return { ok: false, error: 'not_found' };

  if (row.mux_asset_id) {
    try {
      await deleteMuxAsset(row.mux_asset_id);
    } catch (e) {
      console.error('[replaceHookTake] Mux delete failed', e);
      // Audit S1: orphaned asset — row is being reset so we can't stamp
      // processing_error on the fresh take. Leave a breadcrumb in
      // cogs_log so it's discoverable via the admin viewer, then carry on.
      await admin.from('cogs_log').insert({
        service: 'mux',
        operation: 'asset.delete',
        units: 0,
        unit_label: 'seconds_encoded',
        cost_usd: 0,
        metadata: {
          orphaned_asset_id: row.mux_asset_id,
          reason: 'delete_failed',
          hook_id: parsed.data.hookId,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  // Reset row + regenerate passthrough UUID so late webhooks for the old
  // asset can't dispatch to the fresh take.
  const { error: updErr } = await admin
    .from('hooks')
    .update({
      mux_asset_id: null,
      mux_upload_id: null,
      mux_playback_id: null,
      mux_status: 'pending',
      mux_aspect_ratio: null,
      mux_duration_ms: null,
      processing_error: null,
      mux_passthrough: crypto.randomUUID(),
    })
    .eq('id', parsed.data.hookId);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/admin/content/videos/${row.video_id}`);
  return { ok: true };
}

const ResetFailedHook = z.object({ hookId: z.string().uuid() });

export async function resetFailedHook(input: unknown): Promise<ActionResult> {
  await assertAdminFromSession();
  const parsed = ResetFailedHook.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data: row, error: readErr } = await admin
    .from('hooks')
    .select('id, mux_status, video_id')
    .eq('id', parsed.data.hookId)
    .maybeSingle<{ id: string; mux_status: string; video_id: string }>();
  if (readErr || !row) return { ok: false, error: 'not_found' };
  if (row.mux_status !== 'failed') return { ok: false, error: 'not_failed' };

  const { error: updErr } = await admin
    .from('hooks')
    .update({
      mux_status: 'pending',
      processing_error: null,
      mux_upload_id: null,
      mux_passthrough: crypto.randomUUID(),
    })
    .eq('id', parsed.data.hookId);
  if (updErr) return { ok: false, error: updErr.message };
  revalidatePath(`/admin/content/videos/${row.video_id}`);
  return { ok: true };
}

const CreateWelcomeHook = z.object({
  creatorId: z.string().uuid(),
  videoId: z.string().uuid().optional(),
  transcript: z.string().max(8192).optional(),
});

export async function createWelcomeHook(
  input: unknown,
): Promise<ActionResult & { welcomeHookId?: string }> {
  await assertAdminFromSession();
  const parsed = CreateWelcomeHook.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('welcome_hooks')
    .insert({
      creator_id: parsed.data.creatorId,
      video_id: parsed.data.videoId ?? null,
      transcript: parsed.data.transcript ?? null,
    })
    .select('id')
    .single<{ id: string }>();

  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/content/welcome');
  return { ok: true, welcomeHookId: data.id };
}

// ── Long-form viewer (videos.long_form_*) ────────────────────────────────────

const PublishLongForm = z.object({ videoId: z.string().uuid() });

type PublishLongFormError =
  | 'invalid_input'
  | 'not_found'
  | 'not_ready'
  | 'duration_out_of_range'
  | 'aspect_ratio_unsupported'
  | 'aspect_ratio_missing'
  | string; // db errors fall through

// First-publish-wins (audit M4): re-running publishLongForm on an already-
// published row is a no-op rather than bumping long_form_published_at.
// The duration + aspect-ratio gates are the policy boundary; the DB CHECK
// is intentionally loose 60–3600 to avoid bricking the webhook UPDATE on
// CEIL-rounding edge cases.
export async function publishLongForm(
  input: unknown,
): Promise<ActionResult & { error?: PublishLongFormError }> {
  await assertAdminFromSession();
  const parsed = PublishLongForm.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data: row, error: readErr } = await admin
    .from('videos')
    .select(
      'id, long_form_mux_status, long_form_mux_aspect_ratio, long_form_mux_duration_ms',
    )
    .eq('id', parsed.data.videoId)
    .maybeSingle<{
      id: string;
      long_form_mux_status: string;
      long_form_mux_aspect_ratio: string | null;
      long_form_mux_duration_ms: number | null;
    }>();
  if (readErr || !row) return { ok: false, error: 'not_found' };

  if (row.long_form_mux_status !== 'ready') {
    return { ok: false, error: 'not_ready' };
  }

  // Audit M9: aspect-ratio enforcement at publish, not at webhook. We let
  // the asset reach 'ready' so the creator can preview before re-uploading.
  // Differentiate missing (Mux didn't send it) vs unsupported (≠ '16:9') so
  // the UI can show a more accurate error.
  if (row.long_form_mux_aspect_ratio === null) {
    return { ok: false, error: 'aspect_ratio_missing' };
  }
  if (row.long_form_mux_aspect_ratio !== '16:9') {
    return { ok: false, error: 'aspect_ratio_unsupported' };
  }

  // Audit M10: float-compare duration. long_form_mux_duration_ms is
  // authoritative (Mux reports float seconds; we store ms). The strict
  // 5–55 min user-facing rule is enforced here, not in the DB CHECK
  // which is loose 60–3600.
  if (row.long_form_mux_duration_ms === null) {
    return { ok: false, error: 'not_ready' };
  }
  const seconds = row.long_form_mux_duration_ms / 1000.0;
  if (seconds < 300 || seconds > 3300) {
    return { ok: false, error: 'duration_out_of_range' };
  }

  // First-publish-wins idempotency (audit M4). The .is('long_form_published_at', null)
  // filter means a re-run on an already-published row matches zero rows
  // and is a silent no-op. UI re-fetches and sees the original timestamp.
  const { error: updErr } = await admin
    .from('videos')
    .update({ long_form_published_at: new Date().toISOString() })
    .eq('id', parsed.data.videoId)
    .is('long_form_published_at', null);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/admin/content/videos/${parsed.data.videoId}`);
  return { ok: true };
}

const UnpublishLongForm = z.object({ videoId: z.string().uuid() });

export async function unpublishLongForm(input: unknown): Promise<ActionResult> {
  await assertAdminFromSession();
  const parsed = UnpublishLongForm.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { error } = await admin
    .from('videos')
    .update({ long_form_published_at: null })
    .eq('id', parsed.data.videoId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/admin/content/videos/${parsed.data.videoId}`);
  return { ok: true };
}

const ResetLongForm = z.object({ videoId: z.string().uuid() });

// Mirrors replaceHookTake: deletes any existing Mux asset, regenerates the
// passthrough UUID so late webhooks for the old asset can't dispatch to the
// fresh take, clears all long_form_mux_* columns. Required to mint a new
// upload after an existing asset has reached ready/processing/uploading.
export async function resetLongForm(input: unknown): Promise<ActionResult> {
  await assertAdminFromSession();
  const parsed = ResetLongForm.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const admin = supabaseAdmin();
  const { data: row, error: readErr } = await admin
    .from('videos')
    .select('id, long_form_mux_asset_id')
    .eq('id', parsed.data.videoId)
    .maybeSingle<{ id: string; long_form_mux_asset_id: string | null }>();
  if (readErr || !row) return { ok: false, error: 'not_found' };

  if (row.long_form_mux_asset_id) {
    try {
      await deleteMuxAsset(row.long_form_mux_asset_id);
    } catch (e) {
      console.error('[resetLongForm] Mux delete failed', e);
      await admin.from('cogs_log').insert({
        service: 'mux',
        operation: 'asset.delete',
        units: 0,
        unit_label: 'seconds_encoded',
        cost_usd: 0,
        metadata: {
          orphaned_asset_id: row.long_form_mux_asset_id,
          reason: 'delete_failed',
          video_id: parsed.data.videoId,
          target: 'video_long_form',
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  const { error: updErr } = await admin
    .from('videos')
    .update({
      long_form_mux_asset_id: null,
      long_form_mux_upload_id: null,
      long_form_mux_playback_id: null,
      long_form_mux_status: 'pending',
      long_form_mux_aspect_ratio: null,
      long_form_mux_duration_ms: null,
      long_form_duration_seconds: null,
      long_form_processing_error: null,
      long_form_mux_passthrough: crypto.randomUUID(),
      long_form_published_at: null,
    })
    .eq('id', parsed.data.videoId);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/admin/content/videos/${parsed.data.videoId}`);
  return { ok: true };
}

const ActivateWelcome = z.object({ welcomeHookId: z.string().uuid() });

export async function activateWelcomeHook(input: unknown): Promise<ActionResult> {
  // Audit S8: assertAdminFromSession() is load-bearing for its THROW on
  // non-admins — we don't use the returned session here because the actual
  // RPC runs on the SSR cookie-bound client (so auth.uid() resolves inside
  // the RPC to the admin's id, required by is_admin() in set_active_welcome_hook).
  await assertAdminFromSession();
  const parsed = ActivateWelcome.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const { supabaseServer } = await import('@/lib/supabase/server');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('set_active_welcome_hook', {
    p_welcome_hook_id: parsed.data.welcomeHookId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/content/welcome');
  return { ok: true };
}
