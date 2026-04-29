'use client';

import { useState, useTransition } from 'react';
import { explainHook, type ExplainResponse } from './explain-action';

const HOOK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExplainResult =
  | { ok: true; data: ExplainResponse }
  | { ok: false; error: string; message?: string };

export function ExplainForm({
  pUserId,
  sessionCorrelationId,
}: {
  pUserId: string;
  sessionCorrelationId: string;
}) {
  const [hookId, setHookId] = useState('');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ExplainResult | null>(null);

  const trimmed = hookId.trim();
  const isValidUuid = HOOK_ID_RE.test(trimmed);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidUuid) {
      setResult({
        ok: false, error: 'bad_hook_id',
        message: 'Invalid hook ID format. Expected UUID.',
      });
      return;
    }
    startTransition(async () => {
      const r = await explainHook(pUserId, trimmed, sessionCorrelationId);
      if ('error' in r) {
        setResult({ ok: false, error: r.error, message: r.message });
      } else {
        setResult({ ok: true, data: r.data });
      }
    });
  };

  return (
    <div>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          value={hookId}
          onChange={(e) => setHookId(e.target.value)}
          placeholder="hook UUID"
          style={{
            flex: 1, padding: '6px 10px', fontSize: 13, fontFamily: 'monospace',
            background: '#111', color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6,
          }}
          required
        />
        <button
          type="submit"
          disabled={pending || !isValidUuid}
          style={{
            padding: '6px 16px', fontSize: 13,
            background: pending ? '#333' : '#222', color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          {pending ? 'Explaining…' : 'Explain'}
        </button>
      </form>

      {result && !result.ok && (
        <div style={{
          padding: 12, marginBottom: 16,
          background: 'rgba(255, 100, 100, 0.1)',
          border: '1px solid rgba(255, 100, 100, 0.3)',
          borderRadius: 6, fontSize: 13,
        }}>
          <strong>Error:</strong> {result.error}
          {result.message && <span style={{ opacity: 0.8 }}> — {result.message}</span>}
        </div>
      )}

      {result && result.ok && <Breakdown data={result.data} />}
    </div>
  );
}

function Breakdown({ data }: { data: ExplainResponse }) {
  const slot = data.display_slot_one_indexed;
  const breakdown = data.breakdown;
  const components = (breakdown?.components ?? {}) as Record<string, number>;
  const weighted   = (breakdown?.weighted   ?? {}) as Record<string, number>;
  const streak = data.reconstructed_creator_streak;

  return (
    <div>
      <div style={{
        padding: 12, marginBottom: 16,
        background: 'rgba(100, 200, 100, 0.08)',
        border: '1px solid rgba(100, 200, 100, 0.3)',
        borderRadius: 6, fontSize: 14, lineHeight: 1.5,
      }}>
        {data.narrative}
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 12, opacity: 0.8, marginBottom: 16 }}>
        <span>regime <code>{data.regime_label}</code></span>
        {slot != null && <span>slot <strong>#{slot}</strong></span>}
        {streak >= 2 && <span>streak <strong>{streak}</strong></span>}
        {data.served_at_last_impression && (
          <span style={{ opacity: 0.6 }}>
            last impression: {new Date(data.served_at_last_impression).toLocaleString()}
          </span>
        )}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left">Component</th>
            <th align="right">Score</th>
            <th align="right">Weighted</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(components).map(([k, v]) => (
            <tr key={k} style={{ borderTop: '1px solid #222' }}>
              <td><code style={{ fontSize: 12 }}>{k}</code></td>
              <td align="right">{v.toFixed(4)}</td>
              <td align="right" style={{ opacity: 0.7 }}>
                {(() => {
                  const wKey = Object.keys(weighted).find((wk) =>
                    wk.toLowerCase().includes(k.replace('S_', '').toLowerCase()),
                  );
                  return wKey ? weighted[wKey].toFixed(4) : '—';
                })()}
              </td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid #444' }}>
            <td><strong>score_total</strong></td>
            <td></td>
            <td align="right"><strong>{(breakdown?.score_total ?? 0).toFixed(4)}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
