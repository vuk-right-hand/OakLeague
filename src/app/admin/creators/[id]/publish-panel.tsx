'use client';

// /admin/creators/[id] — FIVE_CREATOR_ONBOARDING_READINESS P0-1 publish panel.
//
// Renders a readiness checklist (each precondition the admin_set_creator_published
// RPC enforces) + a Publish / Unpublish button. The button POSTs to
// /api/admin/creator-publish. Publish is enabled only when every precondition
// is green AND the creator isn't already published. Unpublish (shown when
// published) carries a confirm() guard — it is a takedown that STOPS new
// sessions (the C3 session-open gate), not just a feed-hide.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Readiness = {
  voice: boolean;
  face: boolean;
  persona: boolean;
  notErrored: boolean;
  corpus: boolean;
  // null when not applicable (drawer mode or v1 vector); boolean otherwise.
  v2Chunks: boolean | null;
  // Active (non-revoked) voice/likeness consent — the publish RPC enforces these.
  voiceConsent: boolean;
  likenessConsent: boolean;
};

// 422 precondition codes → admin-readable copy. Mirrors the RPC RAISE messages.
const CODE_COPY: Record<string, string> = {
  voice_not_cloned: 'No cloned voice — upload a WAV in the Voice clone section.',
  face_not_uploaded: 'No avatar face — upload one in the Voice clone section.',
  brain_not_compiled: 'Persona not compiled — recompile the brain.',
  brain_errored: 'Brain is in an errored state — investigate before publishing.',
  no_corpus: 'No knowledge yet — the creator must add sample content with text.',
  no_v2_chunks: 'v2 retrieval is on but no embedded chunks exist — run corpus re-process and wait for it to finish.',
  voice_consent_missing: 'No active voice_clone consent — it may have been revoked. Record it in the Consent panel.',
  likeness_consent_missing: 'No active likeness consent — it may have been revoked. Record it in the Consent panel.',
  creator_not_found: 'Creator not found — refresh the page.',
  bad_publish: 'Bad request — refresh and retry.',
  forbidden: 'Your admin role was not accepted — re-log in.',
  publish_failed: 'Server error — retry; if it persists, check Sentry.',
};

export function PublishPanel({
  creatorId,
  initialPublishedAt,
  readiness,
}: {
  creatorId: string;
  initialPublishedAt: string | null;
  readiness: Readiness;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publishedAt = initialPublishedAt;

  const checks: { label: string; ok: boolean }[] = [
    { label: 'Cloned voice', ok: readiness.voice },
    { label: 'Avatar face', ok: readiness.face },
    { label: 'Persona compiled', ok: readiness.persona },
    { label: 'Brain not errored', ok: readiness.notErrored },
    { label: 'Knowledge (≥1 source with text)', ok: readiness.corpus },
    { label: 'Voice consent (active)', ok: readiness.voiceConsent },
    { label: 'Likeness consent (active)', ok: readiness.likenessConsent },
  ];
  if (readiness.v2Chunks !== null) {
    checks.push({ label: 'Embedded v2 chunks', ok: readiness.v2Chunks });
  }
  const allReady = checks.every((c) => c.ok);

  async function submit(publish: boolean) {
    if (busy) return;
    if (!publish) {
      const ok = window.confirm(
        'Unpublish removes this creator from the feed AND blocks new sessions ' +
        '(existing sessions are not killed). Continue?',
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/creator-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId, publish }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = String(body?.error ?? `http_${res.status}`);
        setError(CODE_COPY[code] ?? code);
        return;
      }
      // Reflect the new published_at / brain_status in the SSR'd page.
      router.refresh();
    } catch (e) {
      setError((e as Error).message ?? 'network_error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, marginBottom: 10 }}>
        {checks.map((c) => (
          <span
            key={c.label}
            style={{
              padding: '4px 10px',
              border: `1px solid ${c.ok ? '#2aa35f' : '#a32a2a'}`,
              color: c.ok ? 'lightgreen' : 'salmon',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            {c.ok ? '✓' : '✗'} {c.label}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 13, opacity: 0.8 }}>
          {publishedAt
            ? `Published ${new Date(publishedAt).toLocaleString()}`
            : 'Not published'}
        </span>
        {!publishedAt ? (
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={busy || !allReady}
            title={allReady ? 'Publish — sets brain ready + adds to feed' : 'Resolve every checklist item first'}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              background: busy || !allReady ? '#222' : '#1a6e3d',
              color: '#fff',
              border: '1px solid #2aa35f',
              borderRadius: 4,
              cursor: busy ? 'wait' : !allReady ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={busy}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              background: busy ? '#222' : '#6e1a1a',
              color: '#fff',
              border: '1px solid #a32a2a',
              borderRadius: 4,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? 'Unpublishing…' : 'Unpublish'}
          </button>
        )}
        {error && <span style={{ fontSize: 12, color: '#ff6b6b' }}>{error}</span>}
      </div>
    </div>
  );
}
