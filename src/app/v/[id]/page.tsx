import { notFound } from 'next/navigation';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';
import { LongFormPlayer } from './long-form-player';

export const dynamic = 'force-dynamic';

// Boundary validation. A silent column rename or RLS mistake fails fast
// at the SSR edge instead of shipping undefined fields to the player.
const videoRowSchema = z.object({
  id: z.string().uuid(),
  creator_id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  long_form_mux_playback_id: z.string(),
  long_form_mux_aspect_ratio: z.string().nullable(),
  long_form_duration_seconds: z.number().nullable(),
  long_form_published_at: z.string(),
});

const creatorRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  handle: z.string(),
  avatar_url: z.string().nullable(),
});

type VideoRow = z.infer<typeof videoRowSchema>;
type CreatorRow = z.infer<typeof creatorRowSchema>;

const fromUuidSchema = z.string().uuid();

export default async function LongFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;

  // Validate the page :id is a UUID. supabaseServer query would tolerate
  // garbage and return null, but failing here keeps the 404 boundary clean.
  const idParse = fromUuidSchema.safeParse(id);
  if (!idParse.success) notFound();

  const sb = await supabaseServer();

  // Fetch the video. RLS public-read covers anon when published_at IS NOT NULL.
  // Long-form gates: long_form_mux_playback_id NOT NULL, long_form_mux_status
  // = 'ready', long_form_published_at NOT NULL — narrow at the query so a
  // pending or unpublished long-form returns 404 instead of breaking the player.
  const { data: videoRaw } = await sb
    .from('videos')
    .select(
      'id, creator_id, title, description, ' +
        'long_form_mux_playback_id, long_form_mux_aspect_ratio, ' +
        'long_form_duration_seconds, long_form_published_at',
    )
    .eq('id', idParse.data)
    .not('published_at', 'is', null)
    .not('long_form_mux_playback_id', 'is', null)
    .not('long_form_published_at', 'is', null)
    .eq('long_form_mux_status', 'ready')
    .maybeSingle();
  if (!videoRaw) notFound();

  const videoParse = videoRowSchema.safeParse(videoRaw);
  if (!videoParse.success) {
    console.error('[/v/[id]] video shape mismatch', videoParse.error.issues);
    notFound();
  }
  const video: VideoRow = videoParse.data;

  // Creator join. We don't auth-restrict creator reads since the video is
  // already publicly viewable — display_name + handle + avatar are public.
  const { data: creatorRaw } = await sb
    .from('creators')
    .select('id, display_name, handle, avatar_url')
    .eq('id', video.creator_id)
    .maybeSingle();
  if (!creatorRaw) notFound();
  const creatorParse = creatorRowSchema.safeParse(creatorRaw);
  if (!creatorParse.success) notFound();
  const creator: CreatorRow = creatorParse.data;

  // Audit C4: validate ?from= belongs to this video. A forged hook UUID
  // from another video must not slip through and tag full_video_quartile
  // events with cross-video hook_ids (which would otherwise pump topic
  // affinity into an unrelated video's topic_tags). Silent null-out
  // rather than 404 — stale shares of an old hook_id stay functional.
  let entryHookId: string | null = null;
  if (typeof from === 'string') {
    const fromParse = fromUuidSchema.safeParse(from);
    if (fromParse.success) {
      const { data: hookRow } = await sb
        .from('hooks_public')
        .select('id')
        .eq('id', fromParse.data)
        .eq('video_id', video.id)
        .maybeSingle<{ id: string }>();
      if (hookRow) entryHookId = hookRow.id;
    }
  }

  // Auth state for the Ask CTA swap (anon → "Sign up to chat" → /login).
  const {
    data: { user },
  } = await sb.auth.getUser();

  return (
    <LongFormPlayer
      videoId={video.id}
      creatorId={creator.id}
      creatorHandle={creator.handle}
      creatorName={creator.display_name}
      creatorAvatar={creator.avatar_url}
      videoTitle={video.title}
      videoDescription={video.description}
      muxPlaybackId={video.long_form_mux_playback_id}
      durationSeconds={video.long_form_duration_seconds}
      entryHookId={entryHookId}
      isAuthenticated={!!user}
    />
  );
}
