'use client';

// /admin/creators/[id] — FIVE_CREATOR_ONBOARDING_READINESS P0-3 consent panel.
//
// Shows which consent types are on record for the creator's user, and offers
// an admin attest-on-behalf override (POST /api/admin/creator-consent →
// admin_attest_creator_consent) for voice_clone / likeness when a creator
// consented out-of-band. The clone/face upload routes hard-block until the
// matching consent exists.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Present = {
  voice_clone: boolean;
  likeness: boolean;
  tos: boolean;
  content_license: boolean;
};

type Row = { consent_type: string; version: string; source: string; accepted_at: string; revoked_at: string | null };

export function ConsentPanel({
  creatorId,
  present,
  rows,
}: {
  creatorId: string;
  present: Present;
  rows: Row[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(
    consentType: 'voice_clone' | 'likeness' | 'content_license',
    action: 'attest' | 'revoke',
  ) {
    if (busy) return;
    const ok = window.confirm(
      action === 'attest'
        ? `Record attest-on-behalf for "${consentType}"? Only do this when the creator ` +
          `has consented out-of-band (email/call). This is logged with your admin id.`
        : `Revoke "${consentType}" consent? This blocks new ${consentType === 'likeness' ? 'face uploads' : 'voice clones'} ` +
          `AND immediately UNPUBLISHES the creator (removes them from the feed + stops new sessions) ` +
          `until consent is recorded and they are re-published. Logged with your admin id.`,
    );
    if (!ok) return;
    setBusy(`${action}:${consentType}`);
    setError(null);
    try {
      const res = await fetch('/api/admin/creator-consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId, consent_type: consentType, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(String(body?.error ?? `http_${res.status}`)); return; }
      router.refresh();
    } catch (e) {
      setError((e as Error).message ?? 'network_error');
    } finally {
      setBusy(null);
    }
  }

  const chips: { label: string; ok: boolean }[] = [
    { label: 'voice_clone', ok: present.voice_clone },
    { label: 'likeness', ok: present.likeness },
    { label: 'tos', ok: present.tos },
    { label: 'content_license', ok: present.content_license },
  ];

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, marginBottom: 10 }}>
        {chips.map((c) => (
          <span
            key={c.label}
            style={{
              padding: '4px 10px',
              border: `1px solid ${c.ok ? '#2aa35f' : '#a32a2a'}`,
              color: c.ok ? 'lightgreen' : 'salmon',
              borderRadius: 4,
            }}
          >
            {c.ok ? '✓' : '✗'} {c.label}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {(['voice_clone', 'likeness', 'content_license'] as const).map((t) =>
          present[t] ? (
            <button
              key={t}
              type="button"
              onClick={() => mutate(t, 'revoke')}
              disabled={busy !== null}
              style={{
                padding: '5px 11px',
                fontSize: 12,
                background: busy === `revoke:${t}` ? '#222' : 'transparent',
                color: '#d66',
                border: '1px solid #a32a2a',
                borderRadius: 4,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {busy === `revoke:${t}` ? 'Revoking…' : `Revoke ${t}`}
            </button>
          ) : (
            <button
              key={t}
              type="button"
              onClick={() => mutate(t, 'attest')}
              disabled={busy !== null}
              style={{
                padding: '5px 11px',
                fontSize: 12,
                background: busy === `attest:${t}` ? '#222' : 'transparent',
                color: '#d6a44a',
                border: '1px solid #a3742a',
                borderRadius: 4,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {busy === `attest:${t}` ? 'Recording…' : `Attest ${t} on behalf`}
            </button>
          ),
        )}
        {error && <span style={{ fontSize: 12, color: '#ff6b6b', alignSelf: 'center' }}>error: {error}</span>}
      </div>

      {rows.length > 0 && (
        <details style={{ fontSize: 12, opacity: 0.85 }}>
          <summary style={{ cursor: 'pointer' }}>Consent records ({rows.length})</summary>
          <ul style={{ marginTop: 6 }}>
            {rows.map((r, i) => (
              <li key={i} style={{ opacity: r.revoked_at ? 0.55 : 1 }}>
                <code style={{ fontSize: 11 }}>{r.consent_type}</code> · v{r.version} ·{' '}
                {r.source} · {new Date(r.accepted_at).toLocaleString()}
                {r.revoked_at && (
                  <span style={{ color: 'salmon' }}> · revoked {new Date(r.revoked_at).toLocaleString()}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
