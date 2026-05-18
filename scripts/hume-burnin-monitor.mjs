#!/usr/bin/env node
/**
 * HUME_TTS_PLAN §8 step 3 — burn-in monitor.
 *
 * Polls every 60s for red flags on the burn-in creator's Hume sessions:
 *   * Sessions with end_reason in RED_END_REASONS (taxonomy below)
 *   * cogs_log rows with metadata.tts_cap_exceeded=true (per-turn cap fired)
 *   * cogs_log rows where service='hume' AND (cost_usd=0 OR cost_usd IS NULL)
 *     with units > 0 — pricing misconfig signal
 *   * Sessions opened on hume that NEVER completed a turn (likely WS-open
 *     failure or first-turn fatal)
 *
 * Audit fixes applied:
 *   C4 — cost_usd NULL is also pricing-misconfig; check it.
 *   M1 — RED_END_REASONS taxonomy cross-checked against proxy as of 2026-05-13.
 *   M2 — Window anchors at SCRIPT-START, not rolling. Hour-0 problems stay
 *        visible at hour 48.
 *   M4 — JSONB type-drift defense for tts_cap_exceeded.
 *   M5 — Startup sanity check that the monitored creator is actually on Hume.
 *
 * Exits 0 on clean window, exits 1 + prints red-flag rows on any signal.
 * Re-run after fixing the underlying issue.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   HUME_BURNIN_CREATOR_ID         — Vuk's creator id (or whoever is on burn-in)
 *
 * Optional env:
 *   BURNIN_POLL_INTERVAL_S         — default 60
 *   BURNIN_MIN_ROLLOVERS           — default 2 (HUME_TTS_PLAN §8 step 6
 *                                    requires ≥2 Gemini-cap rollovers under
 *                                    Hume during burn-in)
 *   BURNIN_WINDOW_HOURS            — default 48
 *   BURNIN_EXIT_ON_RED             — '1' = exit immediately on red flag
 *   BURNIN_ONCE                    — '1' = run one poll then exit (CI mode)
 */

import { createClient } from '@supabase/supabase-js';
import { isRedEndReason } from '../server/voice-proxy/fatal-end-reasons.js';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: env ${name} missing`);
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const CREATOR_ID  = requireEnv('HUME_BURNIN_CREATOR_ID');
// Audit S21 (unit-wide) — validate numeric env parses; reject NaN/garbage
// rather than silently treating BURNIN_MIN_ROLLOVERS='abc' as never-
// satisfied.
function parsePositiveInt(name, raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    console.error(`FATAL: env ${name}='${raw}' is not a non-negative integer`);
    process.exit(1);
  }
  return n;
}
const POLL_S        = parsePositiveInt('BURNIN_POLL_INTERVAL_S', process.env.BURNIN_POLL_INTERVAL_S, 60);
const MIN_ROLLOVERS = parsePositiveInt('BURNIN_MIN_ROLLOVERS',   process.env.BURNIN_MIN_ROLLOVERS,   2);
const WINDOW_HOURS  = parsePositiveInt('BURNIN_WINDOW_HOURS',    process.env.BURNIN_WINDOW_HOURS,    48);
const ONCE          = process.env.BURNIN_ONCE === '1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// Audit M1 + M6 (unit-wide) — single source of truth via
// fatal-end-reasons.js. The drift-guard test asserts every teardown() in
// index.js is either in the literal set OR matches a registered prefix.
// isRedEndReason handles both cases.
// (Variable kept for back-compat with the older code path; new lookups
// go through isRedEndReason directly.)

function nowIso() { return new Date().toISOString(); }

// Audit M5 — startup sanity check. Refuse to start if the monitored
// creator is not currently configured for Hume. Otherwise the monitor
// reports "clean window" while no Hume sessions are being tested.
async function assertCreatorOnHume() {
  const { data, error } = await supabase
    .from('creators')
    .select('id, handle, tts_provider, hume_voice_id, hume_voice_id_preview, hume_voice_id_dev')
    .eq('id', CREATOR_ID)
    .maybeSingle();
  if (error) {
    console.error(`[burnin] creator lookup failed: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.error(`[burnin] creator ${CREATOR_ID} not found`);
    process.exit(1);
  }
  if (data.tts_provider !== 'hume') {
    console.error(`[burnin] creator.tts_provider='${data.tts_provider ?? 'NULL'}' — expected 'hume'`);
    console.error(`[burnin] run cut-over step 2 (set creators.tts_provider='hume' via admin UI) first.`);
    process.exit(1);
  }
  const hasAnyHumeId = !!(data.hume_voice_id || data.hume_voice_id_preview || data.hume_voice_id_dev);
  if (!hasAnyHumeId) {
    console.error(`[burnin] creator has tts_provider='hume' but NO hume_voice_id set in any env`);
    process.exit(1);
  }
  console.log(`[burnin] startup OK — creator=${data.handle || CREATOR_ID.slice(0, 8)} tts_provider=hume`);
}

