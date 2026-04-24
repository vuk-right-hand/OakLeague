// Client-side feed event emitter. Batches events across a 1s window so a
// scroll burst of impressions + dwell-ends + swipes coalesces into a single
// POST. Uses navigator.sendBeacon on pagehide so trailing events survive a
// tab close.

'use client';

import type { FeedEvent, FeedEventName } from '@/types/feed';

type EventInput = {
  event_name: FeedEventName;
  hook_id?: string;
  video_id?: string;
  creator_id?: string;
  session_id?: string;
  session_id_if_opened?: string;
  payload?: Record<string, unknown>;
};

const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH = 50;

let queue: FeedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pagehideHooked = false;

function newIdempotencyKey(): string {
  // crypto.randomUUID() is available in all supported browsers (2022+).
  // The RPC's UNIQUE (user_id, event_name, idempotency_key) dedupes reruns.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: time-prefixed random; not RFC 4122 but well within uuid
  // format constraints the RPC validates.
  const rand = Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
  const t = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-4${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 12)}${t.slice(0, 6)}`;
}

function schedule() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush(useBeacon = false): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  const body = JSON.stringify({ events: batch });

  if (useBeacon && typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon('/api/feed/events', blob);
    return;
  }

  try {
    const res = await fetch('/api/feed/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
    // 400 = we sent a bad event shape; dropping the batch is correct —
    // retrying won't fix the payload. 401 / 500 we swallow: events are
    // best-effort by definition, and a background retry queue isn't
    // worth the complexity in v1.
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.debug('[feed/events] POST non-2xx', res.status);
    }
  } catch {
    /* offline / network error — drop the batch */
  }

  if (queue.length > 0) schedule();
}

function hookPagehide() {
  if (pagehideHooked || typeof window === 'undefined') return;
  pagehideHooked = true;
  window.addEventListener('pagehide', () => void flush(true));
  // Safari sometimes fires `visibilitychange → hidden` without pagehide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush(true);
  });
}

export function recordFeedEvent(input: EventInput): void {
  if (typeof window === 'undefined') return;
  hookPagehide();
  queue.push({
    event_name: input.event_name,
    idempotency_key: newIdempotencyKey(),
    hook_id: input.hook_id,
    video_id: input.video_id,
    creator_id: input.creator_id,
    session_id: input.session_id,
    session_id_if_opened: input.session_id_if_opened,
    payload: input.payload,
  });
  if (queue.length >= MAX_BATCH) {
    void flush();
    return;
  }
  schedule();
}
