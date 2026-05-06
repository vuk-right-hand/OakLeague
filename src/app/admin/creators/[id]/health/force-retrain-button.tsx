'use client';

// SIMLI_WIREUP §12a.2 — client-side button that POSTs to the
// admin force-retrain endpoint. Disabled when the server-side check
// (active sessions > 0) would block.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ForceRetrainButton({
  creatorId,
  disabled,
}: {
  creatorId: string;
  disabled: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function onClick() {
    if (!confirm('Clear simli_face_id + enqueue prior face for delete in 60s. Continue?')) return;
    setPending(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/simli-retrain', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(`failed: ${body?.error ?? r.statusText}`);
      } else {
        setMsg(`ok — prior face: ${body?.priorFaceId ?? 'none'}`);
        router.refresh();
      }
    } catch (e) {
      setMsg(`error: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={disabled || pending}
        onClick={onClick}
        style={{
          padding: '8px 14px', fontSize: 13, fontWeight: 600,
          background: disabled ? '#eee' : '#dc2626', color: disabled ? '#999' : '#fff',
          border: 'none', borderRadius: 6,
          cursor: disabled || pending ? 'not-allowed' : 'pointer',
        }}
      >
        {pending ? 'Clearing…' : 'Force-retrain Simli replica'}
      </button>
      {msg && <div style={{ marginTop: 8, fontSize: 12, color: msg.startsWith('ok') ? '#15803d' : '#b91c1c' }}>{msg}</div>}
    </div>
  );
}
