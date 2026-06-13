import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { StudioVideoClient } from './studio-video-client';

export const dynamic = 'force-dynamic';

type VideoRow = {
  id: string;
  title: string;
  description: string | null;
  creator_id: string;
  published_at: string | null;
  lesson_count: number;
  admin_removed_at: string | null;
  long_form_mux_status: string;
  long_form_mux_playback_id: string | null;
  long_form_mux_aspect_ratio: string | null;
  long_form_mux_duration_ms: number | null;
  long_form_processing_error: string | null;
  long_form_published_at: string | null;
};

type HookRow = {
  id: string;
  lesson_number: number;
  title: string | null;
  caption: string | null;
  mux_status: string;
  mux_playback_id: string | null;
  processing_error: string | null;
  topic_tags: string[];
};

type TopicRow = { slug: string; label: string };

export default async function StudioVideoPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  const { creatorId } = await getCreatorForCaller();
  const sb = supabaseAdmin();

  // Ownership IS the .eq('creator_id') filter — service-role bypasses RLS, so
  // a video belonging to another creator returns no row → notFound (mirrors
  // the actions' assertOwnVideo guard).
  const { data: video } = await sb
    .from('videos')
    .select(
      'id, title, description, creator_id, published_at, lesson_count, admin_removed_at, ' +
        'long_form_mux_status, long_form_mux_playback_id, long_form_mux_aspect_ratio, ' +
        'long_form_mux_duration_ms, long_form_processing_error, long_form_published_at',
    )
    .eq('id', videoId)
    .eq('creator_id', creatorId)
    .maybeSingle<VideoRow>();
  if (!video) notFound();

  const [{ data: hooksRaw }, { data: topics }] = await Promise.all([
    sb
      .from('hooks')
      .select('id, lesson_number, title, caption, mux_status, mux_playback_id, processing_error, topic_tags')
      .eq('video_id', videoId)
      .order('lesson_number', { ascending: true }),
    sb
      .from('creator_topics')
      .select('slug, label:title')
      .eq('creator_id', creatorId)
      .order('title', { ascending: true }),
  ]);

  return (
    <main>
      <Link href="/creator/studio" style={{ fontSize: 13, opacity: 0.7 }}>
        ← Studio
      </Link>
      <div style={{ marginTop: 16 }}>
        <StudioVideoClient
          video={video}
          hooks={(hooksRaw ?? []) as HookRow[]}
          topics={(topics ?? []) as TopicRow[]}
        />
      </div>
    </main>
  );
}
