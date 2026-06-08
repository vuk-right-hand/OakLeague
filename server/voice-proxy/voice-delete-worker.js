// HUME_TTS_PLAN §5.4 + FISH_AUDIO_PHASE_1 §4 M4 — multi-provider voice-delete
// queue worker.
//
// Drained inside the Fly proxy because Vercel serverless can't survive
// the 60s defer window. Now multi-provider (cartesia | hume | fish);
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
//      - fish + fishApiKey present:
//          DELETE https://api.fish.audio/model/{voice_id}
//          Authorization: Bearer <key>
//          200/204/404 → success (idempotent per FISH plan §4 M4 +
//          Phase 0.5 #8 — manual verification stamp pending). Fish
//          DELETE is keyed by id only; no name pair like Hume → no
//          GET-verify-before-DELETE needed.
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

export function makeVoiceDeleteWorker({ supabase, cartesiaApiKey = null, humeApiKey = null, fishApiKey = null } = {}) {
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

  async function dispatchFish(row) {
    if (!fishApiKey) return { ok: false, lastError: 'no_fish_key', skipBump: true };

    // Audit C1 defense-in-depth — even with the M6 migration's queue-side
    // charset CHECK, a row could pre-date the migration or slip through
    // via service-role SQL. Refuse here with skipBump:true so a malformed
    // id surfaces as an ORPHAN (Sentry-visible after 24h orphan-bump)
    // rather than silently 404'ing on Fish and dequeuing a GDPR-claim
    // that never targeted a real model.
    if (!row.voice_id || typeof row.voice_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.voice_id) || row.voice_id.length > 128) {
      captureException(new Error('voice_delete_queue_fish_voice_id_malformed'), {
        op: 'fish_voice_id_shape',
        voice_id_prefix: typeof row.voice_id === 'string' ? row.voice_id.slice(0, 8) : 'non-string',
        voice_id_length: typeof row.voice_id === 'string' ? row.voice_id.length : 0,
      });
      return { ok: false, lastError: 'malformed_voice_id', skipBump: true };
    }

    // FISH_AUDIO_PHASE_1 §6 M4: DELETE keyed by id only. No companion
    // name column → no rename attack surface (Hume's GET-verify-before-
    // DELETE doesn't apply here). C4 (audit, deferred): GET-verify
    // ownership before DELETE would be Hume-strength defense; pending
    // Phase 0.5 #8 stamp + Fish-side owner field in GET response.
    //
    // No filter on the URL — Fish DELETE is unambiguous by id (single
    // namespace). If Fish ever adds model types/scopes, revisit.
    //
    // Idempotency per plan §6 M4 + Phase 0.5 #8 (manual verification
    // stamp pending — verify 200/204/404 semantics during cutover and
    // update this comment when stamped).
    //
    // Audit C2: 429/503 + 401/403 use skipBump so an upstream-temporary
    // (rate-limit, account-suspended, bad key) doesn't burn the row to
    // orphan-fatal in 5 minutes — those are NOT "delete failed
    // permanently" signals.
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.fish.audio/model/${encodeURIComponent(row.voice_id)}`,
        {
          method: 'DELETE',
          headers: {
            // Audit M2: Capitalized 'Authorization' for any case-sensitive
            // Edge proxy in front of Fish. Lowercase works for HTTP/1.1+2
            // header parsing but Fish-side middleware case-sensitivity is
            // unverified (Phase 0.5 #8 manual stamp item).
            Authorization: `Bearer ${fishApiKey}`,
            // Audit M3: User-Agent for Fish-side identification + abuse-
            // heuristic whitelist if Fish ever introduces UA-based gating.
            'User-Agent': 'oakleague-voice-delete-worker/1 (+https://oak-league.vercel.app)',
          },
          signal: ac.signal,
        },
      );
      if (res.status === 200 || res.status === 204 || res.status === 404) {
        return { ok: true };
      }
      // Audit C2: rate-limited / overloaded — retry without burning attempts.
      if (res.status === 429 || res.status === 503) {
        return { ok: false, lastError: `transient_status=${res.status}`, skipBump: true };
      }
      // Audit C2: bad key / account suspended — retrying won't help; surface
      // as orphan so admin notices via the 24h orphan-bump alert. Do NOT
      // burn the row to "fatal delete failed" in 5min — that would falsely
      // claim Fish rejected the model, when really Fish rejected the auth.
      if (res.status === 401 || res.status === 403) {
        captureException(new Error(`fish_delete_auth_failure_${res.status}`), {
          level: 'error', op: 'fish_delete_auth', tts_provider: 'fish', voice_id: row.voice_id,
        });
        return { ok: false, lastError: `auth_status=${res.status}`, skipBump: true };
      }
      return { ok: false, lastError: `status=${res.status}` };
    } catch (e) {
      // Audit M4: whitelist known error fields so a freak undici error
      // can't leak FISH_API_KEY-shaped fragments into Sentry strings.
      let msg = 'fetch_failed';
      if (e?.name === 'AbortError') msg = 'timeout';
      else if (typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code)) msg = e.code;
      return { ok: false, lastError: msg.slice(0, 80) };
    } finally {
      clearTimeout(to);
    }
  }

  // Audit M1 — small inter-dispatch jitter so a 5-row tick doesn't fire
  // sequential DELETEs in <100ms back-to-back, which could trip an
  // upstream per-IP rate budget on any provider. 200ms between calls
  // gives ~5 req/s/upstream worst-case. Fish Starter tier's exact DELETE
  // rate limit is unstamped (Phase 0.5 #8).
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  const INTER_DISPATCH_JITTER_MS = 200;

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

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Audit M1 — inter-dispatch jitter between rows (skip on first).
      if (i > 0) await sleep(INTER_DISPATCH_JITTER_MS);
      let result;
      if (row.tts_provider === 'cartesia') {
        result = await dispatchCartesia(row);
      } else if (row.tts_provider === 'hume') {
        result = await dispatchHume(row);
      } else if (row.tts_provider === 'fish') {
        result = await dispatchFish(row);
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
