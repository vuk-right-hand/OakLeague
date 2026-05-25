import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { HANDLE_RE } from '@/lib/profile/handle';
import { HandshakeButton } from './handshake-button';
import { EditProfileSheet } from './edit-profile-sheet';

export const dynamic = 'force-dynamic'; // per-viewer state (handshaked / self); never CDN-cache (audit M5)

type ViewerCreator = { handle: string | null; brain_status: string | null };

type PublicProfile = {
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_creator: boolean;
  creator_id: string | null;
  handshake_count: number;
  handshakes_given_count: number;
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { handle: raw } = await params;
  // Profiles live at /@handle. A segment without the @ isn't a profile URL.
  if (!raw?.startsWith('@')) notFound();
  const handle = raw.slice(1).toLowerCase();
  if (!HANDLE_RE.test(handle)) notFound();

  const supabase = await supabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Resolve the viewer's own identity FIRST — needed to distinguish "this is my
  // own profile" from "no such public profile" (audit C-D1: an approved creator
  // is unpublished while their brain trains, so resolve_public_profile returns
  // no row even though the handle is theirs — we must not 404 their own page).
  let viewerHandle: string | null = null;
  let viewerCreator: ViewerCreator | null = null;
  if (user) {
    const [{ data: vp }, { data: vc }] = await Promise.all([
      supabase.from('profiles').select('handle').eq('id', user.id).maybeSingle(),
      supabase.from('creators').select('handle, brain_status').eq('user_id', user.id).maybeSingle(),
    ]);
    viewerCreator = (vc ?? null) as ViewerCreator | null;
    viewerHandle = ((vc?.handle ?? vp?.handle ?? null) as string | null)?.toLowerCase() ?? null;
  }
  const isSelf = viewerHandle === handle;

  const { data: rows } = await supabase.rpc('resolve_public_profile', { p_handle: handle });
  const profile = (rows?.[0] ?? null) as PublicProfile | null;

  if (!profile) {
    // Owner of an unpublished (training/pending) creator → self "setting up" state,
    // not a 404. Everyone else → 404 (don't leak unpublished creators).
    if (isSelf && viewerCreator) {
      return (
        <main className="oak-profile">
          <header className="oak-profile-head">
            <h1 className="oak-profile-name">@{handle}</h1>
            <p className="oak-empty">
              Your mentor is still training{viewerCreator.brain_status ? ` (${viewerCreator.brain_status})` : ''}. Your
              public profile goes live once it’s ready.
            </p>
            <a className="oak-btn-secondary" href="/creator">
              Go to Studio
            </a>
          </header>
        </main>
      );
    }
    notFound(); // in-review creators / unclaimed handles have no public page
  }

  let handshaked = false;
  if (user && !isSelf) {
    const { data } = await supabase.rpc('viewer_handshake_state', { p_target_handle: handle });
    handshaked = data === true;
  }

  // M6/C1: a handshake intent from the login hop is NOT executed here — mutating
  // on a GET render is a CSRF-via-top-level-navigation surface. We pass it to the
  // client button, which fires the CSRF-protected server action once and strips
  // the param. Only honor it for an authenticated non-self viewer not already on.
  const { action } = await searchParams;
  const autoHandshake = action === 'handshake' && !!user && !isSelf && !handshaked;

  // Creator content grid (M1: "Ask" routes to content, never opens a session here).
  let videos: Array<{ id: string; title: string; thumbnail_url: string | null }> = [];
  if (profile.is_creator && profile.creator_id) {
    const { data: vids } = await supabase
      .from('videos')
      .select('id, title, thumbnail_url')
      .eq('creator_id', profile.creator_id)
      .not('published_at', 'is', null)
      .order('published_at', { ascending: false })
      .limit(24);
    videos = vids ?? [];
  }

  // Private "Liked" list — own profile only. Each row opens the canonical
  // /v/[id] experience (carousel + Ask), exactly as if found in the feed.
  let likedVideos: Array<{ video_id: string; title: string; thumbnail_url: string | null }> = [];
  if (isSelf) {
    const { data: lv } = await supabase.rpc('list_liked_videos', {
      p_cursor_ts: null,
      p_cursor_id: null,
      p_limit: 24,
    });
    likedVideos = (lv ?? []) as typeof likedVideos;
  }

  const name = profile.display_name || `@${profile.handle}`;
  const askTarget = videos[0]?.id ? `/v/${videos[0].id}` : null;

  return (
    <main className="oak-profile">
      <header className="oak-profile-head">
        <div className="oak-avatar" aria-hidden={!profile.avatar_url}>
          {profile.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.avatar_url} alt={`${name} avatar`} width={96} height={96} />
          ) : (
            <span className="oak-avatar-fallback">{name.replace('@', '').slice(0, 1).toUpperCase()}</span>
          )}
        </div>

        <h1 className="oak-profile-name">{name}</h1>
        <p className="oak-profile-handle">@{profile.handle}</p>

        <div className="oak-profile-stats">
          <span>
            <strong>{fmt(profile.handshake_count)}</strong> Handshakes
          </span>
          <span>
            <strong>{fmt(profile.handshakes_given_count)}</strong> given
          </span>
        </div>

        {profile.bio ? <p className="oak-profile-bio">{profile.bio}</p> : null}

        <div className="oak-profile-actions">
          {isSelf ? (
            profile.is_creator ? (
              <a className="oak-btn-secondary" href="/creator">
                Edit in Studio
              </a>
            ) : (
              <EditProfileSheet
                handle={profile.handle}
                displayName={profile.display_name ?? ''}
                bio={profile.bio ?? ''}
              />
            )
          ) : (
            <>
              <HandshakeButton
                handle={profile.handle}
                initialHandshaked={handshaked}
                isAuthenticated={!!user}
                autoFire={autoHandshake}
              />
              {/* M4: never "Ask yourself". Ask routes to content, not a session (M1). */}
              {profile.is_creator && askTarget ? (
                <a className="oak-btn-primary" href={askTarget}>
                  Ask {name}
                </a>
              ) : null}
            </>
          )}
        </div>
      </header>

      {profile.is_creator ? (
        videos.length > 0 ? (
          <section className="oak-video-grid" aria-label="Videos">
            {videos.map((v) => (
              <a key={v.id} className="oak-video-cell" href={`/v/${v.id}`}>
                {v.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumbnail_url} alt={v.title} loading="lazy" />
                ) : (
                  <span className="oak-video-cell-title">{v.title}</span>
                )}
              </a>
            ))}
          </section>
        ) : (
          <p className="oak-empty">No videos yet.</p>
        )
      ) : !isSelf ? (
        <p className="oak-empty">@{profile.handle} hasn’t posted yet.</p>
      ) : null}

      {isSelf ? (
        <section aria-label="Liked videos" style={{ marginTop: 24 }}>
          <h2 className="oak-section-title">Liked</h2>
          {likedVideos.length > 0 ? (
            <div className="oak-video-grid">
              {likedVideos.map((v) => (
                <a key={v.video_id} className="oak-video-cell" href={`/v/${v.video_id}`}>
                  {v.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail_url} alt={v.title} loading="lazy" />
                  ) : (
                    <span className="oak-video-cell-title">{v.title}</span>
                  )}
                </a>
              ))}
            </div>
          ) : (
            <p className="oak-empty">Videos you like will show here.</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
