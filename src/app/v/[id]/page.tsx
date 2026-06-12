import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';
import { LongFormPlayer } from './long-form-player';
import { LikeButton } from './like-button';
import { CommentsPanel } from './comments-panel';
import { ShareButton } from '@/components/share/ShareButton';
import type { CommentRow } from '@/lib/video/comment-actions';

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
  like_count: z.number(),
  comment_count: z.number(),
});

const creatorRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  display_name: z.string(),
  handle: z.string(),
  avatar_url: z.string().nullable(),
});

type VideoRow = z.infer<typeof videoRowSchema>;
type CreatorRow = z.infer<typeof creatorRowSchema>;

const fromUuidSchema = z.string().uuid();

// WS7: unfurl metadata for shared long-form links. Same publish + long-form-ready
// gate as the page; unpublished/pending → generic title (no leak). The
// opengraph-image.tsx in this segment is auto-attached as og:image by Next.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!fromUuidSchema.safeParse(id).success) return { title: 'OakLeague' };

  const sb = await supabaseServer();
  const { data } = await sb
    .from('videos')
    .select('title, description, creator_id')
    .eq('id', id)
    .not('published_at', 'is', null)
    .not('long_form_published_at', 'is', null)
    .eq('long_form_mux_status', 'ready')
    .maybeSingle<{ title: string; description: string | null; creator_id: string }>();
  if (!data) return { title: 'OakLeague' };

  const { data: c } = await sb
    .from('creators')
    .select('display_name, handle')
    .eq('id', data.creator_id)
    .maybeSingle<{ display_name: string | null; handle: string }>();
  const who = c?.display_name || (c ? `@${c.handle}` : 'OakLeague');
  const title = `${data.title} — ${who} on OakLeague`;
  const description = (data.description ?? `Watch ${who} on OakLeague.`).slice(0, 200);
  return {
    title,
    description,
    openGraph: { title, description, type: 'video.other', url: `/v/${id}` },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function LongFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; action?: string }>;
}) {
  const { id } = await params;
  const { from, action } = await searchParams;

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
        'long_form_duration_seconds, long_form_published_at, like_count, comment_count',
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
    .select('id, user_id, display_name, handle, avatar_url')
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

  // Likes + comments state (COMMENTS_LIKES_PLAN L2/C2).
  let liked = false;
  let isModerator = false;
  let viewerHandle: string | null = null;
  let viewerName: string | null = null;
  let viewerAvatar: string | null = null;
  if (user) {
    const [{ data: likedData }, { data: vp }, { data: vc }] = await Promise.all([
      sb.rpc('viewer_liked_state', { p_video_id: video.id }),
      sb.from('profiles').select('handle, display_name, avatar_url').eq('id', user.id).maybeSingle(),
      sb.from('creators').select('handle, display_name, avatar_url').eq('user_id', user.id).maybeSingle(),
    ]);
    liked = likedData === true;
    viewerHandle = (vc?.handle ?? vp?.handle ?? null) as string | null;
    viewerName = (vc?.display_name ?? vp?.display_name ?? null) as string | null;
    viewerAvatar = (vc?.avatar_url ?? vp?.avatar_url ?? null) as string | null;
    if (creator.user_id === user.id) {
      isModerator = true;
    } else {
      const { data: adm } = await sb.from('admin_roles').select('user_id').eq('user_id', user.id).maybeSingle();
      isModerator = !!adm;
    }
  }
  const [{ data: pinnedRaw }, { data: topRaw }] = await Promise.all([
    sb.rpc('list_pinned_comments', { p_video_id: video.id }),
    sb.rpc('list_video_comments', { p_video_id: video.id, p_cursor_ts: null, p_cursor_id: null, p_limit: 30 }),
  ]);
  // C3: don't re-fire the login-hop like if the user already likes it.
  const autoLike = action === 'like' && !!user && !liked;

  return (
    <>
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
      <div className="oak-video-engagement">
        <LikeButton
          videoId={video.id}
          initialLiked={liked}
          initialCount={video.like_count}
          isAuthenticated={!!user}
          autoFire={autoLike}
        />
        <ShareButton
          path={`/v/${video.id}`}
          title={`${video.title} — ${creator.display_name} on OakLeague`}
          text={`Watch ${creator.display_name} on OakLeague`}
        />
        <CommentsPanel
          videoId={video.id}
          isAuthenticated={!!user}
          isModerator={isModerator}
          initialPinned={(pinnedRaw ?? []) as CommentRow[]}
          initialComments={(topRaw ?? []) as CommentRow[]}
          commentCount={video.comment_count}
          viewerHandle={viewerHandle}
          viewerName={viewerName}
          viewerAvatar={viewerAvatar}
        />
      </div>
    </>
  );
}
