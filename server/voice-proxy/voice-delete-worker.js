// R4-M3 — Cartesia voice-delete queue worker. Drained inside the Fly proxy
// because Vercel serverless functions can't survive the 60s defer window.
//
// Tick cadence: 30s.
// Per-tick:
//   1. SELECT * FROM voice_delete_queue WHERE due_at <= now() AND attempts < 10
//      ORDER BY due_at ASC LIMIT 5.
//   2. For each row: DELETE https://api.cartesia.ai/voices/{voice_id} with
//      a 5s AbortController timeout.
//      - 200/204/404 → row deleted from queue.
//      - Anything else → attempts += 1, last_error stored, retry next tick.
//   3. After 10 failed attempts, the row sits with attempts=10 and the
//      partial-due_at index excludes it from the worker — manual cleanup.
//      Sentry warning at attempt 5 + 10 to surface the orphan.

import { captureException } from './sentry.js';

const CARTESIA_VERSION = '2026-03-01';
const TICK_MS = 30_000;
const PER_TICK_LIMIT = 5;
const FETCH_TIMEOUT_MS = 5_000;

export function makeVoiceDeleteWorker({ supabase, cartesiaApiKey } = {}) {
  if (!supabase) throw new Error('supabase required');
  if (!cartesiaApiKey) throw new Error('cartesiaApiKey required');

  // R3-C3 (sec) — per-row, per-threshold dedup so we don't re-alert
  // every tick once attempts crosses a threshold. Restarts re-alert by
  // design: a crash-loop on this row IS the signal worth surfacing.
  const seenAlertedAttempts = new Set();

  async function tick() {
    // L-C1 / S-M1 — atomic claim. The RPC bumps attempts inside FOR UPDATE
    // SKIP LOCKED so a concurrent Fly machine sees the row as taken and
    // moves on. attempts returned here is post-bump; never trust the
    // pre-claim count for thresholding.
    const { data: rows, error } = await supabase.rpc('voice_delete_queue_claim', {
      p_limit: PER_TICK_LIMIT,
    });
    if (error) {
      console.error('[voice-delete-worker] claim', error);
      captureException(error, { op: 'voice_delete_claim' });
      return;
    }
    if (!rows || rows.length === 0) return;

    for (const row of rows) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let ok = false;
      let lastError = null;
      try {
        const res = await fetch(
          `https://api.cartesia.ai/voices/${encodeURIComponent(row.voice_id)}`,
          {
            method: 'DELETE',
            headers: {
              // Cartesia REST uses Bearer (WS uses X-API-Key — see
              // cartesia-bridge.js header comment). Both verified against
              // docs.cartesia.ai 2026-05-02.
              authorization: `Bearer ${cartesiaApiKey}`,
              'Cartesia-Version': CARTESIA_VERSION,
            },
            signal: ac.signal,
          },
        );
        if (res.status === 200 || res.status === 204 || res.status === 404) {
          ok = true;
        } else {
          lastError = `status=${res.status}`;
        }
      } catch (e) {
        // S-M6 / R3-S — whitelist the shape. AbortError (our timeout
        // path) gets a distinct tag so dashboards can distinguish a
        // Cartesia hang from a transport error.
        let msg = 'fetch_failed';
        if (e?.name === 'AbortError') msg = 'timeout';
        else if (e?.code) msg = String(e.code);
        lastError = msg.slice(0, 80);
      } finally {
        clearTimeout(to);
      }

      if (ok) {
        const { error: doneErr } = await supabase.rpc('voice_delete_queue_complete', {
          p_voice_id: row.voice_id,
        });
        if (doneErr) {
          console.error('[voice-delete-worker] complete', doneErr);
          captureException(doneErr, { op: 'voice_delete_complete', voice_id: row.voice_id });
        }
      } else {
        const { error: failErr } = await supabase.rpc('voice_delete_queue_record_failure', {
          p_voice_id: row.voice_id,
          p_last_error: lastError,
        });
        if (failErr) {
          console.error('[voice-delete-worker] record_failure', failErr);
          captureException(failErr, { op: 'voice_delete_record_failure', voice_id: row.voice_id });
        }
        // R3-C3 (sec): attempts was bumped inside the claim RPC.
        // Threshold off the returned (post-bump) value. Use `>=` rather
        // than exact equality so a crash-loop that bumps 4→6→8 never
        // skips the warn event. The `seenAlertedAttempts` Set in this
        // worker process dedupes per-voice_id within a single boot —
        // restarts re-alert, which is the correct behavior (a crash-loop
        // is itself the signal we want to surface).
        if (!seenAlertedAttempts.has(`${row.voice_id}:5`) && row.attempts >= 5 && row.attempts < 10) {
          seenAlertedAttempts.add(`${row.voice_id}:5`);
          captureException(new Error('voice_delete_orphan_attempts_5'), {
            level: 'warning',
            op: 'voice_delete_orphan',
            voice_id: row.voice_id,
            attempts: row.attempts,
            lastError,
          });
        }
        if (!seenAlertedAttempts.has(`${row.voice_id}:10`) && row.attempts >= 10) {
          seenAlertedAttempts.add(`${row.voice_id}:10`);
          captureException(new Error('voice_delete_orphan_attempts_10'), {
            level: 'fatal',
            op: 'voice_delete_orphan',
            voice_id: row.voice_id,
            attempts: row.attempts,
            lastError,
          });
        }
      }
    }
  }

  function install() {
    // Run once at boot, then every TICK_MS.
    tick().catch((e) => {
      console.error('[voice-delete-worker] init tick failed', e);
      captureException(e, { op: 'voice_delete_init' });
    });
    const handle = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
    return { handle, tick };
  }

  return { install, tick };
}
