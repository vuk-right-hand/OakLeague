import 'server-only';
import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { VoiceCloneUpload } from './voice-clone-upload';
import { FaceUpload } from './face-upload';
import { BrainRecompileButton } from './brain-recompile-button';
import { CorpusReprocessPanel } from './corpus-reprocess-panel';
import { CorpusComparePanel } from './corpus-compare-panel';
import { TtsProviderPanel } from './tts-provider-panel';
import { PublishPanel } from './publish-panel';
import { ConsentPanel } from './consent-panel';
import { LegacyLifecyclePanel } from './legacy-lifecycle-panel';

export const dynamic = 'force-dynamic';

// Read-only creator brain-status surface (Days 13-14 handoff §3):
//   - Brain-training job state (brain_status enum).
//   - Sample content indexed count per topic drawer.
//   - Cartesia voice_id presence + last clone upload timestamp.
// No re-trigger actions — handoff says not to add them unless asked.

type Creator = {
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
  updated_at: string;
  application_id: string | null;
  bio: string | null;
  // Brain wire-up PR-3.
  system_prompt: string | null;
  brain_compiled_at: string | null;
  // RAG SOTA Day-6: retrieval_version (1=legacy, 2=v2 hybrid, 3=v3 routed).
  // Defaults to 1 for every creator until admin flips it post-corpus-reprocess.
  retrieval_version: number;
  // Step-9 M5: stamped by admin_purge_legacy_chunks. Non-NULL ⇒ legacy v1/v2
  // corpus deleted ⇒ rollback off v3 is refused. Drives the lifecycle panel.
  legacy_purged_at: string | null;
  // pgvector RAG (M2). 'drawer' | 'vector'. Drives whether the publish
  // readiness gate requires embedded v2 chunks (only for vector + v2).
  brain_mode: 'drawer' | 'vector';
  // HUME_TTS_PLAN §6.11. NULL on tts_provider = inherit env.
  // Audit S5 (unit-wide) — all three env-scoped Hume columns selected so
  // the status cells can display the env that matches the admin's current
  // deploy (preview admins see preview values, not stale prod values).
  tts_provider: 'cartesia' | 'hume' | null;
  hume_voice_id: string | null;
  hume_voice_id_preview: string | null;
  hume_voice_id_dev: string | null;
  hume_voice_name: string | null;
  hume_voice_name_preview: string | null;
  hume_voice_name_dev: string | null;
  hume_tts_speed: number | string | null;
  hume_tts_speed_preview: number | string | null;
  hume_tts_speed_dev: number | string | null;
  hume_trailing_silence: number | string | null;
  hume_trailing_silence_preview: number | string | null;
  hume_trailing_silence_dev: number | string | null;
  hume_voice_description: string | null;
  hume_voice_description_preview: string | null;
  hume_voice_description_dev: string | null;
  hume_model_version: '1' | '2' | 'default' | null;
  hume_model_version_preview: '1' | '2' | 'default' | null;
  hume_model_version_dev: '1' | '2' | 'default' | null;
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
      .select(`
        id, user_id, handle, display_name, creator_type, brain_status, voice_id,
        simli_face_id, published_at, created_at, updated_at, application_id,
        bio, system_prompt, brain_compiled_at, retrieval_version, legacy_purged_at, brain_mode,
        tts_provider,
        hume_voice_id, hume_voice_id_preview, hume_voice_id_dev,
        hume_voice_name, hume_voice_name_preview, hume_voice_name_dev,
        hume_tts_speed, hume_tts_speed_preview, hume_tts_speed_dev,
        hume_trailing_silence, hume_trailing_silence_preview, hume_trailing_silence_dev,
        hume_voice_description, hume_voice_description_preview, hume_voice_description_dev,
        hume_model_version, hume_model_version_preview, hume_model_version_dev
      `)
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

  // Audit S5 (unit-wide) — env-aware Hume column selection. VERCEL_ENV is
  // 'production' | 'preview' | undefined (dev/local). The status display +
  // panel initial values render the matching env's columns so a preview
  // deploy admin sees preview values, not stale prod values.
  const vercelEnv = process.env.VERCEL_ENV;
  const currentEnv: 'production' | 'preview' | 'development' =
    vercelEnv === 'production' ? 'production'
    : vercelEnv === 'preview'  ? 'preview'
    :                            'development';
  const envLabel = currentEnv === 'production' ? 'prod' : currentEnv === 'preview' ? 'preview' : 'dev';
  const envHumeVoiceId   = currentEnv === 'production' ? creator.hume_voice_id
                         : currentEnv === 'preview'    ? creator.hume_voice_id_preview
                         :                               creator.hume_voice_id_dev;
  const envHumeVoiceName = currentEnv === 'production' ? creator.hume_voice_name
                         : currentEnv === 'preview'    ? creator.hume_voice_name_preview
                         :                               creator.hume_voice_name_dev;
  const envHumeSpeed     = currentEnv === 'production' ? creator.hume_tts_speed
                         : currentEnv === 'preview'    ? creator.hume_tts_speed_preview
                         :                               creator.hume_tts_speed_dev;
  const envHumeSilence   = currentEnv === 'production' ? creator.hume_trailing_silence
                         : currentEnv === 'preview'    ? creator.hume_trailing_silence_preview
                         :                               creator.hume_trailing_silence_dev;
  const envHumeDescription = currentEnv === 'production' ? creator.hume_voice_description
                           : currentEnv === 'preview'    ? creator.hume_voice_description_preview
                           :                               creator.hume_voice_description_dev;
  const envHumeModel     = currentEnv === 'production' ? creator.hume_model_version
                         : currentEnv === 'preview'    ? creator.hume_model_version_preview
                         :                               creator.hume_model_version_dev;

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

  // P0-1 publish readiness. The corpus check is "≥1 sample with raw_text" —
  // the SAME gate the reprocess/enqueue + publish RPC use (NOT fetch_status,
  // which nothing sets to 'ready' for real creators — auditor M5). The v2
  // chunk check only matters for vector + retrieval_version=2 creators
  // (auditor C1: a populated narrative unit with un-embedded children
  // retrieves nothing, so gate on embedded children).
  // Auditor M4: capture errors — a swallowed count failure would render a
  // misleading red check the publish RPC (which uses EXISTS, not count) might
  // actually accept. The checklist button is advisory; the RPC is the real
  // gate, so red-on-error is fail-closed, but we log so the discrepancy is
  // visible rather than silent.
  const { count: corpusCount, error: corpusErr } = await sb
    .from('sample_content')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', id)
    .not('raw_text', 'is', null);
  if (corpusErr) console.error('[admin/creators] corpus readiness count failed', corpusErr);

  const isVectorV2 = creator.brain_mode === 'vector' && creator.retrieval_version === 2;
  let v2ChunksOk: boolean | null = null;
  if (isVectorV2) {
    const { count: v2Count, error: v2Err } = await sb
      .from('sample_content_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', id)
      .eq('chunker_version', 2)
      .not('embedding', 'is', null);
    if (v2Err) console.error('[admin/creators] v2 chunk readiness count failed', v2Err);
    v2ChunksOk = (v2Count ?? 0) > 0;
  }

  // P0-3 consent status — which consent types are ACTIVE (revoked_at IS NULL)
  // for this creator's user. Holistic-audit M3: select revoked_at and treat a
  // revoked row as NOT present, else the panel shows a withdrawn consent as
  // green and the publish checklist looks ready when it isn't.
  const { data: consentRows } = await sb
    .from('creator_consents')
    .select('consent_type, version, source, accepted_at, revoked_at')
    .eq('user_id', creator.user_id)
    .order('accepted_at', { ascending: false });
  const activeConsentTypes = new Set(
    (consentRows ?? []).filter((r) => r.revoked_at == null).map((r) => r.consent_type as string),
  );

  // Publish readiness — includes ACTIVE voice/likeness consent (holistic-audit
  // C1/M3): a creator cloned-then-revoked still has voice_id/face_id, so consent
  // must be a first-class checklist item, matching the publish RPC's new
  // voice_consent_missing / likeness_consent_missing preconditions.
  const readiness = {
    voice: !!creator.voice_id,
    face: !!creator.simli_face_id,
    persona: creator.system_prompt !== null,
    notErrored: creator.brain_status !== 'errored',
    corpus: (corpusCount ?? 0) > 0,
    v2Chunks: v2ChunksOk,
    voiceConsent: activeConsentTypes.has('voice_clone'),
    likenessConsent: activeConsentTypes.has('likeness'),
  };

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
          <StatusCell label="retrieval_version" value={`v${creator.retrieval_version}`} />
          <StatusCell label="published_at" value={creator.published_at ? new Date(creator.published_at).toLocaleString() : '—'} />
          <StatusCell label="updated_at" value={new Date(creator.updated_at).toLocaleString()} />
          <StatusCell
            label="system_prompt"
            value={creator.system_prompt
              ? `${Buffer.byteLength(creator.system_prompt, 'utf8')} bytes`
              : '— (not compiled)'}
          />
          <StatusCell
            label="brain_compiled_at"
            value={creator.brain_compiled_at ? new Date(creator.brain_compiled_at).toLocaleString() : '— (never)'}
          />
        </div>
        <BrainRecompileButton
          creatorId={creator.id}
          initialCompiledAt={creator.brain_compiled_at}
          initialPromptLength={creator.system_prompt
            ? Buffer.byteLength(creator.system_prompt, 'utf8')
            : null}
        />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          Publication
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}>
            {' '}— gate the creator into the feed once every check is green
          </span>
        </h2>
        <PublishPanel
          creatorId={creator.id}
          initialPublishedAt={creator.published_at}
          readiness={readiness}
        />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          Corpus re-process (v2)
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}>
            {' '}— enqueue full v2 pipeline for every ready sample
          </span>
        </h2>
        <CorpusReprocessPanel creatorId={creator.id} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          v3 soft-cutover lifecycle
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}>
            {' '}— purge dormant v1/v2 after a v3 soak · GC old v3 generations
          </span>
        </h2>
        <LegacyLifecyclePanel
          creatorId={creator.id}
          initialLegacyPurgedAt={creator.legacy_purged_at}
        />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          Corpus compare v1 ↔ v2
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}>
            {' '}— ask a question, see top-5 chunks from each pipeline side-by-side
          </span>
        </h2>
        <CorpusComparePanel creatorId={creator.id} retrievalVersion={creator.retrieval_version} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          Consent
          <span style={{ opacity: 0.5, fontSize: 13, fontWeight: 400 }}>
            {' '}— voice/likeness required before cloning; attest if given out-of-band
          </span>
        </h2>
        <ConsentPanel
          creatorId={creator.id}
          present={{
            voice_clone: activeConsentTypes.has('voice_clone'),
            likeness: activeConsentTypes.has('likeness'),
            tos: activeConsentTypes.has('tos'),
            content_license: activeConsentTypes.has('content_license'),
          }}
          rows={(consentRows ?? []).map((r) => ({
            consent_type: r.consent_type as string,
            version: r.version as string,
            source: r.source as string,
            accepted_at: r.accepted_at as string,
            revoked_at: (r.revoked_at as string | null) ?? null,
          }))}
        />
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

      {/* Audit S5 (unit-wide) — env-aware Hume status display. The panel
          writes whichever env the deploy is in (NEXT_PUBLIC_VERCEL_ENV via
          tts-provider-panel.tsx). Status cells render the matching env's
          values so the admin doesn't see stale prod values on a preview
          deploy. */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          TTS routing
          <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 8, opacity: 0.7 }}>
            (env: {currentEnv})
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, marginBottom: 8 }}>
          <StatusCell label="tts_provider override" value={creator.tts_provider ?? '— (inherit env)'} />
          <StatusCell label={`hume voice_id (${envLabel})`} value={envHumeVoiceId ?? '—'} mono />
          <StatusCell label={`hume voice_name (${envLabel})`} value={envHumeVoiceName ?? '—'} />
          <StatusCell
            label={`hume speed (${envLabel})`}
            value={envHumeSpeed != null ? String(envHumeSpeed) : '— (default 1.0)'}
          />
          <StatusCell
            label={`hume trailing silence (${envLabel})`}
            value={envHumeSilence != null ? String(envHumeSilence) : '— (default 0.3)'}
          />
          <StatusCell label={`hume model (${envLabel})`} value={envHumeModel ?? '2 (default)'} />
        </div>
        <TtsProviderPanel
          creatorId={creator.id}
          initialTtsProvider={creator.tts_provider}
          initialHumeVoiceId={envHumeVoiceId}
          initialHumeVoiceName={envHumeVoiceName}
          initialHumeTtsSpeed={
            envHumeSpeed == null
              ? null
              : (typeof envHumeSpeed === 'number'
                  ? envHumeSpeed
                  : Number(envHumeSpeed))
          }
          initialHumeTrailingSilence={
            envHumeSilence == null
              ? null
              : (typeof envHumeSilence === 'number'
                  ? envHumeSilence
                  : Number(envHumeSilence))
          }
          initialHumeVoiceDescription={envHumeDescription}
          initialHumeModelVersion={envHumeModel as '1' | '2' | 'default' | null}
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
