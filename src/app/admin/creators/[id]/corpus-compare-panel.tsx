'use client';

// /admin/creators/[id] — Day-7 side-by-side v1 vs v2 retrieval comparison
// panel + "Promote v2" cleanup button.
//
// UX:
//   1. Admin types a question (e.g. "what's the twins story?").
//   2. Clicks "Compare" → POST /api/admin/corpus-compare.
//   3. Sees v1 top-K and v2 top-K side by side with similarity scores. The
//      goal is for v2 to beat v1 on the dogfood corpus (Anthropic published
//      ~35% retrieval-failure reduction with contextual retrieval).
//   4. If v2 looks meaningfully better, clicks "Promote v2" → POST
//      /api/admin/corpus-promote-v2 to DELETE the v1 chunks for this
//      creator. Promote is gated by the RPC: refuses if no v2 chunks exist.
//
// Promote is a confirm-protected destructive action; the dialog explicitly
// warns that v1 cannot be recovered without a fresh re-process.

import { useCallback, useRef, useState } from 'react';

type CompareRow = {
  chunker_version: number;
  chunk_id:        string;
  sample_id:       string;
  sample_title:    string | null;
  chunk_context:   string | null;
  text:            string;
  similarity:      number;
};

type CompareResponse = {
  ok: boolean;
  error?: string;
  counts?: { v1: number; v2: number };
  v1?: CompareRow[];
  v2?: CompareRow[];
};

type PromoteResponse = {
  ok: boolean;
  error?: string;
  deleted_v1_count?: number;
  remaining_v2_count?: number;
};

type FlipResponse = {
  ok: boolean;
  error?: string;
  retrieval_version?: number;
};

