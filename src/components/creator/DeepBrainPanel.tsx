'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Deep Brain card (DEEP_BRAIN_SWITCH_PLAN Step 4). One-way switch that turns on
// v3 routed retrieval (book-scale brain) for the creator's OWN corpus.
//
// States, driven by GET /creator/api/deep-brain/status:
//   OFF        — retrieval_version < 3, not building → "Enable" button
//   BUILDING   — pending/processing v3 jobs, not yet ready → progress + queue pos
//   ACTIVATING — ready && rv<3 → auto-POST activate once, show "Activating…"
//   ON         — retrieval_version = 3 → done
//
// Enable is one-way: once ON there's nothing to re-click. The build is async
// (a single worker), so BUILDING shows honest "N ahead of you" + a stall hint.

type Status = {
  retrieval_version: number;
  ready: boolean;
  counts: Record<string, number>;
  total: number;
  queue_ahead: number;
  oldest_pending_at: string | null;
};

type Props = {
  initialRetrievalVersion: number;
  /** brain_status — Enable is hidden/disabled when the brain is errored. */
  brainStatus: string;
};

const POLL_MS = 5000;
// If the oldest pending job has sat this long with no progress, hint a backup
// rather than implying the spinner is normal (plan C5 / R4).
const STALL_MS = 10 * 60 * 1000;

