import { supabaseAdmin } from '@/lib/supabase/admin';

type AppRow = {
  id: string;
  user_id: string;
  handle: string;
  display_name: string;
  status: string;
  submitted_at: string;
};

export default async function ApplicationsPage() {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creator_applications')
    .select('id, user_id, handle, display_name, status, submitted_at')
    .in('status', ['submitted', 'under_review'])
    .order('submitted_at', { ascending: true });

  const rows = (data ?? []) as AppRow[];

  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Applications</h1>
      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No pending applications.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Handle</th>
              <th align="left">Display name</th>
              <th align="left">Status</th>
              <th align="left">Submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #222' }}>
                <td>@{r.handle}</td>
                <td>{r.display_name}</td>
                <td>{r.status}</td>
                <td>{new Date(r.submitted_at).toLocaleString()}</td>
                <td>
                  <a href={`/admin/applications/${r.id}`}>Review →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