export function CorpusComparePanel({
  creatorId,
  retrievalVersion,
}: {
  creatorId: string;
  retrievalVersion: number;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteResult, setPromoteResult] = useState<PromoteResponse | null>(null);
  const [flipBusy, setFlipBusy] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<number>(retrievalVersion);
  const [error, setError] = useState<string | null>(null);
  const compareAbortRef = useRef<AbortController | null>(null);
  const promoteAbortRef = useRef<AbortController | null>(null);
  const flipAbortRef = useRef<AbortController | null>(null);
  const compareSeqRef = useRef(0);

  const compare = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPromoteResult(null);
    if (compareAbortRef.current) compareAbortRef.current.abort();
    const ac = new AbortController();
    compareAbortRef.current = ac;
    const mySeq = ++compareSeqRef.current;
    try {
      const res = await fetch('/api/admin/corpus-compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId, query_text: q, k: 5 }),
        signal: ac.signal,
      });
      const body = (await res.json()) as CompareResponse;
      if (mySeq !== compareSeqRef.current) return;
      if (!res.ok || !body.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else {
        setResult(body);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (mySeq !== compareSeqRef.current) return;
      setError((e as Error).message ?? 'network_error');
    } finally {
      if (mySeq === compareSeqRef.current) setBusy(false);
    }
  }, [query, busy, creatorId]);

  // Phase-1 unit audit C2 + M4: button to flip retrieval_version, so admin
  // doesn't have to open SQL editor post-Promote.
  const flipRetrievalVersion = useCallback(async (nextVersion: 1 | 2) => {
    if (flipBusy) return;
    setFlipBusy(true);
    const verb = nextVersion === 2 ? 'enable v2 retrieval' : 'roll back to v1 retrieval';
    const ok = window.confirm(
      `Flip retrieval_version to ${nextVersion}? This will ${verb} for this creator. ` +
      (nextVersion === 1
        ? 'Downgrading also DELETES any v2 chunks + narrative_units this creator has (zombie cleanup). Continue?'
        : 'The creator\'s persona will be recompiled to add the v2 clarifier rule. Continue?'),
    );
    if (!ok) {
      setFlipBusy(false);
      return;
    }
    setError(null);
    if (flipAbortRef.current) flipAbortRef.current.abort();
    const ac = new AbortController();
    flipAbortRef.current = ac;
    try {
      const res = await fetch('/api/admin/creator-retrieval-version', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId, version: nextVersion }),
        signal: ac.signal,
      });
      const body = (await res.json()) as FlipResponse;
      if (!res.ok || !body.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else if (body.retrieval_version === 1 || body.retrieval_version === 2) {
        setCurrentVersion(body.retrieval_version);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message ?? 'network_error');
    } finally {
      setFlipBusy(false);
    }
  }, [creatorId, flipBusy]);

  const promote = useCallback(async () => {
    if (promoteBusy) return;
    setPromoteBusy(true);
    const ok = window.confirm(
      'Promote v2 will DELETE every v1 chunk for this creator. ' +
      'v1 cannot be recovered without a fresh re-process. ' +
      'Only do this after side-by-side comparison shows v2 wins. Continue?',
    );
    if (!ok) {
      setPromoteBusy(false);
      return;
    }
    setError(null);
    if (promoteAbortRef.current) promoteAbortRef.current.abort();
    const ac = new AbortController();
    promoteAbortRef.current = ac;
    try {
      const res = await fetch('/api/admin/corpus-promote-v2', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId }),
        signal: ac.signal,
      });
      const body = (await res.json()) as PromoteResponse;
      if (!res.ok || !body.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else {
        setPromoteResult(body);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message ?? 'network_error');
    } finally {
      setPromoteBusy(false);
    }
  }, [promoteBusy, creatorId]);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void compare(); }}
          placeholder="Ask something specific (e.g., what's the twins story?)"
          disabled={busy}
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 13,
            background: '#0a0a0a',
            color: '#fff',
            border: '1px solid #333',
            borderRadius: 4,
          }}
          maxLength={2000}
        />
        <button
          type="button"
          onClick={compare}
          disabled={busy || query.trim().length === 0}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: busy ? '#222' : '#1a3d6e',
            color: '#fff',
            border: '1px solid #2a5fa3',
            borderRadius: 4,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? 'Comparing…' : 'Compare'}
        </button>
        <button
          type="button"
          onClick={promote}
          disabled={promoteBusy}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: promoteBusy ? '#222' : '#6e3d1a',
            color: '#fff',
            border: '1px solid #a35f2a',
            borderRadius: 4,
            cursor: promoteBusy ? 'wait' : 'pointer',
          }}
        >
          {promoteBusy ? 'Promoting…' : 'Promote v2 (delete v1)'}
        </button>
        {/* Phase-1 unit audit C2 + M4: flip button so admin can complete the
            v1→v2 transition without leaving the page (or remediate after a
            premature promote that left the creator at retrieval_version=1
            with no v1 chunks). */}
        <button
          type="button"
          onClick={() => flipRetrievalVersion(currentVersion === 1 ? 2 : 1)}
          disabled={flipBusy}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: flipBusy ? '#222' : (currentVersion === 1 ? '#1a6e3d' : '#444'),
            color: '#fff',
            border: '1px solid ' + (currentVersion === 1 ? '#2aa35f' : '#666'),
            borderRadius: 4,
            cursor: flipBusy ? 'wait' : 'pointer',
          }}
        >
          {flipBusy
            ? 'Flipping…'
            : currentVersion === 1
              ? 'Flip retrieval_version → 2'
              : 'Roll back retrieval_version → 1'}
        </button>
        {error && (
          <span style={{ fontSize: 12, color: '#ff6b6b' }}>error: {error}</span>
        )}
      </div>

      {promoteResult?.ok && (
        <div style={{
          padding: '8px 10px',
          marginBottom: 8,
          border: '1px solid #2a5fa3',
          borderRadius: 6,
          background: '#0a1626',
          fontSize: 12,
        }}>
          <div style={{ color: '#44cc66' }}>
            ✓ promoted: deleted {promoteResult.deleted_v1_count} v1 · {promoteResult.remaining_v2_count} v2 remain
          </div>
          {/* Audit-2 M1: if creator is still at retrieval_version=1 post-promote,
              their voice sessions will return ZERO retrieval results until
              the admin separately flips retrieval_version to 2. */}
          {currentVersion === 1 && (
            <div style={{ color: '#ff6b6b', marginTop: 6 }}>
              ⚠ This creator is still at retrieval_version=1 but has no v1 chunks left.
              Voice sessions will return ZERO retrieval results until you click
              the &quot;Flip retrieval_version → 2&quot; button above.
            </div>
          )}
        </div>
      )}

      {result?.ok && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ResultsBucket
            label={`v1 (legacy 300-token windows)`}
            count={result.counts?.v1 ?? 0}
            rows={result.v1 ?? []}
            accent="#aaaa44"
          />
          <ResultsBucket
            label={`v2 (narrative + contextual)`}
            count={result.counts?.v2 ?? 0}
            rows={result.v2 ?? []}
            accent="#44cc66"
          />
        </div>
      )}
    </div>
  );
}

function ResultsBucket({
  label, count, rows, accent,
}: { label: string; count: number; rows: CompareRow[]; accent: string }) {
  return (
    <div style={{ border: '1px solid #222', borderRadius: 6, padding: 8 }}>
      <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
        <span style={{ color: accent }}>{label}</span> · {count} hit{count === 1 ? '' : 's'}
      </div>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.5 }}>No chunks for this version.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {rows.map((r) => (
            <li key={r.chunk_id} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                sim {r.similarity.toFixed(3)} · {r.sample_title ?? r.sample_id.slice(0, 8)}
              </div>
              {r.chunk_context && (
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2, fontStyle: 'italic' }}>
                  ctx: {r.chunk_context}
                </div>
              )}
              <div style={{ marginTop: 2, fontSize: 12 }}>
                {r.text.length > 300 ? r.text.slice(0, 300) + '…' : r.text}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
