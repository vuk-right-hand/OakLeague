import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ResolveButton } from './reports-client';

export const dynamic = 'force-dynamic';

type ReportRow = {
  id: string;
  target_kind: 'hook' | 'video' | 'creator' | 'comment';
  target_id: string;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
};

// Best-effort deep link to the target so triage is one click.
function targetHref(kind: ReportRow['target_kind'], id: string): string | null {
  switch (kind) {
    case 'video':
      return `/admin/content/videos/${id}`;
    case 'creator':
      return `/admin/creators/${id}`;
    default:
      return null; // hook/comment have no standalone admin page
  }
}

export default async function ContentReportsPage() {
  const sb = supabaseAdmin();
  const [{ data: open }, { data: recent }] = await Promise.all([
    sb
      .from('content_reports')
      .select('id, target_kind, target_id, reason, created_at, resolved_at')
      .is('resolved_at', null)
      .order('created_at', { ascending: false })
      .limit(200),
    sb
      .from('content_reports')
      .select('id, target_kind, target_id, reason, created_at, resolved_at')
      .not('resolved_at', 'is', null)
      .order('resolved_at', { ascending: false })
      .limit(50),
  ]);

  const openRows = (open ?? []) as ReportRow[];
  const recentRows = (recent ?? []) as ReportRow[];

  return (
    <section>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Content reports</h1>
      <p style={{ fontSize: 13, opacity: 0.65, marginBottom: 20, lineHeight: 1.5 }}>
        Public reports on feed content. Panic path for a bad creator = unpublish the
        creator on their <Link href="/admin/creators">profile</Link> (cascades to hide all
        their hooks + welcome). Resolving here only clears the report from the queue.
      </p>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Open ({openRows.length})</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {openRows.map((r) => (
          <li key={r.id} style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <div>
                <strong style={{ textTransform: 'capitalize' }}>{r.target_kind}</strong>{' '}
                {targetHref(r.target_kind, r.target_id) ? (
                  <Link href={targetHref(r.target_kind, r.target_id)!} style={{ fontSize: 12 }}>
                    {r.target_id}
                  </Link>
                ) : (
                  <code style={{ fontSize: 12, opacity: 0.7 }}>{r.target_id}</code>
                )}
              </div>
              <ResolveButton reportId={r.id} />
            </div>
            {r.reason && <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>{r.reason}</div>}
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
              {new Date(r.created_at).toLocaleString()}
            </div>
          </li>
        ))}
        {openRows.length === 0 && <li style={{ opacity: 0.6, fontSize: 14 }}>No open reports.</li>}
      </ul>

      {recentRows.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: '24px 0 8px' }}>Recently resolved</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recentRows.map((r) => (
              <li key={r.id} style={{ fontSize: 13, opacity: 0.6 }}>
                <span style={{ textTransform: 'capitalize' }}>{r.target_kind}</span>{' '}
                <code style={{ fontSize: 11 }}>{r.target_id.slice(0, 8)}…</code>
                {r.reason ? ` — ${r.reason.slice(0, 80)}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
