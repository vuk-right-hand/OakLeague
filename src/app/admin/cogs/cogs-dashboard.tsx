'use client';

import { useEffect, useRef, useState } from 'react';
import { ALLOWED_COGS_SERVICES, ALLOWED_COGS_OPERATIONS } from '@/lib/admin/cogs-operations';

// Two-tab COGS viewer (handoff §5):
//   - Live sessions: in-flight sessions with running voice cost per session.
//     Refreshes every 15s while visible.
//   - Historical: paginated cogs_log + per-operation summary. Range + filters.
// Pipeline α' operation strings (do not rename — dashboard aggregates by these):
//   gemini.voice_audio_input_seconds · gemini.voice_audio_out_tokens
//   cartesia.voice_tts_characters    · cartesia.voice_tts_audio_seconds (cost=0)

type Tab = 'live' | 'historical';

type LiveSession = {
  id: string;
  user_id: string;
  creator_id: string | null;
  started_at: string;
  model_used: string | null;
  tier_at_session: string;
  active_seconds: number;
  environment: string | null;
  voice_cost_usd: number;             // truth-only headline number
  voice_cost_usd_fallback: number;    // seconds-derived (Gemini didn't ship token counts)
  voice_tts_audio_seconds: number;
  cogs_rows: number;                  // renamed from turn_rows; each turn = 4 cogs rows
  cartesia_pending_rows: number;
  fallback_rate: number;              // 0..1, leg-2 fallback proportion
  user_handle: string | null;
  user_email: string | null;
};
type LivePayload = { sessions: LiveSession[] };

type ByOp = {
  service: string;
  operation: string;
  cost_usd_truth: number;
  cost_usd_fallback: number;
  units: number;
  row_count: number;
  fallback_count: number;
};
type HistRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  session_id: string | null;
  service: string;
  operation: string;
  units: number;
  unit_label: string;
  cost_usd: number;
  environment: string;
};
type HistPayload = {
  range_start: string;
  range_end: string;
  total_usd: number;            // truth + fallback (legacy combined)
  total_usd_truth: number;      // headline number — render this prominently
  total_usd_fallback: number;   // badge / footnote
  by_operation: ByOp[];
  rows: HistRow[];
  next_cursor: string | null;
  summary_truncated: boolean;
};

const WINDOWS: { label: string; hours: number }[] = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
];
// Dropdowns re-export the shared allowlist with an 'all' option prepended.
// Filter values hitting the route are still validated against the same set.
const SERVICES = ['all', ...ALLOWED_COGS_SERVICES] as const;
const OPERATIONS = ['all', ...ALLOWED_COGS_OPERATIONS] as const;

export function CogsDashboard() {
  const [tab, setTab] = useState<Tab>('live');

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <TabButton active={tab === 'live'} onClick={() => setTab('live')}>Live sessions</TabButton>
        <TabButton active={tab === 'historical'} onClick={() => setTab('historical')}>Historical</TabButton>
      </div>
      {tab === 'live' ? <LiveTab /> : <HistoricalTab />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        fontSize: 13,
        background: active ? '#fff' : 'transparent',
        color: active ? '#000' : '#fff',
        border: '1px solid rgba(255,255,255,0.25)',
        borderRadius: 6,
        cursor: 'pointer',
      }}
    >{children}</button>
  );
}

