'use client';

// /admin/creators/[id] — v3 soft-cutover lifecycle panel (Step-9 M5).
//
// Two DESTRUCTIVE admin actions, only meaningful once a creator is live on v3:
//   * "Purge legacy v1/v2 chunks" — admin_purge_legacy_chunks. Deletes the
//     dormant pre-v3 corpus AFTER a v3 soak. IRREVERSIBLE: it stamps
//     legacy_purged_at, after which a rollback OFF v3 is permanently refused
//     (the corpus it would roll back to is gone). Gated behind TYPE-TO-CONFIRM.
//   * "GC old v3 generations" — admin_gc_stale_section_generations. Reclaims v3
//     generations below active-1 (keeps active + immediately-prior for rollback).
//     Recoverable-ish (never touches active/prior); plain confirm.
//
// Both preview (GET) the count they WOULD affect before the admin commits. The
// preview is ADVISORY (read outside the RPC's lock) — the post-action result
// uses the RPC's RETURNED counts as truth. A preview that shows N and the action
// reports a different M is NOT an error (a finalize raced); we show the returned
// count plainly.
//
// AbortController on every fetch; mounted ref + seq guard so a stale response
// can't overwrite newer state (mirrors corpus-reprocess-panel.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';

type PurgePreview =
  | { available: false; reason: string; retrieval_version: number; legacy_purged_at: string | null }
  | {
      available: true;
      retrieval_version: number;
      legacy_purged_at: string | null;
      legacy_chunks: number;
      v2_narrative_units: number;
    };

type GcPreview = { available: true; stale_sections: number; capped?: boolean };

type PurgeResult = {
  legacy_chunks_deleted?: number;
  v2_narrative_units_deleted?: number;
  new_corpus_version?: number;
};
type GcResult = { stale_sections_deleted?: number; corpus_version?: number };