async function checkRedFlags(windowStart) {
  const flags = [];

  // 1. Sessions with red end_reason.
  {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, ended_at, end_reason, tts_provider_at_session, started_at')
      .eq('creator_id', CREATOR_ID)
      .gte('started_at', windowStart)
      .not('end_reason', 'is', null);
    if (error) {
      flags.push({ kind: 'query_error', op: 'sessions_red_end_reason', detail: error.message });
    } else if (Array.isArray(data)) {
      for (const s of data) {
        if (isRedEndReason(s.end_reason)) {
          flags.push({
            kind: 'session_fatal',
            session_id: s.id,
            end_reason: s.end_reason,
            tts_provider: s.tts_provider_at_session,
            ended_at: s.ended_at,
          });
        }
      }
    }
  }

  // 2. cogs_log rows with tts_cap_exceeded=true.
  //
  // Audit M4 — the proxy writes `tts_cap_exceeded: true` (JS boolean) per
  // proxy-handlers.js. Postgres stores it as JSONB `true`. .contains uses
  // @> which is type-strict — `{tts_cap_exceeded: true}` matches only
  // boolean true. If the metadata key ever drifts to `1` / `"true"`, this
  // misses it. Defense: also test the text-cast `eq.true`.
  {
    const { data, error } = await supabase
      .from('cogs_log')
      .select('session_id, created_at, metadata')
      .gte('created_at', windowStart)
      .contains('metadata', { tts_cap_exceeded: true });
    if (error) {
      flags.push({ kind: 'query_error', op: 'cogs_cap_exceeded', detail: error.message });
    } else if (Array.isArray(data) && data.length > 0) {
      for (const r of data) {
        flags.push({
          kind: 'tts_cap_exceeded',
          session_id: r.session_id,
          created_at: r.created_at,
        });
      }
    }
  }
  // Type-drift defense — flag if any row stores tts_cap_exceeded as non-bool.
  {
    const { data, error } = await supabase
      .from('cogs_log')
      .select('session_id, created_at, metadata')
      .gte('created_at', windowStart)
      .not('metadata->tts_cap_exceeded', 'is', null);
    if (!error && Array.isArray(data)) {
      for (const r of data) {
        const v = r.metadata?.['tts_cap_exceeded'];
        if (v !== true && v !== false) {
          flags.push({
            kind: 'metadata_type_drift',
            session_id: r.session_id,
            actual_type: typeof v,
            actual_value: String(v),
          });
        }
      }
    }
  }

  // 3. cogs_log Hume rows with cost_usd=0 OR cost_usd IS NULL — pricing
  // misconfig (audit C4 fix). PostgREST chains AND across separate filter
  // calls; an .or() expression is needed for the cost branch.
  //
  // Unit-wide audit M4 (2026-05-13) — scope to operation='voice_tts_characters'.
  // Leg 4 (operation='voice_tts_audio_seconds') is hardcoded cost_usd=0 by
  // design (migration 0003 line 188 — leg 4 is observability only; the
  // dollar cost lives entirely in leg 3 chars). Without this scope the
  // monitor flags every Hume turn's leg-4 row as a "pricing misconfig" →
  // guaranteed false-positive flood.
  {
    const { data, error } = await supabase
      .from('cogs_log')
      .select('id, session_id, operation, units, cost_usd, created_at, metadata')
      .gte('created_at', windowStart)
      .eq('service', 'hume')
      .eq('operation', 'voice_tts_characters')
      .gt('units', 0)
      .or('cost_usd.eq.0,cost_usd.is.null');
    if (error) {
      flags.push({ kind: 'query_error', op: 'hume_zero_cost', detail: error.message });
    } else if (Array.isArray(data) && data.length > 0) {
      for (const r of data) {
        flags.push({
          kind: 'hume_zero_cost_pricing_misconfig',
          cogs_id: r.id,
          session_id: r.session_id,
          operation: r.operation,
          units: r.units,
          cost_usd: r.cost_usd,
        });
      }
    }
  }

  return flags;
}

