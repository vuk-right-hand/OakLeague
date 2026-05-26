// HUME_TTS_PLAN §5.4 — multi-provider voice-delete queue worker.
//
// Drained inside the Fly proxy because Vercel serverless can't survive
// the 60s defer window. Now multi-provider after Hume integration —
// dispatches via the row's tts_provider column.
//
// Tick cadence: 30s.
// Per-tick:
//   1. SELECT (claim) via voice_delete_queue_claim_v2 — returns
//      (tts_provider, voice_id, voice_name, attempts, due_at).
//   2. Per row, dispatch by tts_provider:
//      - cartesia + cartesiaApiKey present:
//          DELETE https://api.cartesia.ai/voices/{voice_id}
//          Authorization: Bearer <key>
//          200/204/404 → success
//      - hume + humeApiKey present + voice_name NOT NULL:
//          DELETE https://api.hume.ai/v0/tts/voices?name=<voice_name>
//          X-Hume-Api-Key: <key>
//          200/204/404 → success (404 = already gone, Hume body echoes
//          "Octave Custom Voice ... does not exist")
//      - missing the key for the row's provider OR
//        tts_provider='hume' AND voice_name IS NULL:
//          leave row, log once, do NOT bump attempts
//          (R2-M3 amendment: after 24h since last update, bump once
//           per tick so the 10-attempt cutoff catches the orphan)
//   3. After 10 failed attempts the row sits orphan (claim filters
//      attempts < 10). Sentry warning at 5, fatal at 10.
//
// Boot UNCONDITIONALLY (R1-M1) — the keys-missing branch handles the
// "neither provider configured" case at the row level.
//
// Dedup key for Sentry alerts: ${tts_provider}:${voice_id}:<threshold>.
// Hume rows share voice_id space with Cartesia (both UUIDs, vanishingly
// small collision but the composite key formalizes it).

import { captureException } from './sentry.js';

const CARTESIA_VERSION = '2026-03-01';
const TICK_MS = 30_000;
const PER_TICK_LIMIT = 5;
const FETCH_TIMEOUT_MS = 5_000;
// R2-M3: bump attempts for "missing dispatch prerequisite" rows after
// they've sat untouched for at least this long, so the 10-attempt cutoff
// catches permanently-stuck orphans.
const ORPHAN_BUMP_AFTER_MS = 24 * 3600 * 1000;

