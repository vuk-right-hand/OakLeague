import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type CreatorRow = {
  id: string;
  user_id: string;
  handle: string | null;
  display_name: string | null;
  creator_type: string;
  brain_status: string;
  voice_id: string | null;
  simli_face_id: string | null;
  published_at: string | null;
  created_at: string;
};

// Must cover every value of the brain_status enum (see migration
// 20260420000001_extensions_and_enums.sql). Unknown values surface via the
// console warning below so a future enum expansion is visible instead of
// silently sorting last.
const STATUS_ORDER: Record<string, number> = {
  training: 0,
  queued: 1,
  pending: 2,
  errored: 3,
  ready: 4,
};

const LIST_LIMIT = 100;

export default async function AdminCreatorsList() {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creators')
    .select('id, user_id, handle, display_name, creator_type, brain_status, voice_id, simli_face_id, published_at, created_at')
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);

  const raw = (data ?? []) as CreatorRow[];
  for (const r of raw) {
    if (!(r.brain_status in STATUS_ORDER)) {
      // Server-log only; surfaces in Vercel logs when a new enum value ships
      // without a dashboard update. Not user-visible.
      console.warn('[admin/creators] unknown brain_status %s on creator %s', r.brain_status, r.id);
    }
  }
  const rows = raw.sort((a, b) => {
    const sa = STATUS_ORDER[a.brain_status] ?? 99;
    const sb2 = STATUS_ORDER[b.brain_status] ?? 99;
    if (sa !== sb2) return sa - sb2;
    return +new Date(b.created_at) - +new Date(a.created_at);
  });

  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Creators</h1>
      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No creators yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th align="left">Handle</th>
              <th align="left">Display name</th>
              <th align="left">Type</th>
              <th align="left">Brain</th>
              <th align="left">Voice</th>
              <th align="left">Face</th>
              <th align="left">Published</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={{ borderTop: '1px solid #222' }}>
                <td>{c.handle ? `@${c.handle}` : '—'}</td>
                <td>{c.display_name ?? '—'}</td>
                <td style={{ opacity: 0.7 }}>{c.creator_type}</td>
                <td>
                  <span style={{
                    padding: '1px 8px',
                    fontSize: 12,
                    borderRadius: 10,
                    background: brainBg(c.brain_status),
                    color: '#000',
                  }}>{c.brain_status}</span>
                </td>
                <td style={{ opacity: 0.7 }}>{c.voice_id ? '✓' : '—'}</td>
                <td style={{ opacity: 0.7 }}>{c.simli_face_id ? '✓' : '—'}</td>
                <td style={{ opacity: 0.7 }}>{c.published_at ? new Date(c.published_at).toLocaleDateString() : '—'}</td>
                <td><a href={`/admin/creators/${c.id}`}>Details →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length >= LIST_LIMIT && (
        <p style={{ opacity: 0.6, fontSize: 12, marginTop: 12 }}>
          Showing newest {LIST_LIMIT}. Add pagination before this list goes past ~80.
        </p>
      )}
    </main>
  );
}

function brainBg(status: string): string {
  switch (status) {
    case 'ready': return '#9be89b';
    case 'training': return '#ffd27a';
    case 'queued': return '#e8d07a';
    case 'errored': return '#ff8b8b';
    default: return '#ccc';
  }
}
