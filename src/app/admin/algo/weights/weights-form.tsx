'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setFeedAlgoWeight } from './set-weight-action';

export type WeightRow = {
  weight_key: string;
  weight_value: number;
  min_value: number;
  max_value: number;
  description: string;
  updated_at: string;
};

export function WeightsForm({ rows }: { rows: WeightRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ key: string; msg: string; ok: boolean } | null>(null);

  function save(row: WeightRow) {
    const raw = drafts[row.weight_key];
    if (raw === undefined || raw.trim() === '') return;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      setStatus({ key: row.weight_key, msg: 'Not a number', ok: false });
      return;
    }
    startTransition(async () => {
      const res = await setFeedAlgoWeight(row.weight_key, value);
      if ('ok' in res) {
        setStatus({ key: row.weight_key, msg: 'Saved', ok: true });
        setDrafts((d) => {
          const next = { ...d };
          delete next[row.weight_key];
          return next;
        });
        router.refresh();
      } else {
        setStatus({ key: row.weight_key, msg: res.message ?? res.error, ok: false });
      }
    });
  }

  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', maxWidth: 880 }}>
      <thead>
        <tr style={{ textAlign: 'left', opacity: 0.6 }}>
          <th style={cell}>Key</th>
          <th style={cell}>Value</th>
          <th style={cell}>Bounds</th>
          <th style={cell}>Description</th>
          <th style={cell}>New value</th>
          <th style={cell} />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.weight_key} style={{ borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            <td style={{ ...cell, fontFamily: 'monospace' }}>{row.weight_key}</td>
            <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{row.weight_value}</td>
            <td style={{ ...cell, opacity: 0.6 }}>
              [{row.min_value}, {row.max_value}]
            </td>
            <td style={{ ...cell, opacity: 0.8, maxWidth: 320 }}>{row.description}</td>
            <td style={cell}>
              <input
                type="number"
                step="0.1"
                min={row.min_value}
                max={row.max_value}
                value={drafts[row.weight_key] ?? ''}
                placeholder={String(row.weight_value)}
                title="Decimal point, not comma (e.g. 0.5)"
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [row.weight_key]: e.target.value }))
                }
                style={{
                  width: 90, padding: '4px 8px', fontSize: 13,
                  background: '#111', color: '#fff',
                  border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6,
                }}
              />
            </td>
            <td style={cell}>
              <button
                type="button"
                disabled={pending || (drafts[row.weight_key] ?? '') === ''}
                onClick={() => save(row)}
                style={{
                  padding: '4px 12px', fontSize: 13, borderRadius: 6,
                  background: '#1d4ed8', color: '#fff', border: 'none',
                  cursor: 'pointer', opacity: pending ? 0.5 : 1,
                }}
              >
                Save
              </button>
              {status?.key === row.weight_key && (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    color: status.ok ? '#4ade80' : '#f87171',
                  }}
                >
                  {status.msg}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cell: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'top' };
