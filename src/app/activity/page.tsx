import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Activity v1 (PROFILE_SYSTEM_PLAN U5): your recent handshakers. Notifications
// are a later cut. S3: near-zero day one → explicit empty-state nudge.

type Row = { handle: string; display_name: string | null; avatar_url: string | null; is_creator: boolean };

export default async function ActivityPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/activity');

  // Resolve the viewer's own public handle to list who handshaked them.
  const [{ data: vp }, { data: vc }] = await Promise.all([
    supabase.from('profiles').select('handle').eq('id', user.id).maybeSingle(),
    supabase.from('creators').select('handle').eq('user_id', user.id).maybeSingle(),
  ]);
  const handle = vc?.handle ?? vp?.handle ?? null;

  let rows: Row[] = [];
  if (handle) {
    const { data } = await supabase.rpc('list_handshakers', { p_handle: handle, p_cursor: null, p_limit: 50 });
    rows = (data ?? []) as Row[];
  }

  return (
    <main className="oak-profile">
      <h1 className="oak-profile-name">Activity</h1>
      {!handle ? (
        <p className="oak-empty">
          Claim a handle to start receiving handshakes. <a href="/onboarding?claim=1">Claim yours →</a>
        </p>
      ) : rows.length === 0 ? (
        <p className="oak-empty">No handshakes yet. Share your profile <strong>@{handle}</strong> to get your first.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r) => (
            <li key={r.handle}>
              <a href={`/@${r.handle}`} style={{ display: 'flex', gap: 10, alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
                <span className="oak-avatar" style={{ width: 40, height: 40 }}>
                  {r.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.avatar_url} alt="" />
                  ) : (
                    <span className="oak-avatar-fallback" style={{ fontSize: 16 }}>
                      {(r.display_name || r.handle).slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <span>
                  <strong>{r.display_name || `@${r.handle}`}</strong> gave you a handshake
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
