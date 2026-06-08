import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { RequestReviewActions } from './review-actions';

// AUTHZ: admin gate enforced by src/app/admin/layout.tsx (load-bearing for this
// page's service-role read of lead PII). Do not render outside admin (audit M-2).
export const dynamic = 'force-dynamic';

type RequestDetail = {
  id: string;
  email: string;
  name: string | null;
  pitch: string | null;
  proof: unknown;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  internal_notes: string | null;
};

export default async function CreatorRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creator_requests')
    .select('id, email, name, pitch, proof, status, created_at, reviewed_at, internal_notes')
    .eq('id', id)
    .maybeSingle<RequestDetail>();

  if (!data) notFound();

  return (
    <main>
      <a href="/admin/requests" style={{ fontSize: 14, opacity: 0.7 }}>← Back</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8, marginBottom: 16 }}>
        {data.name ?? data.email}
      </h1>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><strong>Email:</strong> {data.email}</div>
        <div><strong>Status:</strong> {data.status}</div>
        <div><strong>Submitted:</strong> {new Date(data.created_at).toLocaleString()}</div>
        <div>
          <strong>Pitch:</strong>
          <p style={{ whiteSpace: 'pre-wrap' }}>{data.pitch ?? '—'}</p>
        </div>
        <div>
          <strong>Proof:</strong>
          <pre style={{ background: '#111', padding: 12, borderRadius: 6, overflow: 'auto' }}>
            {JSON.stringify(data.proof, null, 2)}
          </pre>
        </div>
        {data.internal_notes && (
          <div>
            <strong>Internal notes:</strong>
            <p style={{ whiteSpace: 'pre-wrap' }}>{data.internal_notes}</p>
          </div>
        )}
      </section>

      {data.status === 'pending' && <RequestReviewActions id={data.id} />}
    </main>
  );
}
