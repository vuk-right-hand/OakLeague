// posthog-client.js — Day-13 fire-and-forget PostHog batch emitter.
//
// CONTRACT (Day-13 audit M2):
//   * Dispatch is queueMicrotask-deferred so the turn lifecycle's
//     turn_end_ack send is never blocked by PostHog ingest latency.
//   * Hard 1500ms total budget per batch via AbortController. Below this
//     undici's fetch may not have completed the TLS handshake on cold
//     pools; above this the in-flight backlog grows during incidents.
//   * Queue cap = 16 batches in-flight. Excess batches drop on the
//     floor (with a single warn-log per drop) rather than buffering
//     indefinitely.
//   * No-op silent return when POSTHOG_API_KEY is unset, BUT log once
//     at module load so an env misconfig doesn't masquerade as "we
//     have zero telemetry events." (Audit M2 fix.)
//   * Distinct ID = user_id (UUID). NO PII (audit S6).
//
// Why not the PostHog SDK:
//   posthog-node bundles a queuing + persistence layer that does NOT
//   compose with our 4000ms-per-turn lifecycle. A 30s default flush
//   interval means events for a session that completes in 60s could be
//   lost on Fly restart. Our hand-rolled emitter dispatches per turn
//   with bounded buffering — bounded loss, predictable backpressure.

const POSTHOG_BATCH_TIMEOUT_MS = 1500;
const POSTHOG_QUEUE_CAP = 16;

// Module-level state. Reset via _resetForTests().
let _config = null;
let _inFlight = 0;
let _dropped = 0;
let _lastDropWarnAt = 0;

function getConfig() {
  if (_config !== null) return _config;
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
  if (!apiKey) {
    // Audit M2: log ONCE at first call so an unset key surfaces in Fly logs
    // rather than silently dropping every event.
    // eslint-disable-next-line no-console
    console.warn('[posthog] POSTHOG_API_KEY unset — telemetry will NOT land');
    _config = { disabled: true };
    return _config;
  }
  _config = { disabled: false, apiKey, host: host.replace(/\/+$/, '') };
  return _config;
}

export function _resetForTests() {
  _config = null;
  _inFlight = 0;
  _dropped = 0;
  _lastDropWarnAt = 0;
}

/**
 * Capture a batch of events. Fire-and-forget — the call returns
 * synchronously after queuing; the fetch happens in a microtask.
 *
 * Args:
 *   events:      Array of { name, properties? }
 *   distinctId:  caller's user_id (UUID) — PostHog dedupes by this
 *   sessionId:   optional — added as a property to every event for filtering
 *
 * Returns:
 *   { queued: true, count: N } when enqueued
 *   { queued: false, reason: 'disabled' | 'empty' | 'queue_full' }
 */
export function captureBatch({ events, distinctId, sessionId }) {
  const cfg = getConfig();
  if (cfg.disabled) return { queued: false, reason: 'disabled' };
  if (!Array.isArray(events) || events.length === 0) {
    return { queued: false, reason: 'empty' };
  }
  if (_inFlight >= POSTHOG_QUEUE_CAP) {
    _dropped += 1;
    // Throttle the warn log: at most one per 10s so a sustained PostHog
    // outage doesn't fill the proxy console with identical lines.
    const now = Date.now();
    if (now - _lastDropWarnAt > 10_000) {
      // eslint-disable-next-line no-console
      console.warn(`[posthog] queue full (>= ${POSTHOG_QUEUE_CAP}); dropped ${_dropped} batches`);
      _lastDropWarnAt = now;
    }
    return { queued: false, reason: 'queue_full' };
  }

  _inFlight += 1;
  const ts = new Date().toISOString();
  const batch = events.map((e) => ({
    event: e.name,
    distinct_id: distinctId,
    timestamp: ts,
    properties: {
      ...(e.properties ?? {}),
      ...(sessionId ? { $session_id: sessionId } : {}),
    },
  }));
  const body = JSON.stringify({ api_key: cfg.apiKey, batch });

  // queueMicrotask defers the fetch until after the current call stack
  // unwinds — turn_end_ack's ws.send fires synchronously first.
  queueMicrotask(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POSTHOG_BATCH_TIMEOUT_MS);
    fetch(`${cfg.host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ac.signal,
    })
      .then((res) => {
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[posthog] batch ${res.status}`);
        }
        // Drain the body to release the socket back to the pool. undici
        // does NOT auto-drain on .ok response (only on .json/.text).
        // audit-build S3: swallow cancel() rejections to avoid noisy
        // `[posthog] batch error: …` logs on torn-down streams.
        return res.body?.cancel?.()?.catch?.(() => {});
      })
      .catch((e) => {
        if (e?.name === 'AbortError') {
          // eslint-disable-next-line no-console
          console.warn(`[posthog] batch timeout (${POSTHOG_BATCH_TIMEOUT_MS}ms)`);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[posthog] batch error: ${e?.message ?? e}`);
        }
      })
      .finally(() => {
        clearTimeout(timer);
        _inFlight = Math.max(0, _inFlight - 1);
      });
  });

  return { queued: true, count: batch.length };
}

/** Test-only — inspect in-flight count without exposing the variable. */
export function _getInFlightCount() {
  return _inFlight;
}

/**
 * Day-13 audit-build M2 — drain in-flight batches before SIGTERM.
 * Polls _inFlight every 50ms; returns when zero OR timeout reached.
 * Default timeout 1000ms — matches the AbortController budget so we
 * never wait longer than a single batch could legitimately take.
 * NEVER throws.
 */
export async function drainInFlight({ timeoutMs = 1000 } = {}) {
  const start = Date.now();
  while (_inFlight > 0 && Date.now() - start < timeoutMs) {
    await new Promise((res) => setTimeout(res, 50));
  }
  return { drained: _inFlight === 0, remaining: _inFlight };
}