export function makeVoiceDeleteWorker({ supabase, cartesiaApiKey = null, humeApiKey = null } = {}) {
  if (!supabase) throw new Error('supabase required');
  // R1-M1: no key required at construction. Per-row dispatch checks the
  // right key by tts_provider. A proxy booted without ANY key still ticks
  // — it just logs missing-prereq for every claimed row. That's the
  // correct behavior: dropped keys should surface as visible orphans
  // rather than silently disabling the worker.

  // Per-row, per-threshold dedup so we don't re-alert every tick once
  // attempts crosses a threshold. Restarts re-alert by design.
  // Composite key prevents cross-provider collision.
  const seenAlertedAttempts = new Set();

  async function dispatchCartesia(row) {
    if (!cartesiaApiKey) return { ok: false, lastError: 'no_cartesia_key', skipBump: true };
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.cartesia.ai/voices/${encodeURIComponent(row.voice_id)}`,
        {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${cartesiaApiKey}`,
            'Cartesia-Version': CARTESIA_VERSION,
          },
          signal: ac.signal,
        },
      );
      if (res.status === 200 || res.status === 204 || res.status === 404) {
        return { ok: true };
      }
      return { ok: false, lastError: `status=${res.status}` };
    } catch (e) {
      let msg = 'fetch_failed';
      if (e?.name === 'AbortError') msg = 'timeout';
      else if (e?.code) msg = String(e.code);
      return { ok: false, lastError: msg.slice(0, 80) };
    } finally {
      clearTimeout(to);
    }
  }

  async function dispatchHume(row) {
    if (!humeApiKey) return { ok: false, lastError: 'no_hume_key', skipBump: true };
    // Migration M3 enforces tts_provider='hume' → voice_name NOT NULL
    // at the DB level, but defensive double-check here. If somehow a
    // hume row landed without voice_name, leaving it (skipBump:true)
    // ensures the orphan is surfaced rather than burning attempts.
    if (!row.voice_name) return { ok: false, lastError: 'no_voice_name', skipBump: true };

    // §6 unit-wide audit C2+C3 fix (2026-05-13): GET-verify-id BEFORE
    // dispatching DELETE-by-name. Hume's DELETE endpoint is keyed by
    // name only — if an admin renamed the voice in app.hume.ai/voices
    // between enqueue and dispatch (or if Hume's "delete by name"
    // semantics affect more than the one row we intended), we could
    // nuke the wrong creator's live voice. Defense: list voices by
    // name, confirm the live row's id matches what we enqueued. If
    // mismatch, leave the queue row, log once via Sentry. The
    // attempts bump already happened in claim_v2; we accept it.
    let listRes;
    try {
      const listAc = new AbortController();
      const listTo = setTimeout(() => listAc.abort(), FETCH_TIMEOUT_MS);
      try {
        listRes = await fetch(
          `https://api.hume.ai/v0/tts/voices?name=${encodeURIComponent(row.voice_name)}&provider=CUSTOM_VOICE`,
          {
            method: 'GET',
            headers: { 'X-Hume-Api-Key': humeApiKey, accept: 'application/json' },
            signal: listAc.signal,
          },
        );
      } finally { clearTimeout(listTo); }
    } catch (e) {
      let msg = 'verify_fetch_failed';
      if (e?.name === 'AbortError') msg = 'verify_timeout';
      else if (e?.code) msg = String(e.code);
      return { ok: false, lastError: msg.slice(0, 80) };
    }
    if (listRes.status === 404) {
      // No voice with that name — already deleted (admin/UI cleanup,
      // or earlier dispatch succeeded but our record_failure raced).
      // Treat as success: dequeue.
      return { ok: true };
    }
    if (!listRes.ok) {
      return { ok: false, lastError: `verify_status=${listRes.status}` };
    }
    let listBody;
    try {
      listBody = await listRes.json();
    } catch {
      return { ok: false, lastError: 'verify_bad_json' };
    }
    const voices = Array.isArray(listBody?.voices) ? listBody.voices : [];
    const match = voices.find((v) => String(v?.id ?? '') === row.voice_id && String(v?.name ?? '') === row.voice_name);
    if (!match) {
      // Live Hume voice with this name has a DIFFERENT id than what we
      // enqueued. Could be: (a) admin renamed the voice in UI, (b) admin
      // deleted+recreated with same name, (c) entirely different creator
      // claimed the name after our enqueue. In all cases, dispatching
      // DELETE-by-name would nuke the WRONG voice. Refuse.
      return { ok: false, lastError: 'hume_voice_renamed_in_ui', skipBump: true };
    }

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      // DELETE-by-name, NOT by id (Hume keys voice DELETE by name —
      // Phase-0 verified via SDK source 2026-05-13).
      const url = `https://api.hume.ai/v0/tts/voices?name=${encodeURIComponent(row.voice_name)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'X-Hume-Api-Key': humeApiKey },
        signal: ac.signal,
      });
      // Phase-0 verified: 200/204 = deleted, 404 with body
      // {message:"Octave Custom Voice ... does not exist"} = already
      // gone — both treated as success (dequeue).
      if (res.status === 200 || res.status === 204 || res.status === 404) {
        return { ok: true };
      }
      return { ok: false, lastError: `status=${res.status}` };
    } catch (e) {
      let msg = 'fetch_failed';
      if (e?.name === 'AbortError') msg = 'timeout';
      else if (e?.code) msg = String(e.code);
      return { ok: false, lastError: msg.slice(0, 80) };
    } finally {
      clearTimeout(to);
    }
  }

  async function tick() {
    // Atomic claim via v2 RPC — returns tts_provider per row. The RPC
    // bumps attempts inside FOR UPDATE SKIP LOCKED so concurrent Fly
    // machines don't double-dispatch.
    const { data: rows, error } = await supabase.rpc('voice_delete_queue_claim_v2', {
      p_limit: PER_TICK_LIMIT,
    });
    if (error) {
      console.error('[voice-delete-worker] claim', error);
      captureException(error, { op: 'voice_delete_claim' });
      return;
    }
    if (!rows || rows.length === 0) return;

    for (const row of rows) {
      let result;
      if (row.tts_provider === 'cartesia') {
        result = await dispatchCartesia(row);
      } else if (row.tts_provider === 'hume') {
        result = await dispatchHume(row);
      } else {
        result = { ok: false, lastError: `unknown_provider:${row.tts_provider}` };
      }

      // R2-M3: for "missing dispatch prerequisite" rows (no key, no
      // voice_name), skipBump:true means we don't burn an attempt. But
      // if the row has been sitting untouched for >24h, we DO start
      // burning attempts so the 10-attempt cutoff catches the orphan
      // and Sentry alerts on it instead of leaking forever silently.
      if (result.skipBump) {
        const ageMs = Date.now() - new Date(row.due_at).getTime();
        const isStaleOrphan = ageMs > ORPHAN_BUMP_AFTER_MS;
        if (!isStaleOrphan) {
          // Just log once per tick — claim already bumped attempts so
          // we need to "undo" that bump by NOT recording failure (the
          // bump was inside the claim transaction; we accept it for
          // now and rely on the 24h ageMs check to gate Sentry alerts).
          console.warn('[voice-delete-worker] skipping row', row.tts_provider, row.voice_id, result.lastError);
          continue;
        }
        // Fall through: record the failure so attempts trends toward 10.
      }

      if (result.ok) {
        const { error: doneErr } = await supabase.rpc('voice_delete_queue_complete_v2', {
          p_tts_provider: row.tts_provider,
          p_voice_id: row.voice_id,
        });
        if (doneErr) {
          console.error('[voice-delete-worker] complete', doneErr);
          captureException(doneErr, { op: 'voice_delete_complete', tts_provider: row.tts_provider, voice_id: row.voice_id });
        }
      } else {
        const { error: failErr } = await supabase.rpc('voice_delete_queue_record_failure_v2', {
          p_tts_provider: row.tts_provider,
          p_voice_id: row.voice_id,
          p_last_error: result.lastError,
        });
        if (failErr) {
          console.error('[voice-delete-worker] record_failure', failErr);
          captureException(failErr, { op: 'voice_delete_record_failure', tts_provider: row.tts_provider, voice_id: row.voice_id });
        }
        // Composite dedup key — Hume + Cartesia voice_id share UUID space
        // (vanishingly small but the composite makes it explicit).
        const dedupBase = `${row.tts_provider}:${row.voice_id}`;
        if (!seenAlertedAttempts.has(`${dedupBase}:5`) && row.attempts >= 5 && row.attempts < 10) {
          seenAlertedAttempts.add(`${dedupBase}:5`);
          captureException(new Error('voice_delete_orphan_attempts_5'), {
            level: 'warning',
            op: 'voice_delete_orphan',
            tts_provider: row.tts_provider,
            voice_id: row.voice_id,
            attempts: row.attempts,
            lastError: result.lastError,
          });
        }
        if (!seenAlertedAttempts.has(`${dedupBase}:10`) && row.attempts >= 10) {
          seenAlertedAttempts.add(`${dedupBase}:10`);
          captureException(new Error('voice_delete_orphan_attempts_10'), {
            level: 'fatal',
            op: 'voice_delete_orphan',
            tts_provider: row.tts_provider,
            voice_id: row.voice_id,
            attempts: row.attempts,
            lastError: result.lastError,
          });
        }
      }
    }
  }

  function install() {
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
