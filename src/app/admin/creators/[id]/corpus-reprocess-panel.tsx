'use client';

// /admin/creators/[id] — Day-6 corpus re-process panel.
//
// Two buttons:
//   * "Re-process v2" — enqueues every sample with raw_text (the real gate is
//     raw_text IS NOT NULL, NOT fetch_status). Skips pending/processing rows
//     (idempotent if you click it twice during a run).
//   * "Force re-process" — re-enqueues every such sample regardless of
//     status, with a confirm() guard because it will discard half-finished
//     job state and restart from scratch (still safe — the worker's
//     enqueue_version sentinel handles the race).
//
// Live progress:
//   GET /api/admin/corpus-reprocess?creator_id=X
//   - Polls every 5s when any job is in pending/processing.
//   - Pauses polling when everything is in terminal state (done/errored).
//   - Re-poll after each click to refresh state immediately.
//
// AbortController on every fetch — admin navigating away mid-poll must not
// leak a request. Mounted ref guards setState after unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isWorkerLikelyStalled } from './corpus-reprocess-stall';

type EnqueueResponse = {
  ok: boolean;
  error?: string;
  enqueued_count?: number;
  total_ready_samples?: number;
  skipped_in_flight?: number;
  skipped_already_queued?: number;
};

type JobRow = {
  id: string;
  sample_id: string;
  sample_title: string | null;
  status: 'pending' | 'processing' | 'done' | 'errored';
  attempts: number;
  last_error: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  enqueue_version: number;
};

type StatusResponse = {
  ok: boolean;
  error?: string;
  total?: number;
  counts?: Record<string, number>;
  rows?: JobRow[];
};

const POLL_INTERVAL_MS = 5_000;

