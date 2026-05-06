import 'server-only';
import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { VoiceCloneUpload } from './voice-clone-upload';
import { FaceUpload } from './face-upload';

export const dynamic = 'force-dynamic';

// Read-only creator brain-status surface (Days 13-14 handoff §3):
//   - Brain-training job state (brain_status enum).
//   - Sample content indexed count per topic drawer.
//   - Cartesia voice_id presence + last clone upload timestamp.
// No re-trigger actions — handoff says not to add them unless asked.

type Creator = {
  id: string;
  handle: string | null;
  display_name: string | null;
  creator_type: string;
  brain_status: string;
  voice_id: string | null;
  simli_face_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  application_id: string | null;
  bio: string | null;
};

type Topic = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  sort_order: number;
};

type SampleRow = {
  id: string;
  source_type: string;
  topic_tags: string[];
  fetch_status: string;
  fetched_at: string | null;
  created_at: string;
};

type VoiceUpload = {
  id: number;
  cartesia_voice_id: string | null;
  bytes: number;
  created_at: string;
};

type PendingFaceUpload = {
  id: number;
  vendor_face_id: string | null;
  created_at: string;
};

type TimeoutOrphanUpload = {
  id: number;
  created_at: string;
  last_error: string | null;
};

export default async function AdminCreatorDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = supabaseAdmin();

  const [{ data: creator }, { data: topics }, { data: samples }] = await Promise.all([
    sb.from('creators')
      .select('id, handle, display_name, creator_type, brain_status, voice_id, simli_face_id, published_at, created_at, updated_at, application_id, bio')
      .eq('id', id)
      .maybeSingle<Creator>(),
    sb.from('creator_topics')
      .select('id, slug, title, description, sort_order')
      .eq('creator_id', id)
      .order('sort_order', { ascending: true }),
    sb.from('sample_content')
      .select('id, source_type, topic_tags, fetch_status, fetched_at, created_at')
      .eq('creator_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (!creator) notFound();

  const topicRows = (topics ?? []) as Topic[];
  const sampleRows = (samples ?? []) as SampleRow[];

  // voice_clone_uploads.creator_id is the indexed FK to creators.id (see
  // 20260427000003_voice_clone_uploads.sql). admin_user_id is the uploader
  // (always an admin) — filtering by that returns the wrong rows.
  const { data: uploads } = await sb
    .from('voice_clone_uploads')
    .select('id, cartesia_voice_id, bytes, created_at')
    .eq('creator_id', id)
    .order('created_at', { ascending: false })
    .limit(5);
  const uploadRows = (uploads ?? []) as VoiceUpload[];
  const latestUpload = uploadRows[0] ?? null;

  // Auditor R2-M1 — surface the most recent pending face upload so the
  // FaceUpload cell can resume polling after a tab close / page refresh.
  // Indexed by face_clone_uploads_creator_pending_idx.
  const { data: pendingFace } = await sb
    .from('face_clone_uploads')
    .select('id, vendor_face_id, created_at')
    .eq('creator_id', id)
    .eq('state', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<PendingFaceUpload>();

  // Path C — surface failed-timeout rows so the FaceUpload cell can offer
  // recovery (admin pastes the orphan face_id from Simli Studio). Only
  // looking at last 24h to keep stale ancient timeouts off the UI.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: orphanRows } = await sb
    .from('face_clone_uploads')
    .select('id, created_at, last_error')
    .eq('creator_id', id)
    .eq('state', 'failed')
    .gt('created_at', since)
    .ilike('last_error', '%timeout%')
    .is('vendor_face_id', null)
    .order('created_at', { ascending: false })
    .limit(1);
  const orphan = (orphanRows && orphanRows.length > 0)
    ? (orphanRows[0] as TimeoutOrphanUpload)
    : null;

  // Per-topic sample counts: sample.topic_tags[] may include multiple slugs.
  // Count a sample toward a topic if that topic's slug is in topic_tags.
  const perTopic = new Map<string, { total: number; ready: number; errored: number }>();
  for (const t of topicRows) perTopic.set(t.slug, { total: 0, ready: 0, errored: 0 });
  for (const s of sampleRows) {
    for (const tag of s.topic_tags ?? []) {
      const bucket = perTopic.get(tag);
      if (!bucket) continue;
      bucket.total += 1;
      if (s.fetch_status === 'ready') bucket.ready += 1;
      if (s.fetch_status === 'errored') bucket.errored += 1;
    }
  }

  const readySamples = sampleRows.filter((s) => s.fetch_status === 'ready').length;
  const erroredSamples = sampleRows.filter((s) => s.fetch_status === 'errored').length;

  return (
    <main>
      <a href="/admin/creators" style={{ fontSize: 13, opacity: 0.7 }}>← Creators</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8, marginBottom: 4 }}>
        {creator.handle ? `@${creator.handle}` : creator.display_name ?? creator.id}
      </h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 24 }}>
        {creator.display_name ?? '—'} · type {creator.creator_type} · created {new Date(creator.created_at).toLocaleDateString()}
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Brain status</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
          <StatusCell label="brain_status" value={creator.brain_status} />
          <StatusCell label="published_at" value={creator.published_at ? new Date(creator.published_at).toLocaleString() : '—'} />
          <StatusCell label="updated_at" value={new Date(creator.updated_at).toLocaleString()} />
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Voice clone</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
          <StatusCell label="cartesia voice_id" value={creator.voice_id ?? '—'} mono />
          <StatusCell label="simli face_id" value={creator.simli_face_id ?? '—'} mono />
          <StatusCell
            label="last clone upload"
            value={
              latestUpload
                ? `${new Date(latestUpload.created_at).toLocaleString()} · ${(latestUpload.bytes / 1024).toFixed(0)} KB`
                : 'none yet'
            }
          />
        </div>
        <VoiceCloneUpload creatorId={creator.id} hasExistingVoice={!!creator.voice_id} />
        {uploadRows.length > 1 && (
          <details style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
            <summary>Earlier uploads ({uploadRows.length - 1})</summary>
            <ul style={{ marginTop: 6 }}>
              {uploadRows.slice(1).map((u) => (
                <li key={u.id}>
                  {new Date(u.created_at).toLocaleString()} · {(u.bytes / 1024).toFixed(0)} KB
                  {u.cartesia_voice_id ? ` · ${u.cartesia_voice_id.slice(0, 12)}…` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
        <FaceUpload
          creatorId={creator.id}
          hasExistingFace={!!creator.simli_face_id}
          existingFaceId={creator.simli_face_id}
          pendingUpload={pendingFace && pendingFace.vendor_face_id ? {
            uploadId: pendingFace.id,
            vendorFaceId: pendingFace.vendor_face_id,
            createdAt: pendingFace.created_at,
          } : null}
          timeoutOrphan={orphan ? {
            uploadId: orphan.id,
            createdAt: orphan.created_at,
            lastError: orphan.last_error,
          } : null}
        />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          Topic drawers
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}> ({topicRows.length}/5)</span>
        </h2>
        {topicRows.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>No topics.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">#</th>
                <th align="left">Slug</th>
                <th align="left">Title</th>
                <th align="right">Samples</th>
                <th align="right">Ready</th>
                <th align="right">Errored</th>
              </tr>
            </thead>
            <tbody>
              {topicRows.map((t) => {
                const counts = perTopic.get(t.slug) ?? { total: 0, ready: 0, errored: 0 };
                return (
                  <tr key={t.id} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ opacity: 0.5 }}>{t.sort_order}</td>
                    <td><code style={{ fontSize: 12 }}>{t.slug}</code></td>
                    <td>{t.title}</td>
                    <td align="right">{counts.total}</td>
                    <td align="right" style={{ color: counts.ready > 0 ? 'lightgreen' : undefined }}>{counts.ready}</td>
                    <td align="right" style={{ color: counts.errored > 0 ? 'salmon' : undefined }}>{counts.errored}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          Sample content
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}>
            {' '}({sampleRows.length} total · {readySamples} ready · {erroredSamples} errored)
          </span>
        </h2>
        {sampleRows.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>No sample content submitted.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">Source</th>
                <th align="left">Topics</th>
                <th align="left">Fetch status</th>
                <th align="left">Fetched</th>
                <th align="left">Added</th>
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid #222' }}>
                  <td style={{ opacity: 0.8 }}>{s.source_type}</td>
                  <td style={{ opacity: 0.7, fontSize: 12 }}>{(s.topic_tags ?? []).join(', ')}</td>
                  <td>{s.fetch_status}</td>
                  <td style={{ opacity: 0.7 }}>{s.fetched_at ? new Date(s.fetched_at).toLocaleString() : '—'}</td>
                  <td style={{ opacity: 0.7 }}>{new Date(s.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function StatusCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{
      padding: '6px 10px',
      border: '1px solid #222',
      borderRadius: 6,
      minWidth: 180,
    }}>
      <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: 13, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}
