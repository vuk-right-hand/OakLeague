'use client';

import { useEffect, useRef, useState } from 'react';

type ByService = {
  service: string;
  environment: string;
  cost_usd: number;
  units: number;
  row_count: number;
};
type Payload = {
  window_s: number;
  range_start: string;
  range_end: string;
  total_usd: number;
  by_service: ByService[];
};

const WINDOWS: { label: string; s: number }[] = [
  { label: '1h', s: 3600 },
  { label: '6h', s: 21600 },
  { label: '24h', s: 86400 },
];
const ENVS = ['all', 'production', 'spike_a', 'spike_b', 'dev'] as const;

export function CogsDashboard() {
  const [windowS, setWindowS] = useState(3600);
  const [env, setEnv] = useState<(typeof ENVS)[number]>('all');
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const qs = new URLSearchParams({ window_s: String(windowS) });
        if (env !== 'all') qs.set('environment', env);
        const r = await fetch(`/api/admin/cogs?${qs.toString()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: ac.signal,
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          if (!cancelled) setErr(body?.error ?? `error_${r.status}`);
          return;
        }
        const payload = (await r.json()) as Payload;
        if (!cancelled) {
          setData(payload);
          setErr(null);
        }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        if (!cancelled) setErr('network');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void tick();
    const id = setInterval(() => { void tick(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [windowS, env]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.s}
              type="button"
              onClick={() => setWindowS(w.s)}
              style={{
                padding: '4px 10px',
                fontSize: 13,
                background: windowS === w.s ? '#fff' : 'transparent',
                color: windowS === w.s ? '#000' : '#fff',
                border: '1px solid rgba(255,255,255,0.25)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >{w.label}</button>
          ))}
        </div>
        <select
          value={env}
          onChange={(e) => setEnv(e.target.value as (typeof ENVS)[number])}
          style={{ padding: '4px 8px', fontSize: 13, background: '#111', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6 }}
        >
          {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {loading ? 'Refreshing…' : data ? `Updated ${new Date(data.range_end).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {err && <div role="alert" style={{ color: 'salmon', marginBottom: 12 }}>Error: {err}</div>}

      {data && (
        <>
          <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 4 }}>
            ${data.total_usd.toFixed(4)}
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 24 }}>
            Total over last {Math.round(data.window_s / 60)} min · {data.by_service.reduce((n, r) => n + r.row_count, 0)} events
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>By service</h2>
          {data.by_service.length === 0 ? (
            <p style={{ opacity: 0.7, fontSize: 13 }}>No data in this window.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th align="left">Service</th>
                  <th align="left">Env</th>
                  <th align="right">Cost (USD)</th>
                  <th align="right">Units</th>
                  <th align="right">Rows</th>
                </tr>
              </thead>
              <tbody>
                {data.by_service.map((r) => (
                  <tr key={`${r.service}|${r.environment}`} style={{ borderTop: '1px solid #222' }}>
                    <td>{r.service}</td>
                    <td style={{ opacity: 0.7 }}>{r.environment}</td>
                    <td align="right">${r.cost_usd.toFixed(6)}</td>
                    <td align="right">{Number(r.units).toFixed(2)}</td>
                    <td align="right">{r.row_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
