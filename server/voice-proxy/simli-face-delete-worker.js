// SIMLI_WIREUP §12a.3 / R3-Missing-3 / R4-C3 — Simli face-delete queue worker.
//
// Mirrors voice-delete-worker.js for the simli_face_delete_queue (migration
// 20260507000003). Drained inside the Fly proxy because Vercel serverless
// can't survive the 60s defer window.
//
// R4-C3 race-guard lives in the simli_face_delete_queue_claim RPC: rows
// whose creator has an active session are skipped. Worker just calls the
// RPC and trusts the queue gate.
//
// Tick cadence: 30s. Per-tick: claim ≤5 rows, DELETE each, complete or
// record_failure. Orphan thresholds at attempts=5 (warning) and =10 (fatal),
// same dedup pattern as voice-delete-worker.
//
// Simli REST: per mint-simli.ts header convention uses x-simli-api-key.
// Phase 0 (PHASE_0_FACE_API.md) confirmed:
//   DELETE /faces/trinity/{face_id} — returns 200/204 on success, 404 if
//   already gone (idempotent → treat as success).
//   400 with body {detail: "Failed to Delete FaceId"} when the face is
//   still pending generation. Treat as retry-later: extend due_at by 5
//   minutes and re-claim, do NOT increment to attempts=10 (keeps the row
//   from getting stuck in fatal-orphan state during a slow Simli queue).
//
// Pre-Phase-0 the URL base was '/faces/' which 404'd silently — every
// retrain was leaking an orphan face inside Simli forever. Fixed below.

import { captureException } from './sentry.js';

const TICK_MS = 30_000;
const PER_TICK_LIMIT = 5;
const FETCH_TIMEOUT_MS = 5_000;
const RETRY_DEFER_MS = 5 * 60_000; // 5 min for "still pending" retries
const SIMLI_FACE_URL_BASE = 'https://api.simli.ai/faces/trinity/';