function LiveTab() {
  const [data, setData] = useState<LivePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (cancelled) return;
      // Skip when tab is hidden — 4 queries × every 15s × an idle laptop tab is
      // pure waste. Re-ticks immediately on visibilitychange below.
      if (typeof document !== 'undefined' && document.hidden) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const r = await fetch('/api/admin/cogs/live', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: ac.signal,
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          if (!cancelled) setErr(body?.error ?? `error_${r.status}`);
          return;
        }
        const payload = (await r.json()) as LivePayload;
        if (!cancelled) { setData(payload); setErr(null); }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        if (!cancelled) setErr('network');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void tick();
    const id = setInterval(() => { void tick(); }, 15_000);
    const onVis = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      abortRef.current?.abort();
    };
  }, []);

  // Truth-only headline. Fallback is summed separately so admins see imprecision.
  const totalVoiceTruth    = (data?.sessions ?? []).reduce((n, s) => n + s.voice_cost_usd, 0);
  const totalVoiceFallback = (data?.sessions ?? []).reduce((n, s) => n + s.voice_cost_usd_fallback, 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 700 }}>${totalVoiceTruth.toFixed(4)}</div>
        {totalVoiceFallback > 0 && (
          <div
            title="Estimated from seconds because Gemini didn't ship token counts for these turns"
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#3a2a00', color: '#ffc66d' }}
          >
            +${totalVoiceFallback.toFixed(4)} est
          </div>
        )}
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          running cost · {data?.sessions.length ?? 0} live · {loading ? 'refreshing…' : 'every 15s'}
        </div>
      </div>
      {err && <div role="alert" style={{ color: 'salmon', marginBottom: 12 }}>Error: {err}</div>}

      {data && (
        data.sessions.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: 13 }}>No live sessions.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">User</th>
                <th align="left">Tier</th>
                <th align="left">Started</th>
                <th align="right">Active (s)</th>
                <th align="right">TTS (s)</th>
                <th align="right">Voice cost</th>
                <th align="right">Cogs rows</th>
                <th align="left">Model</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid #222' }}>
                  <td>
                    <a href={`/admin/users/${s.user_id}`} style={{ color: 'inherit' }}>
                      {s.user_handle ? `@${s.user_handle}` : s.user_email ?? s.user_id.slice(0, 8)}
                    </a>
                  </td>
                  <td style={{ opacity: 0.8 }}>{s.tier_at_session}</td>
                  <td style={{ opacity: 0.8 }}>{new Date(s.started_at).toLocaleTimeString()}</td>
                  <td align="right">{s.active_seconds}</td>
                  <td align="right">{s.voice_tts_audio_seconds.toFixed(1)}</td>
                  <td align="right">
                    ${s.voice_cost_usd.toFixed(6)}
                    {s.voice_cost_usd_fallback > 0 && (
                      <span
                        title={`+$${s.voice_cost_usd_fallback.toFixed(6)} est. from seconds (fallback rate ${(s.fallback_rate * 100).toFixed(1)}%)`}
                        style={{
                          fontSize: 10, marginLeft: 6, padding: '1px 4px', borderRadius: 3,
                          background: s.fallback_rate > 0.05 ? '#5a1a1a' : '#3a2a00',
                          color: s.fallback_rate > 0.05 ? '#ff9b9b' : '#ffc66d',
                        }}
                      >
                        +${s.voice_cost_usd_fallback.toFixed(4)} est
                      </span>
                    )}
                  </td>
                  <td align="right" title={s.cartesia_pending_rows > 0 ? `${s.cartesia_pending_rows} pending Cartesia` : undefined}>
                    {s.cogs_rows}
                    {s.cartesia_pending_rows > 0 && (
                      <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 4 }}>
                        ({s.cartesia_pending_rows}p)
                      </span>
                    )}
                  </td>
                  <td style={{ opacity: 0.7 }}>{s.model_used ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

function HistoricalTab() {
  const [hours, setHours] = useState<number>(24);
  const [service, setService] = useState<(typeof SERVICES)[number]>('all');
  const [operation, setOperation] = useState<(typeof OPERATIONS)[number]>('all');
  const [userId, setUserId] = useState<string>('');
  const [appliedUserId, setAppliedUserId] = useState<string>('');
  const [pages, setPages] = useState<HistPayload[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Reset pagination on filter change.
    setPages([]);
    let cancelled = false;
    async function fetchPage(cursor: string | null) {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        const until = new Date();
        const since = new Date(until.getTime() - hours * 3600_000);
        qs.set('since', since.toISOString());
        qs.set('until', until.toISOString());
        if (service !== 'all') qs.set('service', service);
        if (operation !== 'all') qs.set('operation', operation);
        if (appliedUserId) qs.set('user_id', appliedUserId);
        if (cursor) qs.set('cursor', cursor);
        const r = await fetch(`/api/admin/cogs/historical?${qs.toString()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: ac.signal,
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          if (!cancelled) setErr(body?.error ?? `error_${r.status}`);
          return;
        }
        const payload = (await r.json()) as HistPayload;
        if (!cancelled) { setPages([payload]); setErr(null); }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        if (!cancelled) setErr('network');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchPage(null);
    return () => { cancelled = true; abortRef.current?.abort(); };
  }, [hours, service, operation, appliedUserId]);

  async function loadMore() {
    const last = pages[pages.length - 1];
    if (!last?.next_cursor) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('since', last.range_start);
      qs.set('until', last.range_end);
      if (service !== 'all') qs.set('service', service);
      if (operation !== 'all') qs.set('operation', operation);
      if (appliedUserId) qs.set('user_id', appliedUserId);
      qs.set('cursor', last.next_cursor);
      const r = await fetch(`/api/admin/cogs/historical?${qs.toString()}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body?.error ?? `error_${r.status}`);
        return;
      }
      const payload = (await r.json()) as HistPayload;
      setPages([...pages, payload]);
    } finally {
      setLoading(false);
    }
  }

  const summary = pages[0];
  const rows = pages.flatMap((p) => p.rows);
  const nextCursor = pages[pages.length - 1]?.next_cursor ?? null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              onClick={() => setHours(w.hours)}
              style={{
                padding: '4px 10px',
                fontSize: 13,
                background: hours === w.hours ? '#fff' : 'transparent',
                color: hours === w.hours ? '#000' : '#fff',
                border: '1px solid rgba(255,255,255,0.25)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >{w.label}</button>
          ))}
        </div>
        <select
          value={service}
          onChange={(e) => setService(e.target.value as (typeof SERVICES)[number])}
          style={sel}
        >{SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value as (typeof OPERATIONS)[number])}
          style={sel}
        >{OPERATIONS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        <input
          type="text"
          placeholder="user_id (uuid)"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          onBlur={() => setAppliedUserId(userId.trim())}
          onKeyDown={(e) => { if (e.key === 'Enter') setAppliedUserId(userId.trim()); }}
          style={{ ...sel, width: 280 }}
        />
        <span style={{ fontSize: 12, opacity: 0.6 }}>{loading ? 'Loading…' : ''}</span>
      </div>
      {err && <div role="alert" style={{ color: 'salmon', marginBottom: 12 }}>Error: {err}</div>}

      {summary && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                // Grey the number out when the summary was capped at 10k rows —
                // the figure is a floor, not a total, and the bold white rendering
                // implied authority it doesn't have.
                opacity: summary.summary_truncated ? 0.45 : 1,
              }}
            >
              {summary.summary_truncated ? '≥' : ''}${summary.total_usd_truth.toFixed(4)}
            </div>
            {summary.total_usd_fallback > 0 && (
              <div
                title="Estimated from seconds because Gemini didn't ship token counts for some turns"
                style={{ fontSize: 13, padding: '2px 8px', borderRadius: 4, background: '#3a2a00', color: '#ffc66d' }}
              >
                +${summary.total_usd_fallback.toFixed(4)} est
              </div>
            )}
          </div>
          {summary.summary_truncated && (
            <div role="alert" style={{ color: 'salmon', fontSize: 12, marginBottom: 6 }}>
              Summary truncated at 10k rows — narrow filters for an accurate total. The figure above is a lower bound.
            </div>
          )}
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
            {new Date(summary.range_start).toLocaleString()} → {new Date(summary.range_end).toLocaleString()}
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>By operation</h2>
          {summary.by_operation.length === 0 ? (
            <p style={{ opacity: 0.7, fontSize: 13 }}>No rows match.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
              <thead>
                <tr>
                  <th align="left">Service</th>
                  <th align="left">Operation</th>
                  <th align="right">Cost (USD)</th>
                  <th align="right">Units</th>
                  <th align="right">Rows</th>
                </tr>
              </thead>
              <tbody>
                {summary.by_operation.map((r) => (
                  <tr key={`${r.service}|${r.operation}`} style={{ borderTop: '1px solid #222' }}>
                    <td>{r.service}</td>
                    <td style={{ opacity: 0.8 }}>{r.operation}</td>
                    <td align="right">
                      ${r.cost_usd_truth.toFixed(6)}
                      {r.cost_usd_fallback > 0 && (
                        <span
                          title={`+$${r.cost_usd_fallback.toFixed(6)} est. (${r.fallback_count}/${r.row_count} rows)`}
                          style={{
                            fontSize: 10, marginLeft: 6, padding: '1px 4px', borderRadius: 3,
                            background: '#3a2a00', color: '#ffc66d',
                          }}
                        >
                          +${r.cost_usd_fallback.toFixed(4)} est
                        </span>
                      )}
                    </td>
                    <td align="right">{Number(r.units).toFixed(2)}</td>
                    <td align="right">{r.row_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>
            Rows <span style={{ opacity: 0.5, fontWeight: 400, fontSize: 13 }}>({rows.length} loaded)</span>
          </h2>
          {rows.length === 0 ? (
            <p style={{ opacity: 0.7, fontSize: 13 }}>No rows.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th align="left">When</th>
                  <th align="left">Service</th>
                  <th align="left">Operation</th>
                  <th align="right">Units</th>
                  <th align="right">Cost</th>
                  <th align="left">Env</th>
                  <th align="left">User</th>
                  <th align="left">Session</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ opacity: 0.8 }}>{new Date(r.created_at).toLocaleTimeString()}</td>
                    <td>{r.service}</td>
                    <td style={{ opacity: 0.8 }}>{r.operation}</td>
                    <td align="right">{Number(r.units).toFixed(2)} {r.unit_label}</td>
                    <td align="right">${Number(r.cost_usd).toFixed(6)}</td>
                    <td style={{ opacity: 0.7 }}>{r.environment}</td>
                    <td style={{ opacity: 0.7 }}>
                      {r.user_id ? (
                        <a href={`/admin/users/${r.user_id}`} style={{ color: 'inherit' }}>
                          {r.user_id.slice(0, 8)}
                        </a>
                      ) : '—'}
                    </td>
                    <td style={{ opacity: 0.6 }}>{r.session_id ? r.session_id.slice(0, 8) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {nextCursor && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loading}
              style={{ marginTop: 12, padding: '6px 14px', fontSize: 13, borderRadius: 6 }}
            >
              {loading ? '…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

const sel: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 13,
  background: '#111',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 6,
};