async function checkRolloverCount(windowStart) {
  // Sessions that rolled over (have metadata.rollover=true) AND ran on hume.
  // Counts the NEW (post-rollover) row — the OLD row is 15+ min earlier but
  // still within the burn-in window. Per-window count, not life-of-creator.
  const { data, error } = await supabase
    .from('sessions')
    .select('id, metadata, tts_provider_at_session')
    .eq('creator_id', CREATOR_ID)
    .gte('started_at', windowStart)
    .eq('tts_provider_at_session', 'hume');
  if (error) {
    return { ok: false, error: error.message, count: 0 };
  }
  const rolled = (data || []).filter((s) => {
    const m = s.metadata;
    return m && typeof m === 'object' && m.rollover === true;
  });
  return { ok: true, count: rolled.length };
}

async function poll(scriptStartIso) {
  // Audit M2 — window anchored at SCRIPT-START, not rolling. Hour-0 problems
  // stay visible at hour 48 instead of dropping out as the clock advances.
  const windowStart = scriptStartIso;
  console.log(`[burnin] ${nowIso()} polling creator=${CREATOR_ID.slice(0, 8)}… window_start=${windowStart}`);

  const flags = await checkRedFlags(windowStart);
  const rollovers = await checkRolloverCount(windowStart);

  if (flags.length > 0) {
    console.error(`[burnin] ${nowIso()} 🔴 ${flags.length} RED FLAG(S):`);
    for (const f of flags) {
      console.error(JSON.stringify(f));
    }
    return { ok: false, flags };
  }

  if (rollovers.ok) {
    const have = rollovers.count;
    const need = MIN_ROLLOVERS;
    const tag = have >= need ? '✅' : `⏳ (need ≥${need})`;
    console.log(`[burnin] ${nowIso()} rollovers=${have}/${need} ${tag}`);
  } else {
    console.warn(`[burnin] rollover check failed: ${rollovers.error}`);
  }

  console.log(`[burnin] ${nowIso()} 🟢 clean window — no red flags`);
  return { ok: true, rollovers: rollovers.count };
}

async function main() {
  console.log(`[burnin] HUME_TTS_PLAN §8 burn-in monitor`);
  console.log(`[burnin] creator=${CREATOR_ID} poll=${POLL_S}s window=${WINDOW_HOURS}h min_rollovers=${MIN_ROLLOVERS}${ONCE ? ' once=true' : ''}`);

  await assertCreatorOnHume();

  // Audit M2 + S7 (unit-wide) — anchor at script-start; subsequent polls
  // keep the same window-start so hour-0 problems stay visible at hour 48
  // instead of dropping out as the clock advances. WINDOW_HOURS is a
  // SAFETY FLOOR — if the operator started the monitor mid-burn-in, this
  // backdates the anchor by up to WINDOW_HOURS to catch sessions that
  // started before the script launched.
  const scriptStartMs = Date.now();
  const windowFloorMs = scriptStartMs - WINDOW_HOURS * 3600 * 1000;
  const scriptStartIso = new Date(windowFloorMs).toISOString();
  console.log(`[burnin] window anchored at: ${scriptStartIso} (script-start − ${WINDOW_HOURS}h floor)`);

  if (ONCE) {
    const result = await poll(scriptStartIso);
    process.exit(result.ok ? 0 : 1);
  }

  console.log(`[burnin] Ctrl-C to exit. BURNIN_EXIT_ON_RED=1 to fail-fast on first red flag.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await poll(scriptStartIso);
      if (!result.ok && process.env.BURNIN_EXIT_ON_RED === '1') {
        console.error(`[burnin] BURNIN_EXIT_ON_RED=1 — exiting with code 1 on red flag`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`[burnin] poll threw:`, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_S * 1000));
  }
}

main().catch((err) => {
  console.error('[burnin] fatal:', err);
  process.exit(1);
});