export function makeSimliFaceDeleteWorker({ supabase, simliApiKey } = {}) {
  if (!supabase) throw new Error('supabase required');
  if (!simliApiKey) throw new Error('simliApiKey required');

  const seenAlertedAttempts = new Set();

  async function tick() {
    const { data: rows, error } = await supabase.rpc('simli_face_delete_queue_claim', {
      p_limit: PER_TICK_LIMIT,
    });
    // After claim, fetch pending_retry_count for the claimed rows. Claim
    // RPC was defined before NC3 and doesn't return the new column;
    // rather than re-version the RPC, we read it back here.
    let retryCounts = new Map();
    if (rows && rows.length > 0) {
      const ids = rows.map((r) => r.face_id);
      const { data: extras } = await supabase
        .from('simli_face_delete_queue')
        .select('face_id, pending_retry_count')
        .in('face_id', ids);
      for (const ex of (extras || [])) {
        retryCounts.set(ex.face_id, ex.pending_retry_count ?? 0);
      }
    }
    if (error) {
      console.error('[simli-face-delete-worker] claim', error);
      captureException(error, { op: 'simli_face_delete_claim' });
      return;
    }
    if (!rows || rows.length === 0) return;

    for (const row of rows) {
      // Hydrate pending_retry_count from the side-fetch above so the
      // pendingRetry path can ratchet it monotonically.
      row.pending_retry_count = retryCounts.get(row.face_id) ?? 0;
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let ok = false;
      let pendingRetry = false; // 400 "Failed to Delete FaceId" — face still training
      let lastError = null;
      try {
        const res = await fetch(
          `${SIMLI_FACE_URL_BASE}${encodeURIComponent(row.face_id)}`,
          {
            method: 'DELETE',
            headers: { 'x-simli-api-key': simliApiKey },
            signal: ac.signal,
          },
        );
        if (res.status === 200 || res.status === 204 || res.status === 404) {
          ok = true;
        } else if (res.status === 400) {
          // Phase 0: pending-state delete returns 400 + {detail: "Failed to Delete FaceId"}.
          // Don't burn an attempt — extend due_at and try later.
          let body = null;
          try { body = await res.json(); } catch { /* ignore */ }
          const detail = String(body?.detail || '').toLowerCase();
          if (detail.includes('failed to delete')) {
            pendingRetry = true;
            lastError = `pending_retry: ${detail.slice(0, 80)}`;
          } else {
            lastError = `status=400 ${detail.slice(0, 80)}`;
          }
        } else {
          lastError = `status=${res.status}`;
        }
      } catch (e) {
        let msg = 'fetch_failed';
        if (e?.name === 'AbortError') msg = 'timeout';
        else if (e?.code) msg = String(e.code);
        lastError = msg.slice(0, 80);
      } finally {
        clearTimeout(to);
      }

      if (ok) {
        const { error: doneErr } = await supabase.rpc('simli_face_delete_queue_complete', {
          p_face_id: row.face_id,
        });
        if (doneErr) {
          console.error('[simli-face-delete-worker] complete', doneErr);
          captureException(doneErr, { op: 'simli_face_delete_complete', face_id: row.face_id });
        }
      } else if (pendingRetry) {
        // Push due_at out by 5 min. simli_face_delete_queue_claim already
        // incremented attempts at the start of this tick; we roll the
        // increment back so a face stuck in pending generation doesn't
        // ratchet into the 10-attempt fatal-orphan threshold while Simli
        // is doing its job. Net attempts change for this tick: 0.
        //
        // Auditor R3-NC3 — but a face genuinely stuck in pending forever
        // (Simli vendor outage) would otherwise loop silently and never
        // alert. pending_retry_count tracks the rollback path separately;
        // we alert at >=12 (~1h at 5min cadence) without ever decrementing.
        const newPendingRetry = (row.pending_retry_count ?? 0) + 1;
        const dueAt = new Date(Date.now() + RETRY_DEFER_MS).toISOString();
        // Auditor R4-M4 — direct .update() (not RPC) is intentional: the
        // proxy uses the service-role key, RLS doesn't apply, and the
        // existing record_failure RPC doesn't accept the rollback +
        // pending_retry_count fields. If anyone ever switches the proxy
        // to anon (don't), wrap this in a SECURITY DEFINER RPC.
        const { error: rescheduleErr } = await supabase
          .from('simli_face_delete_queue')
          .update({
            due_at: dueAt,
            attempts: Math.max(0, (row.attempts ?? 0) - 1),
            pending_retry_count: Math.min(50, newPendingRetry),
            last_error: lastError,
            updated_at: new Date().toISOString(),
          })
          .eq('face_id', row.face_id);
        if (newPendingRetry === 12 && !seenAlertedAttempts.has(`${row.face_id}:pending12`)) {
          seenAlertedAttempts.add(`${row.face_id}:pending12`);
          captureException(new Error('simli_face_delete_pending_retry_12'), {
            level: 'warning',
            op: 'simli_face_delete_pending_retry',
            face_id: row.face_id,
            pendingRetry: newPendingRetry,
          });
        }
        if (newPendingRetry >= 24 && !seenAlertedAttempts.has(`${row.face_id}:pending24`)) {
          seenAlertedAttempts.add(`${row.face_id}:pending24`);
          captureException(new Error('simli_face_delete_pending_retry_24'), {
            level: 'fatal',
            op: 'simli_face_delete_pending_retry',
            face_id: row.face_id,
            pendingRetry: newPendingRetry,
          });
        }
        if (rescheduleErr) {
          console.error('[simli-face-delete-worker] reschedule', rescheduleErr);
          captureException(rescheduleErr, {
            op: 'simli_face_delete_reschedule',
            face_id: row.face_id,
          });
        }
      } else {
        const { error: failErr } = await supabase.rpc('simli_face_delete_queue_record_failure', {
          p_face_id: row.face_id,
          p_last_error: lastError,
        });
        if (failErr) {
          console.error('[simli-face-delete-worker] record_failure', failErr);
          captureException(failErr, { op: 'simli_face_delete_record_failure', face_id: row.face_id });
        }
        if (!seenAlertedAttempts.has(`${row.face_id}:5`) && row.attempts >= 5 && row.attempts < 10) {
          seenAlertedAttempts.add(`${row.face_id}:5`);
          captureException(new Error('simli_face_delete_orphan_attempts_5'), {
            level: 'warning',
            op: 'simli_face_delete_orphan',
            face_id: row.face_id,
            attempts: row.attempts,
            lastError,
          });
        }
        if (!seenAlertedAttempts.has(`${row.face_id}:10`) && row.attempts >= 10) {
          seenAlertedAttempts.add(`${row.face_id}:10`);
          captureException(new Error('simli_face_delete_orphan_attempts_10'), {
            level: 'fatal',
            op: 'simli_face_delete_orphan',
            face_id: row.face_id,
            attempts: row.attempts,
            lastError,
          });
        }
      }
    }
  }

  function install() {
    tick().catch((e) => {
      console.error('[simli-face-delete-worker] init tick failed', e);
      captureException(e, { op: 'simli_face_delete_init' });
    });
    const handle = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
    return { handle, tick };
  }

  return { install, tick };
}
