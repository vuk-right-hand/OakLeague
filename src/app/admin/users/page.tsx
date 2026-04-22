import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type ProfileRow = {
  id: string;
  handle: string | null;
  display_name: string | null;
  tier: 'free' | 'premium' | 'boardroom';
  timezone: string;
  created_at: string;
  email: string | null;
};

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const sb = supabaseAdmin();
  // `profiles_email_mirror` (migration 0027) keeps email on profiles.
  let builder = sb
    .from('profiles')
    .select('id, handle, display_name, tier, timezone, created_at, email')
    .order('created_at', { ascending: false })
    .limit(100);

  if (query) {
    // Strip anything that could break out of a PostgREST or()-filter expression
    // OR act as a LIKE wildcard. `,()` are filter-separator syntax and cannot
    // be escaped safely; `%_\` are LIKE metacharacters. Allowlist: letters,
    // digits, space, @, ., -. Underscore is excluded explicitly — `\w` would
    // permit it, but `_` is an ilike single-char wildcard and would cause
    // foo_bar to silently match fooXbar.
    const clean = query.replace(/[^a-zA-Z0-9@. -]/g, '').slice(0, 80);
    if (clean) {
      builder = builder.or(
        `handle.ilike.%${clean}%,display_name.ilike.%${clean}%,email.ilike.%${clean}%`,
      );
    }
  }

  const { data, error } = await builder;
  const rows = (data ?? []) as ProfileRow[];

  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Users</h1>

      <form method="get" style={{ marginBottom: 16 }}>
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search handle, name, email…"
          style={{
            width: 320,
            padding: '6px 10px',
            fontSize: 14,
            background: '#111',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 6,
          }}
        />
      </form>

      {error && <p style={{ color: 'salmon' }}>Lookup failed: {error.message}</p>}

      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No users match.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th align="left">Handle</th>
              <th align="left">Display name</th>
              <th align="left">Email</th>
              <th align="left">Tier</th>
              <th align="left">TZ</th>
              <th align="left">Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #222' }}>
                <td>{r.handle ? `@${r.handle}` : '—'}</td>
                <td>{r.display_name ?? '—'}</td>
                <td style={{ opacity: 0.7 }}>{r.email ?? '—'}</td>
                <td>{r.tier}</td>
                <td style={{ opacity: 0.6 }}>{r.timezone}</td>
                <td style={{ opacity: 0.6 }}>{new Date(r.created_at).toLocaleDateString()}</td>
                <td><a href={`/admin/users/${r.id}`}>Open →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
