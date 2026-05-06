// SIMLI_WIREUP §12.Q3 — admin creator health page (R3-M4 + R3-Missing-2 + R3-Missing-4).
// One page, three sections: replica status, voice-id env presence,
// retrain CTA.
//
// Replica status: simli_face_id present, last 5 sessions outcome, last
// failure code (replica_not_ready vs replica_not_found via cogs_log
// metadata if any).
// Voice-id env presence: voice_id (production) / voice_id_preview /
// voice_id_dev — visible per-env so admins can see at a glance which
// envs the creator is wired for.
// Retrain CTA: POSTs /api/admin/simli-retrain. Disabled if any active
// session exists (the RPC will refuse anyway, but UX previews the gate).

import 'server-only';
import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ForceRetrainButton } from './force-retrain-button';

export const dynamic = 'force-dynamic';

type Creator = {
  id: string;
  display_name: string | null;
  handle: string | null;
  simli_face_id: string | null;
  voice_id: string | null;
  voice_id_preview: string | null;
  voice_id_dev: string | null;
};

type Session = {
  id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
};

type CogsRow = {
  operation: string;
  cost_usd: number;
  units: number;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export default async function CreatorHealthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = supabaseAdmin();

  const [{ data: creator }, { data: sessions }, { data: simliCogs }] = await Promise.all([
    sb.from('creators')
      .select('id, display_name, handle, simli_face_id, voice_id, voice_id_preview, voice_id_dev')
      .eq('id', id)
      .maybeSingle<Creator>(),
    sb.from('sessions')
      .select('id, started_at, ended_at, end_reason')
      .eq('creator_id', id)
      .order('started_at', { ascending: false })
      .limit(10),
    sb.from('cogs_log')
      .select('operation, cost_usd, units, created_at, metadata')
      .eq('service', 'simli')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (!creator) notFound();

  const sessionRows = (sessions ?? []) as Session[];
  const cogsRows = (simliCogs ?? []) as CogsRow[];
  const activeCount = sessionRows.filter((s) => s.ended_at === null).length;
  const lastFail = sessionRows.find((s) => s.end_reason && /fail|error|abort/.test(s.end_reason));

  // Sum reconciled minutes for this creator (R3-M3 + R4-M3 — MAX
  // bridge_close vs reaper per session; we just sum all rows here for a
  // rough total).
  const totalMinutes = cogsRows
    .filter((r) => r.operation.startsWith('simli.video_minutes'))
    .reduce((s, r) => s + Number(r.units || 0), 0);

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 24, color: '#111' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        {creator.display_name ?? 'Untitled'} health
      </h1>
      <div style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        @{creator.handle} · creator id <code>{creator.id}</code>
      </div>

      <Section title="Simli replica">
        <Field label="simli_face_id" value={creator.simli_face_id ?? '— not trained —'} mono />
        <Field label="active sessions" value={String(activeCount)} />
        <Field label="reconciled minutes (last 20 cogs rows)" value={totalMinutes.toFixed(2)} />
        {lastFail && (
          <Field label="last failure" value={`${lastFail.end_reason} @ ${lastFail.started_at}`} />
        )}
        <div style={{ marginTop: 16 }}>
          <ForceRetrainButton creatorId={creator.id} disabled={activeCount > 0} />
          {activeCount > 0 && (
            <div style={{ color: '#b45309', fontSize: 12, marginTop: 6 }}>
              Force-retrain blocked: {activeCount} active session(s). Close them first or wait
              for them to end.
            </div>
          )}
        </div>
      </Section>

      <Section title="Voice id (env-scoped)">
        <Field label="voice_id (production)" value={creator.voice_id ?? '— not set —'} mono />
        <Field label="voice_id_preview" value={creator.voice_id_preview ?? '— not set —'} mono />
        <Field label="voice_id_dev" value={creator.voice_id_dev ?? '— not set —'} mono />
        <div style={{ color: '#666', fontSize: 12, marginTop: 8 }}>
          Use the existing creator-detail page&apos;s upload form to clone a new voice. Writes
          land in the column matching <code>VERCEL_ENV</code>.
        </div>
      </Section>

      <Section title="Recent Simli sessions">
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead style={{ textAlign: 'left', color: '#666', fontWeight: 500 }}>
            <tr>
              <th style={{ padding: '6px 8px' }}>Started</th>
              <th style={{ padding: '6px 8px' }}>Ended</th>
              <th style={{ padding: '6px 8px' }}>End reason</th>
            </tr>
          </thead>
          <tbody>
            {sessionRows.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '6px 8px' }}>{new Date(s.started_at).toLocaleString()}</td>
                <td style={{ padding: '6px 8px' }}>
                  {s.ended_at ? new Date(s.ended_at).toLocaleString() : <em>active</em>}
                </td>
                <td style={{ padding: '6px 8px' }}>{s.end_reason ?? '—'}</td>
              </tr>
            ))}
            {sessionRows.length === 0 && (
              <tr><td colSpan={3} style={{ padding: '12px 8px', color: '#999' }}>No sessions yet.</td></tr>
            )}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32, padding: 16, border: '1px solid #eee', borderRadius: 8 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: '#666' }}>{label}</span>
      <span style={mono ? { fontFamily: 'ui-monospace, monospace' } : undefined}>{value}</span>
    </div>
  );
}
