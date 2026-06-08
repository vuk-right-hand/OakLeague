import { supabaseAdmin } from '@/lib/supabase/admin';

// AUTHZ: admin gate is enforced by src/app/admin/layout.tsx (assertAdminFromSession
// → notFound() for non-admins) — load-bearing for this page's service-role read of
// the lead table. Do not render this component outside the admin layout (audit M-2).
export const dynamic = 'force-dynamic';

type RequestRow = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  created_at: string;
};

export default async function CreatorRequestsPage() {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creator_requests')
    .select('id, email, name, status, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = (data ?? []) as RequestRow[];
  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending');

  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Creator requests</h1>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        Pending <span style={{ opacity: 0.5, fontWeight: 400 }}>({pending.length})</span>
      </h2>
      {pending.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No pending requests.</p>
      ) : (
        <RequestTable rows={pending} />
      )}

      {decided.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: '24px 0 8px' }}>
            Decided <span style={{ opacity: 0.5, fontWeight: 400 }}>({decided.length})</span>
          </h2>
          <RequestTable rows={decided} />
        </>
      )}
    </main>
  );
}

function RequestTable({ rows }: { rows: RequestRow[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th align="left">Email</th>
          <th align="left">Name</th>
          <th align="left">Status</th>
          <th align="left">Submitted</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: '1px solid #222' }}>
            <td>{r.email}</td>
            <td>{r.name ?? '—'}</td>
            <td>{r.status}</td>
            <td>{new Date(r.created_at).toLocaleString()}</td>
            <td>
              <a href={`/admin/requests/${r.id}`}>Review →</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
