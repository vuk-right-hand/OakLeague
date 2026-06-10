// SSR loader for /s/[id] — the avatar session page.
//
// Ownership + freshness are enforced server-side BEFORE rendering the client
// shell. The ephemeral envelope (Gemini token + Simli token) is NOT available
// here — it lives in sessionStorage, handed off by hook-panel's Ask click.
// page.tsx supplies only safe, re-fetchable context: creator display name,
// hook title, and confirmation that the session row exists and is owned by
// the caller.
//
// If the user landed here via a shared URL (envelope absent, session owned
// by someone else, or session already ended) the client falls back to an
// "expired" overlay and routes back to the feed.

import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { SessionClient } from './session-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export default async function SessionPage({ params }: Params) {
  const { id } = await params;
  const callerUserId = await getCallerUserId();
  if (!callerUserId) {
    redirect(`/login?next=${encodeURIComponent(`/s/${id}`)}`);
  }

  const sb = await supabaseServer();
  const { data: session } = await sb
    .from('sessions')
    .select('id, user_id, creator_id, hook_id, tier_at_session, ended_at, started_at')
    .eq('id', id)
    .maybeSingle<{
      id: string;
      user_id: string;
      creator_id: string;
      hook_id: string;
      tier_at_session: 'free' | 'premium' | 'boardroom';
      ended_at: string | null;
      started_at: string;
    }>();
  if (!session) notFound();
  if (session.user_id !== callerUserId) notFound();

  // Latency plan 2026-06-10: creator + hook selects depend only on the
  // session row — run them in parallel (one DB roundtrip saved on the
  // tap→avatar critical path). notFound() stays creator-only: a missing
  // hook is a VALID state (hook_id is ON DELETE SET NULL) and must render
  // with a null title, not 404.
  const [{ data: creator }, { data: hook }] = await Promise.all([
    sb
      .from('creators')
      .select('id, handle, display_name, simli_face_id')
      .eq('id', session.creator_id)
      .maybeSingle<{ id: string; handle: string; display_name: string; simli_face_id: string | null }>(),
    sb
      .from('hooks')
      .select('id, caption, video_id, videos!inner(title)')
      .eq('id', session.hook_id)
      .maybeSingle<{
        id: string;
        caption: string | null;
        video_id: string;
        videos: { title: string } | { title: string }[];
      }>(),
  ]);
  if (!creator) notFound();

  const videoTitle = hook
    ? Array.isArray(hook.videos)
      ? (hook.videos[0]?.title ?? null)
      : (hook.videos.title ?? null)
    : null;

  return (
    <SessionClient
      sessionId={session.id}
      creatorId={creator.id}
      hookId={session.hook_id}
      creatorHandle={creator.handle}
      creatorDisplayName={creator.display_name}
      hookTitle={videoTitle}
      sessionAlreadyEnded={!!session.ended_at}
    />
  );
}