export function LegacyLifecyclePanel({
  creatorId,
  initialLegacyPurgedAt,
}: {
  creatorId: string;
  initialLegacyPurgedAt: string | null;
}) {
  const [purgePreview, setPurgePreview] = useState<PurgePreview | null>(null);
  const [gcPreview, setGcPreview] = useState<GcPreview | null>(null);
  const [purgedAt, setPurgedAt] = useState<string | null>(initialLegacyPurgedAt);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<'purge' | 'gc' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadPreviews = useCallback(async () => {
    const ac = new AbortController();
    try {
      const [pRes, gRes] = await Promise.all([
        fetch(`/api/admin/purge-legacy-chunks?creator_id=${encodeURIComponent(creatorId)}`,
          { signal: ac.signal, cache: 'no-store' }),
        fetch(`/api/admin/gc-section-generations?creator_id=${encodeURIComponent(creatorId)}`,
          { signal: ac.signal, cache: 'no-store' }),
      ]);
      const p = (await pRes.json()) as PurgePreview;
      const g = (await gRes.json()) as GcPreview;
      if (!mountedRef.current) return;
      if (pRes.ok) {
        setPurgePreview(p);
        if ('legacy_purged_at' in p && p.legacy_purged_at) setPurgedAt(p.legacy_purged_at);
      }
      if (gRes.ok) setGcPreview(g);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (mountedRef.current) setError((e as Error).message ?? 'preview_failed');
    }
  }, [creatorId]);

  useEffect(() => { void loadPreviews(); }, [loadPreviews]);

  const purge = useCallback(async () => {
    if (busy) return;
    // CODE-audit S2: re-check the type-to-confirm gate in the handler, not just
    // via the button's disabled attr (defense against a programmatic/stale click).
    if (confirmText.trim().toUpperCase() !== 'PURGE') return;
    setBusy('purge');
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/purge-legacy-chunks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId }),
      });
      const body = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(body.error === 'purge_refused_not_on_v3'
          ? 'Creator must be on v3 first.'
          : (body.error ?? `http_${res.status}`));
      } else {
        const r = (body.result ?? {}) as PurgeResult;
        // Optimistic purged-state: the RSC revalidate won't refresh this mounted
        // client, so flip locally — disables the purge button + shows rollback
        // is now disabled (matches the new legacy_purged_at the POST just set).
        setPurgedAt(new Date().toISOString());
        setConfirmText('');
        setResult(
          `Purged ${r.legacy_chunks_deleted ?? 0} legacy chunks + ${r.v2_narrative_units_deleted ?? 0} v2 units. ` +
          `corpus_version → ${r.new_corpus_version ?? '?'}. Rollback to v2 is now disabled.`,
        );
        void loadPreviews();
      }
    } catch (e) {
      if (mountedRef.current) setError((e as Error).message ?? 'network_error');
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [busy, creatorId, loadPreviews]);

  const gc = useCallback(async () => {
    if (busy) return;
    setBusy('gc');
    const ok = window.confirm(
      'GC will delete v3 section generations older than (active − 1), keeping the ' +
      'active + immediately-prior generation for rollback. Continue?',
    );
    if (!ok) { setBusy(null); return; }
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/gc-section-generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId }),
      });
      const body = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else {
        const r = (body.result ?? {}) as GcResult;
        setResult(`GC reclaimed ${r.stale_sections_deleted ?? 0} stale section(s). corpus_version → ${r.corpus_version ?? '?'}.`);
        void loadPreviews();
      }
    } catch (e) {
      if (mountedRef.current) setError((e as Error).message ?? 'network_error');
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [busy, creatorId, loadPreviews]);

  const onV3 = purgePreview?.available === true;
  const purgeCount = purgePreview?.available === true ? purgePreview.legacy_chunks : 0;
  const purgeUnits = purgePreview?.available === true ? purgePreview.v2_narrative_units : 0;
  const alreadyPurged = Boolean(purgedAt);
  const confirmOk = confirmText.trim().toUpperCase() === 'PURGE';

  return (
    <div style={{ marginTop: 12 }}>
      {/* ── Purge legacy ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {alreadyPurged ? (
            <span style={{ color: '#d6a44a' }}>
              ⚠️ Legacy purged{purgedAt ? ` on ${new Date(purgedAt).toLocaleString()}` : ''} — rollback to v2 is disabled.
            </span>
          ) : !purgePreview ? (
            <span style={{ opacity: 0.6 }}>Loading preview…</span>
          ) : !onV3 ? (
            <span style={{ opacity: 0.7 }}>
              Purge unavailable — creator is on v{purgePreview.available === false ? purgePreview.retrieval_version : '?'}, not v3.
              Flip to v3 first.
            </span>
          ) : (
            <span>
              Would delete <b>{purgeCount}</b> dormant v1/v2 chunk(s) + <b>{purgeUnits}</b> v2 unit(s).
              {' '}<span style={{ color: '#d6a44a' }}>This permanently disables rollback to v2.</span>
            </span>
          )}
        </div>
        {onV3 && !alreadyPurged && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="type PURGE to enable"
              disabled={busy !== null}
              style={{
                padding: '5px 8px', fontSize: 12, background: '#111', color: '#fff',
                border: '1px solid #444', borderRadius: 4, width: 170,
              }}
            />
            <button
              type="button"
              onClick={purge}
              disabled={busy !== null || !confirmOk}
              style={{
                padding: '6px 12px', fontSize: 13,
                background: busy === 'purge' ? '#222' : confirmOk ? '#6e1a1a' : '#2a2a2a',
                color: confirmOk ? '#fff' : '#777',
                border: '1px solid #a32a2a', borderRadius: 4,
                cursor: busy !== null || !confirmOk ? 'not-allowed' : 'pointer',
              }}
            >
              {busy === 'purge' ? 'Purging…' : 'Purge legacy v1/v2 chunks'}
            </button>
          </div>
        )}
      </div>

      {/* ── GC stale generations ─────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {gcPreview
            ? <>Would GC <b>{gcPreview.capped ? `≥${gcPreview.stale_sections}` : gcPreview.stale_sections}</b> stale v3 section(s) (older than active − 1).{gcPreview.capped ? ' (preview capped; the action deletes all stale.)' : ''}</>
            : <span style={{ opacity: 0.6 }}>Loading preview…</span>}
        </div>
        <button
          type="button"
          onClick={gc}
          disabled={busy !== null}
          style={{
            padding: '6px 12px', fontSize: 13,
            background: busy === 'gc' ? '#222' : '#1a4a6e',
            color: '#fff', border: '1px solid #2a7aa3', borderRadius: 4,
            cursor: busy !== null ? 'wait' : 'pointer',
          }}
        >
          {busy === 'gc' ? 'Running GC…' : 'GC old v3 generations'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={loadPreviews}
          style={{
            padding: '5px 10px', fontSize: 12, background: 'transparent',
            color: '#999', border: '1px solid #444', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Refresh previews
        </button>
        {result && <span style={{ fontSize: 12, color: '#44cc66' }}>{result}</span>}
        {error && <span style={{ fontSize: 12, color: '#ff6b6b' }}>error: {error}</span>}
      </div>
    </div>
  );
}
