import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ReviewActions } from './review-actions';

type AppDetail = {
  id: string;
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  topics: unknown;
  proof: unknown;
  status: string;
  submitted_at: string;
  invitation_id: string | null;
  internal_notes: string | null;
};

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creator_applications')
    .select('id, user_id, handle, display_name, bio, topics, proof, status, submitted_at, invitation_id, internal_notes')
    .eq('id', id)
    .maybeSingle<AppDetail>();

  if (!data) notFound();

  return (
    <main>
      <a href="/admin/applications" style={{ fontSize: 14, opacity: 0.7 }}>← Back</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8, marginBottom: 16 }}>
        @{data.handle} — {data.display_name}
      </h1>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><strong>Status:</strong> {data.status}</div>
        <div><strong>Submitted:</strong> {new Date(data.submitted_at).toLocaleString()}</div>
        <div>
          <strong>Bio:</strong>
          <p style={{ whiteSpace: 'pre-wrap' }}>{data.bio ?? '—'}</p>
        </div>
        <div>
          <strong>Topics:</strong>
          <pre style={{ background: '#111', padding: 12, borderRadius: 6, overflow: 'auto' }}>
            {JSON.stringify(data.topics, null, 2)}
          </pre>
        </div>
        <div>
          <strong>Proof:</strong>
          <pre style={{ background: '#111', padding: 12, borderRadius: 6, overflow: 'auto' }}>
            {JSON.stringify(data.proof, null, 2)}
          </pre>
        </div>
      </section>

      {(data.status === 'submitted' || data.status === 'under_review') && (
        <ReviewActions id={data.id} />
      )}
    </main>
  );
}