export function DeepBrainPanel({ initialRetrievalVersion, brainStatus }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const activatedRef = useRef(false); // guard against cross-poll double-activate

  const on = (status?.retrieval_version ?? initialRetrievalVersion) >= 3;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/creator/api/deep-brain/status', { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as Status;
      setStatus(j);
      return j;
    } catch {
      /* transient — keep last state */
    }
  }, []);

  const activate = useCallback(async () => {
    if (activatedRef.current) return; // single-flight: one in-flight POST at a time
    activatedRef.current = true;
    try {
      const r = await fetch('/creator/api/deep-brain/activate', { method: 'POST' });
      const fresh = await refresh(); // pull authoritative state before deciding to retry
      if (!r.ok && r.status !== 409) {
        setErr('activate_failed'); // genuine failure — surface, don't auto-retry
        return; // leave ref set: a real failure shouldn't hot-loop
      }
      // 409 = not-ready race vs an in-flight finalize. Re-audit M3: only allow a
      // retry when a FRESH status read still reports ready (and we're not yet on
      // v3) — so we don't re-fire on the stale `ready` that triggered the failed
      // attempt. The retry then rides the normal poll cadence (≥POLL_MS apart),
      // not a tight loop, and stops the instant activate returns 200 (→ rv=3).
      if (r.status === 409 && fresh && fresh.ready && fresh.retrieval_version < 3) {
        activatedRef.current = false;
      }
    } catch {
      activatedRef.current = false;
    }
  }, [refresh]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while building/activating; stop once ON.
  useEffect(() => {
    if (!status) return;
    if (status.retrieval_version >= 3) return; // ON — no more polling
    const building = (status.counts.pending ?? 0) + (status.counts.processing ?? 0) > 0;
    // Auto-activate the moment the build is verified ready (plan: the "watch it
    // level up" finish). Single-flight via activatedRef.
    if (status.ready && status.retrieval_version < 3) {
      void activate();
    }
    if (!building && !status.ready) return; // nothing in flight, nothing to poll
    const t = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(t);
  }, [status, refresh, activate]);

  const enable = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/creator/api/deep-brain/enable', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(j.error ?? 'enable_failed');
      } else {
        await refresh();
      }
    } catch {
      setErr('network');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // ── Rendering ────────────────────────────────────────────────────────────
  if (on) {
    return (
      <section style={card}>
        <Header />
        <p style={{ marginTop: 8, color: '#4ad07a', fontWeight: 600 }}>✓ Deep Brain is ON</p>
        <p style={{ marginTop: 4, opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>
          People talking to you now get routed retrieval across your entire corpus.
        </p>
      </section>
    );
  }

  const pending = status?.counts.pending ?? 0;
  const processing = status?.counts.processing ?? 0;
  const erroredJobs = status?.counts.errored ?? 0;
  const done = status?.counts.done ?? 0;
  const total = status?.total ?? 0;
  const ready = status?.ready ?? false;
  const activating = ready && (status?.retrieval_version ?? initialRetrievalVersion) < 3;
  const building = pending + processing > 0;
  const stalled =
    !!status?.oldest_pending_at &&
    Date.now() - new Date(status.oldest_pending_at).getTime() > STALL_MS &&
    processing === 0;

  // Build verified complete → flipping on now (the "watch it level up" finish).
  if (activating) {
    return (
      <section style={card}>
        <Header />
        <p style={{ marginTop: 8, fontWeight: 600, color: '#4ad07a' }}>Activating your deep brain…</p>
        <p style={{ marginTop: 4, opacity: 0.7, fontSize: 14 }}>
          Build complete — switching you over. This only takes a moment.
        </p>
      </section>
    );
  }

  if (building) {
    return (
      <section style={card}>
        <Header />
        <p style={{ marginTop: 8, fontWeight: 600 }}>Building your deep brain…</p>
        <p style={{ marginTop: 4, opacity: 0.7, fontSize: 14 }}>
          {done}/{total} sources processed
          {status && status.queue_ahead > 0 ? ` · ${status.queue_ahead} ahead of you in the queue` : ''}
        </p>
        <p style={{ marginTop: 8, opacity: 0.6, fontSize: 13, lineHeight: 1.5 }}>
          {stalled
            ? 'This is taking longer than usual — the build queue is backed up. It’ll finish on its own; you can safely leave this page.'
            : 'Large corpora (a book, hundreds of hours) can take a while. You can leave this page — it keeps building.'}
        </p>
      </section>
    );
  }

  // OFF (nothing in flight). Distinguish a clean first-run from a prior build
  // that ended with errored jobs (re-audit M6 — don't render a silent OFF that
  // hides a failed build; tell the creator and let "Turn on" retry them).
  const errored = brainStatus === 'errored';
  const noContent = err === 'no_ready_samples';
  const hadErrors = erroredJobs > 0 && done < total;
  return (
    <section style={card}>
      <Header />
      <p style={{ marginTop: 8, opacity: 0.75, fontSize: 14, lineHeight: 1.5 }}>
        Ingesting a book or 1000+ hrs? Turn on <strong>Deep Brain</strong> — routed,
        hierarchical retrieval across your whole corpus so your avatar answers like
        it has read everything, not just a snippet.
      </p>
      <button
        type="button"
        onClick={() => void enable()}
        disabled={busy || errored}
        style={{ marginTop: 12, ...btn, opacity: busy || errored ? 0.6 : 1 }}
      >
        {busy ? 'Starting…' : hadErrors ? 'Retry Deep Brain build' : 'Turn on Deep Brain'}
      </button>
      {hadErrors && !errored && (
        <p style={{ marginTop: 8, color: '#f0b13a', fontSize: 13 }}>
          A previous build hit errors on {erroredJobs} source{erroredJobs === 1 ? '' : 's'}. Turn it
          on again to retry just those.
        </p>
      )}
      {(errored || err === 'brain_errored') && (
        <p style={{ marginTop: 8, color: '#f0b13a', fontSize: 13 }}>
          Finish setting up your brain first, then turn this on.
        </p>
      )}
      {noContent && (
        <p style={{ marginTop: 8, color: '#f0b13a', fontSize: 13 }}>
          Add your knowledge first — there’s nothing to build yet.
        </p>
      )}
      {err && !noContent && err !== 'brain_errored' && !errored && (
        <p role="alert" style={{ marginTop: 8, color: 'salmon', fontSize: 13 }}>
          Couldn’t start the build ({err}). Try again.
        </p>
      )}
    </section>
  );
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Deep Brain</h2>
      <span style={badge}>v3</span>
    </div>
  );
}

const card: React.CSSProperties = {
  padding: 16,
  border: '1px solid #222',
  borderRadius: 8,
};

const btn: React.CSSProperties = {
  background: '#4ad07a',
  color: '#06210f',
  border: 'none',
  padding: '10px 16px',
  borderRadius: 6,
  fontWeight: 600,
  cursor: 'pointer',
};

const badge: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: '#4ad07a',
  border: '1px solid #235',
  background: '#0d1a12',
  borderRadius: 999,
  padding: '2px 8px',
};
