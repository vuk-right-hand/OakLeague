'use client';

// Admin "Recompile brain" button. POSTs to /api/admin/brain-recompile,
// echoes the freshly-compiled timestamp inline, no page reload.
// Brain wire-up PR-3 (plan §Phase 5).

import { useEffect, useRef, useState } from 'react';

type Props = {
  creatorId: string;
  initialCompiledAt: string | null;
  // Bytes (octet_length) — consistent with the DB CHECK constraint.
  // Multi-byte personas underreport via .length; Buffer.byteLength on
  // server is what gates the size cap.
  initialPromptLength: number | null;
};

export function BrainRecompileButton({
  creatorId,
  initialCompiledAt,
  initialPromptLength,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiledAt, setCompiledAt] = useState<string | null>(initialCompiledAt);
  // PR-3 audit M2: mounted ref to suppress setState-after-unmount when the
  // admin navigates away mid-recompile. Plus AbortController on the fetch.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  async function recompile() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ac = new AbortController();
    try {
      const res = await fetch('/api/admin/brain-recompile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId }),
        signal: ac.signal,
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        brain_compiled_at?: string | null;
      };
      if (!mountedRef.current) return;
      if (!res.ok || !body.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else {
        setCompiledAt(body.brain_compiled_at ?? null);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message ?? 'network_error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
      <button
        type="button"
        onClick={recompile}
        disabled={busy}
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
        {busy ? 'Recompiling…' : 'Recompile brain'}
      </button>
      {compiledAt && !error && (
        <span style={{ fontSize: 12, opacity: 0.8 }}>
          last compile: {new Date(compiledAt).toLocaleString()}
          {initialPromptLength !== null ? ` · ${initialPromptLength} bytes` : ''}
        </span>
      )}
      {error && (
        <span style={{ fontSize: 12, color: '#ff6b6b' }}>error: {error}</span>
      )}
    </div>
  );
}