export function CorpusReprocessPanel({ creatorId }: { creatorId: string }) {
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<EnqueueResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P0-2: surface a likely-offline worker (pending jobs that never start
  // processing). pendingSinceRef marks when pending-with-no-processing began.
  const [stalled, setStalled] = useState(false);
  const pendingSinceRef = useRef<number | null>(null);
  // Holistic-audit C2: a DECREASING pending count is proof the worker is alive
  // (it's draining the queue) even if a poll never catches the brief
  // 'processing' window. Track the prior pending count to reset the timer on
  // forward progress and avoid a false "worker offline" warning.
  const lastPendingRef = useRef<number | null>(null);

  // Audit-1 M1: abort previous POST on new click and seq-tag every fetch so
  // a late-arriving response cannot overwrite a newer one.
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const enqueueAbortRef = useRef<AbortController | null>(null);
  const latestEnqueueSeqRef = useRef(0);
  const [errorRowId, setErrorRowId] = useState<string | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (pollAbortRef.current) pollAbortRef.current.abort();
    if (enqueueAbortRef.current) enqueueAbortRef.current.abort();
  }, []);

  const pollOnce = useCallback(async () => {
    if (!mountedRef.current) return;
    // Abort any inflight prior poll before starting a new one.
    if (pollAbortRef.current) pollAbortRef.current.abort();
    const ac = new AbortController();
    pollAbortRef.current = ac;
    try {
      const res = await fetch(
        `/api/admin/corpus-reprocess?creator_id=${encodeURIComponent(creatorId)}`,
        { signal: ac.signal, cache: 'no-store' },
      );
      const body = (await res.json()) as StatusResponse;
      if (!mountedRef.current) return;
      if (!res.ok || !body.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else {
        setStatus(body);
        setError(null);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      // Aborts are expected (component unmount or new click); ignore.
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message ?? 'network_error');
    }
  }, [creatorId]);

  // Schedule the next poll only when at least one row is non-terminal.
  // Reschedules after `status` changes (cheap re-run; deps are minimal).
  useEffect(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    const counts = status?.counts;
    if (!counts) return;
    const inflight = (counts.pending ?? 0) + (counts.processing ?? 0);
    if (inflight > 0) {
      pollTimerRef.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
    }
  }, [status, pollOnce]);

  // Initial poll on mount.
  useEffect(() => { void pollOnce(); }, [pollOnce]);

  // P0-2 stall detection. Recomputed on every poll (the panel polls every 5s
  // while pending>0). Tracks how long pending-with-no-processing has persisted;
  // a live worker flips a job to 'processing' within a poll cycle.
  useEffect(() => {
    const c = status?.counts;
    const pending = c?.pending ?? 0;
    const processing = c?.processing ?? 0;
    const prevPending = lastPendingRef.current;
    const draining = prevPending !== null && pending < prevPending; // forward progress
    if (pending > 0 && processing === 0 && !draining) {
      if (pendingSinceRef.current === null) pendingSinceRef.current = Date.now();
    } else {
      // processing active, queue empty, OR pending dropped since last poll →
      // worker is alive; reset the stall timer.
      pendingSinceRef.current = null;
    }
    lastPendingRef.current = pending;
    const secs = pendingSinceRef.current ? (Date.now() - pendingSinceRef.current) / 1000 : 0;
    setStalled(isWorkerLikelyStalled({ pending, processing }, secs));
  }, [status]);

  const enqueue = useCallback(async (force: boolean) => {
    if (busy) return;
    // Audit-1 M6: setBusy BEFORE confirm so a slow confirm dialog (or a PWA
    // that silently rejects) can't slip a second click through.
    setBusy(true);
    if (force) {
      const ok = window.confirm(
        'Force re-process will reset every job to pending and re-run from scratch. ' +
        'In-flight workers will silently abandon their current chunk. Continue?',
      );
      if (!ok) {
        setBusy(false);
        return;
      }
    }
    setError(null);
    // Audit-1 M1: abort any inflight prior enqueue + bump seq.
    if (enqueueAbortRef.current) enqueueAbortRef.current.abort();
    const ac = new AbortController();
    enqueueAbortRef.current = ac;
    const mySeq = ++latestEnqueueSeqRef.current;
    try {
      const res = await fetch('/api/admin/corpus-reprocess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator_id: creatorId, force }),
        signal: ac.signal,
      });
      const body = (await res.json()) as EnqueueResponse;
      if (!mountedRef.current) return;
      // Audit-1 M1: ignore stale responses from earlier clicks.
      if (mySeq !== latestEnqueueSeqRef.current) return;
      if (!res.ok || !body.ok) {
        setError(body.error ?? `http_${res.status}`);
      } else {
        setLastResult(body);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      if ((e as Error).name === 'AbortError') return;
      if (mySeq !== latestEnqueueSeqRef.current) return;
      setError((e as Error).message ?? 'network_error');
    } finally {
      if (mountedRef.current && mySeq === latestEnqueueSeqRef.current) setBusy(false);
      // Refresh status either way so the row list updates immediately.
      void pollOnce();
    }
  }, [busy, creatorId, pollOnce]);

  const counts = status?.counts ?? { pending: 0, processing: 0, done: 0, errored: 0 };
  const rows = status?.rows ?? [];
  const total = status?.total ?? 0;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => enqueue(false)}
          disabled={busy}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: busy ? '#222' : '#1a6e3d',
            color: '#fff',
            border: '1px solid #2aa35f',
            borderRadius: 4,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? 'Enqueuing…' : 'Re-process v2'}
        </button>
        <button
          type="button"
          onClick={() => enqueue(true)}
          disabled={busy}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: busy ? '#222' : '#6e1a1a',
            color: '#fff',
            border: '1px solid #a32a2a',
            borderRadius: 4,
            cursor: busy ? 'wait' : 'pointer',
          }}
          title="Force re-enqueue every sample. Use after a code change or bad model output."
        >
          Force re-process
        </button>
        <button
          type="button"
          onClick={pollOnce}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: 'transparent',
            color: '#999',
            border: '1px solid #444',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
        {lastResult && lastResult.ok && (
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            enqueued {lastResult.enqueued_count} of {lastResult.total_ready_samples}
            {lastResult.skipped_already_queued ? ` · ${lastResult.skipped_already_queued} already queued` : ''}
            {lastResult.skipped_in_flight ? ` · skipped ${lastResult.skipped_in_flight} in-flight` : ''}
          </span>
        )}
        {error && (
          <span style={{ fontSize: 12, color: '#ff6b6b' }}>error: {error}</span>
        )}
      </div>

      {stalled && (
        <div
          role="alert"
          style={{
            marginBottom: 8,
            padding: '8px 10px',
            border: '1px solid #a37a2a',
            borderRadius: 4,
            background: 'rgba(163,122,42,0.12)',
            color: '#d6a44a',
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          ⚠️ Jobs are pending but none have started processing — the corpus
          reprocess worker may be offline. Check the Fly proxy has
          <code> GEMINI_API_KEY</code>, <code>INTERNAL_API_BASE_URL</code>, and
          <code> INTERNAL_API_SECRET</code> (≥32 chars) set, and that it&apos;s
          running.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, marginBottom: 8 }}>
        <CountChip label="pending"     value={counts.pending ?? 0}    accent="#aaaa44" />
        <CountChip label="processing"  value={counts.processing ?? 0} accent="#449aff" />
        <CountChip label="done"        value={counts.done ?? 0}       accent="#44cc66" />
        <CountChip label="errored"     value={counts.errored ?? 0}    accent="#ff6b6b" />
        <span style={{ fontSize: 11, opacity: 0.5, alignSelf: 'center' }}>
          {total === 0 ? 'no jobs yet' : `${total} job${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {rows.length > 0 && (
        <details style={{ fontSize: 12, opacity: 0.85 }}>
          <summary style={{ cursor: 'pointer' }}>Per-sample breakdown ({rows.length})</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 12 }}>
            <thead>
              <tr style={{ opacity: 0.6 }}>
                <th align="left">Sample</th>
                <th align="left">Status</th>
                <th align="right">Attempts</th>
                <th align="right">v</th>
                <th align="left">Finished</th>
                <th align="left">Last error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid #222' }}>
                  <td>{r.sample_title ?? r.sample_id.slice(0, 8)}</td>
                  <td>
                    <span style={{
                      color:
                        r.status === 'done'      ? '#44cc66' :
                        r.status === 'errored'   ? '#ff6b6b' :
                        r.status === 'processing' ? '#449aff' :
                        '#aaaa44',
                    }}>
                      {r.status}
                    </span>
                  </td>
                  <td align="right">{r.attempts}</td>
                  <td align="right" style={{ opacity: 0.5 }}>{r.enqueue_version}</td>
                  <td style={{ opacity: 0.7 }}>
                    {r.finished_at ? new Date(r.finished_at).toLocaleTimeString() : '—'}
                  </td>
                  <td style={{ opacity: 0.7 }}>
                    {/* Audit-1 M7: click-to-expand instead of native tooltip.
                        last_error can carry up to 2000 chars of provider
                        error payload — render explicitly when the admin
                        opts in, not on idle hover. */}
                    {r.last_error
                      ? errorRowId === r.id
                        ? (
                          <span>
                            <button
                              type="button"
                              onClick={() => setErrorRowId(null)}
                              style={{ background: 'transparent', border: 0, color: '#449aff', cursor: 'pointer', padding: 0, fontSize: 11 }}
                            >
                              ▼
                            </button>{' '}
                            <code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.last_error}</code>
                          </span>
                        )
                        : (
                          <button
                            type="button"
                            onClick={() => setErrorRowId(r.id)}
                            style={{ background: 'transparent', border: 0, color: '#ff6b6b', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 11 }}
                          >
                            view error ({r.last_error.length} chars)
                          </button>
                        )
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function CountChip({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <span style={{
      padding: '3px 8px',
      border: `1px solid ${value > 0 ? accent : '#333'}`,
      color: value > 0 ? accent : '#666',
      borderRadius: 4,
      fontSize: 11,
    }}>
      {label}: {value}
    </span>
  );
}
