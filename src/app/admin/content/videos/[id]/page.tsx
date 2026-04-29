import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { VideoDetailClient } from './video-detail-client';

export const dynamic = 'force-dynamic';

type VideoRow = {
  id: string;
  title: string;
  description: string | null;
  creator_id: string;
  published_at: string | null;
  lesson_count: number;
  status: string;
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

type CreatorRow = {
  id: string;
  display_name: string;
  handle: string;
};

type TopicRow = { slug: string; label: string };

export default async function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = supabaseAdmin();

  const { data: video } = await admin
    .from('videos')
    .select(
      'id, title, description, creator_id, published_at, lesson_count, status, ' +
        'long_form_mux_status, long_form_mux_playback_id, long_form_mux_aspect_ratio, ' +
        'long_form_mux_duration_ms, long_form_processing_error, long_form_published_at',
    )
    .eq('id', id)
    .maybeSingle<VideoRow>();
  if (!video) notFound();

  const [{ data: hooksRaw }, { data: creator }, { data: topics }] = await Promise.all([
    admin
      .from('hooks')
      .select('id, lesson_number, title, caption, mux_status, mux_playback_id, processing_error, topic_tags')
      .eq('video_id', id)
      .order('lesson_number', { ascending: true }),
    admin
      .from('creators')
      .select('id, display_name, handle')
      .eq('id', video.creator_id)
      .maybeSingle<CreatorRow>(),
    admin
      .from('creator_topics')
      .select('slug, label:title')
      .eq('creator_id', video.creator_id)
      .order('title', { ascending: true }),
  ]);

  const hooks = (hooksRaw ?? []) as HookRow[];
  const topicRows = (topics ?? []) as TopicRow[];

  return (
    <VideoDetailClient
      video={video}
      hooks={hooks}
      creator={creator ?? null}
      topics={topicRows}
    />
  );
}
