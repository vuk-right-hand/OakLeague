// Voice proxy — Spike A Phase 2.
//
// Flow:
//   1. Client POST /api/voice/spike-a/ticket (Next.js RSC route, admin-gated)
//   2. Client opens WS to this proxy at /voice/spike-a?ticket=<uuid>&model=<id>
//   3. Proxy atomically consumes voice_tickets row (UA-hash bound)
//   4. Proxy INSERTs sessions row (unique partial index → 1-active-per-user)
//   5. Proxy opens GeminiBridge, forwards binary PCM frames + control JSON
//   6. On WS close: session UPDATE ended_at + reason + cogs_insert_turn RPC
//
// WS close codes (plan §Architecture):
//   4001 invalid_ticket          — consume returned no row
//   4002 session_already_active  — unique_violation on sessions insert
//   4003 kill_switch_fired       — latch raised by sessions_enforce trigger
//   4004 bad_request             — missing ticket/model or bad model id
//   4005 upstream_error          — Gemini or Cartesia bridge open failed
//   4006 quota_state_inconsistent — P0002 from voice_check_quota (turn_start) or
//                                    voice_accumulate_seconds (turn_end) — missing
//                                    daily_quotas row OR R4-C2 22003 oob
//   4009 cartesia_no_voice       — useTtsLayer=true but creators.voice_id IS NULL
//   4010 model_not_compatible    — useTtsLayer=true with a non-allowlisted model
//                                    (R4-M6: only 3.1 Live verified for transcription)
//   4011 tts_reconnecting        — turn_start during Cartesia reconnect window (R4-M2)
//   4012 backpressure            — user WS bufferedAmount > 2 MB (R3-C2)
//   1008 quota_exceeded          — kill-switch or degraded-and-unknown at turn_start
//   1011 internal_error          — unhandled
//   1000 normal_closure          — client initiated

// Sentry must init before any other import can throw to be useful; side-effect only.
import './sentry.js';
import { captureException, captureMessage } from './sentry.js';

import http from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { GeminiBridge } from './gemini-bridge.js';
import { CartesiaTTSBridge } from './cartesia-bridge.js';
import { HumeTTSBridge } from './hume-bridge.js';
import { FishTTSBridge, sanitizeForTts } from './fish-bridge.js';
import { decideQuotaGate } from './quota-gate.js';
import { makeLogTurnCogs, installReaper, VOICE_TTS_LAYER_ENABLED, getCartesiaPricing, getHumePricing, _humePricingPrimeForBoot, getFishPricing, _fishPricingPrimeForBoot } from './proxy-handlers.js';
// DECOUPLED_BRAIN_PLAN P1-5 C3 ordering gate — boot-prime decoupled
// brain/paraphrase pricing FATAL-at-boot (same posture as Cartesia/Hume).
import { provisionDecoupledBrainPricing } from './decoupled-boot.js';
import { makeDecoupledOrchestrator } from './decoupled-orchestrator.js';
import { generateParaphrase } from './paraphrase.js';
import { generateDeepAnswer } from './brain-bridge.js';
import { makeVoiceDeleteWorker } from './voice-delete-worker.js';
import { makeSimliFaceDeleteWorker } from './simli-face-delete-worker.js';
import { makeFaceUploadReaper } from './face-upload-reaper.js';
import { makeEmbedWorker, makeCorpusReprocessWorker } from './embed-worker.js';
// pgvector RAG — vector-mode retrieval (audit C1 fix). Mirrors of the TS libs
// in src/lib/voice/. The TS originals stay for vitest + future Next-side
// consumers; these JS files are the proxy's runtime source of truth (proxy is
// pure ESM Node — cannot import .ts files at runtime).
import { retrieveTopK } from './retrieve-knowledge.js';
import { buildInjectionEnvelope } from './build-injection-envelope.js';
// Day-13 — v2 retrieval HTTP shim client. Calls Next.js
// /api/internal/retrieve-knowledge instead of running the orchestrator
// in-proc (handoff §2a Option A). Fire-once, no retry (audit M3).
import {
  callRetrieveKnowledgeV2,
  RetrieveV2ClientError,
} from './retrieve-knowledge-v2-client.js';
// Day-13 — proxy-side voice_session_state writer for the durable-fallback
// path (audit C5). Closure const is the source of truth for next-turn
// rewrite; this UPSERT survives WS replacement on Gemini Live 15-min reopen.
import {
  persistLastAssistantResponse,
  VOICE_SESSION_STATE_MAX_CHARS,
  MIN_PERSIST_CHARS,
} from './voice-session-state-writer.js';
// RAG v3 step 6c — single dispatch chokepoint. resolveRetrievalPath()
// maps v=1/2/3 → 'v1'/'v2'/'v3' tokens and THROWS on unknown so a missed
// site in a future refactor fails LOUD at session-open instead of silently
// degrading to v1 (the bug class plan §5 / round-3 C-3 / round-4 C5 fixes).
// assertRetrievalPathSupportedOnSpike is the spike-a admin probe.
import {
  resolveRetrievalPath,
  assertRetrievalPathSupportedOnSpike,
  UnknownRetrievalVersionError,
} from './retrieval-path.js';
// Day-13 — fire-and-forget PostHog batch emitter for v2 telemetry
// (audit M2). Pre-mapped events arrive from the shim response.
import {
  captureBatch as posthogCaptureBatch,
  drainInFlight as posthogDrainInFlight,
} from './posthog-client.js';

const PORT = Number(process.env.PORT || 8080);
const BUILD = process.env.FLY_MACHINE_ID || 'local';

const SUPABASE_URL          = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY  = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_API_KEY        = requireEnv('GEMINI_API_KEY');
// CARTESIA_API_KEY is required only when VOICE_TTS_LAYER_ENABLED=1.
const CARTESIA_API_KEY      = process.env.CARTESIA_API_KEY || '';
// SIMLI_API_KEY drives the simli-face-delete-worker (R3-Missing-3).
// Optional — worker no-ops if absent. Set in Fly secrets when /s/[id]
// cutover ships.
const SIMLI_API_KEY         = process.env.SIMLI_API_KEY || '';

// Day-5 RAG SOTA — corpus reprocess worker POSTs to three Next 15 internal
// routes (/api/internal/preprocess, /narrative-chunk, /contextual-gen).
// Bearer auth via INTERNAL_API_SECRET. Base URL is the Vercel deployment.
// Both optional at boot — reprocess worker no-ops if either is missing
// (legacy embed-worker keeps running for v1 creators).
const INTERNAL_API_BASE_URL = process.env.INTERNAL_API_BASE_URL || '';
const INTERNAL_API_SECRET   = process.env.INTERNAL_API_SECRET || '';
// HUME_TTS_PLAN §6.8 / unit-wide-audit C4 fix — dual-provider pricing.
// VOICE_TTS_PROVIDER tells us which provider the env defaults to, but a
// per-creator override on `creators.tts_provider` can route a session to
// the OTHER provider mid-fleet. We probe the DB at boot for any creator
// whose override differs from VOICE_TTS_PROVIDER; if any exist, validate
// BOTH provider pricings so the bridge never sees a missing rate at
// session-open. Fails closed at boot — never at first turn.
const HUME_API_KEY = process.env.HUME_API_KEY || '';
// FISH_AUDIO_PHASE_1 §7 — Fish API key. Optional at boot when neither the
// env default nor any creator override targets Fish (provisionPricing()
// below probes; fail-closed when needed).
const FISH_API_KEY = process.env.FISH_API_KEY || '';
const FISH_TTS_MODEL = process.env.FISH_TTS_MODEL || 's2-pro';
// Audit C2 (unit-wide) — single source of truth for Hume pricing lives in
// proxy-handlers.js. The boot path here PRIMES that singleton; subsequent
// callers (bridge construction in this file, logTurnCogs in proxy-handlers)
// read the same cached value. Eliminates the "two caches diverge" hazard.
async function provisionPricing() {
  // DECOUPLED_BRAIN_PLAN P1-5 C3 ordering gate — runs FIRST, BEFORE the
  // !VOICE_TTS_LAYER_ENABLED early-return. Audit C2: a decoupled creator
  // with α' off is itself FATAL (the deep-answer must reach the cloned
  // voice), so this gate must NOT be reachable-skippable by the two
  // flags disagreeing. Mirrors the Hume per-creator-override probe.
  // Inert today by construction (M3 / P1-2 safety refinement: no creator
  // can be flagged decoupled until the D12 persona compiler +
  // admin_set_creator_decoupled RPC exist) → probe returns zero rows →
  // no-op. The gate is IN PLACE the moment a creator is flagged.
  // No `fatal` override → the default (console.error + process.exit(1))
  // IS reachable here in real boot, intentionally, exactly like Hume's
  // FATAL at ~L153. The return value is intentionally unused: on
  // misconfig `fatal` has already process.exit'd; otherwise there is
  // nothing to do (primed/deferred/inert are log-only states).
  await provisionDecoupledBrainPricing({
    ttsLayerEnabled: VOICE_TTS_LAYER_ENABLED,
    probeAnyDecoupledCreator: async () => {
      const { data, error } = await supabase
        .from('creators')
        .select('id')
        .eq('decoupled', true)
        .limit(1);
      if (error) return { error: error.message };
      return { found: Array.isArray(data) && data.length > 0 };
    },
  });

  if (!VOICE_TTS_LAYER_ENABLED) return; // α' off: TTS layer inert; skip both.
  // CARTESIA always validated (it's the historical default; envs that flip
  // VOICE_TTS_PROVIDER=hume still leave back-compat creators on cartesia
  // unless they explicitly override).
  if (!CARTESIA_API_KEY) {
    console.error('FATAL: CARTESIA_API_KEY missing while VOICE_TTS_LAYER_ENABLED=1');
    process.exit(1);
  }
  getCartesiaPricing();

  // If env default is Hume, Hume pricing is required at boot.
  // If env default is Cartesia, probe for any hume override; if found,
  // Hume pricing is required too (C4 fix).
  //
  // Audit C4: on probe FAILURE (Supabase transient outage at Fly boot),
  // do NOT force-exit on missing Hume env. A cartesia-only fleet whose
  // operator has never set HUME_USD_PER_CHAR shouldn't crash-loop because
  // of a 30-second Supabase blip. Log loud, assume Hume not needed, and
  // let `getHumePricing()` lazy-validate at first session-open if a
  // creator override turns out to be real.
  let needHume = VOICE_TTS_PROVIDER === 'hume';
  let probeFailed = false;
  if (!needHume) {
    try {
      const { data, error } = await supabase
        .from('creators')
        .select('id')
        .eq('tts_provider', 'hume')
        .limit(1);
      if (error) {
        console.warn(`[boot] creator-override probe failed: ${error.message} — skipping Hume pre-validation; lazy-validate at session-open if needed`);
        probeFailed = true;
      } else if (Array.isArray(data) && data.length > 0) {
        needHume = true;
      }
    } catch (e) {
      console.warn(`[boot] creator-override probe threw: ${e?.message || e} — skipping Hume pre-validation; lazy-validate at session-open if needed`);
      probeFailed = true;
    }
  }
  if (needHume) {
    if (!HUME_API_KEY) {
      console.error('FATAL: HUME_API_KEY missing — required when VOICE_TTS_PROVIDER=hume OR any creator has tts_provider=hume override');
      process.exit(1);
    }
    // Audit C2 — prime the SHARED singleton in proxy-handlers.js. After
    // this call, both bridge construction here AND logTurnCogs over there
    // read the same cached pricing object.
    _humePricingPrimeForBoot();
  } else if (probeFailed) {
    // Best-effort: if env defaults to cartesia AND probe failed, leave
    // the singleton uninitialized. getHumePricing() will lazy-validate
    // at the first Hume bridge construction — hard-exit then if Hume
    // is genuinely required. This converts a boot crash-loop into an
    // honest "first Hume session fails" — a much narrower blast radius.
    console.warn('[boot] Hume pricing deferred to lazy validation due to probe failure');
  }

  // FISH_AUDIO_PHASE_1 §5/§7 — same probe pattern for fish. Conditional
  // priming on: (a) env default = fish, OR (b) any creator override =
  // fish. `mustValidate=true` makes _fishPricingPrimeForBoot hard-exit;
  // `mustValidate=false` warn-defers (in-process recovery via the singleton
  // recovers on first getFishPricing() call at session-open).
  let needFish = VOICE_TTS_PROVIDER === 'fish';
  let fishProbeFailed = false;
  if (!needFish) {
    try {
      const { data, error } = await supabase
        .from('creators')
        .select('id')
        .eq('tts_provider', 'fish')
        .limit(1);
      if (error) {
        console.warn(`[boot] fish creator-override probe failed: ${error.message} — skipping Fish pre-validation; lazy-validate at session-open if needed`);
        fishProbeFailed = true;
      } else if (Array.isArray(data) && data.length > 0) {
        needFish = true;
      }
    } catch (e) {
      console.warn(`[boot] fish creator-override probe threw: ${e?.message || e} — skipping Fish pre-validation; lazy-validate at session-open if needed`);
      fishProbeFailed = true;
    }
  }
  if (needFish) {
    if (!FISH_API_KEY) {
      console.error('FATAL: FISH_API_KEY missing — required when VOICE_TTS_PROVIDER=fish OR any creator has tts_provider=fish override');
      process.exit(1);
    }
    _fishPricingPrimeForBoot({ mustValidate: true });
    // FISH_AUDIO_PHASE_1 dispatchFish audit M7 — surface that Phase 0.5
    // #8 (manual DELETE-idempotency verification) is still unstamped.
    // Worker treats 200/204/404 as success on assumption; if Fish ever
    // ships 410 for "already deleted" we'd start treating success as
    // failure. Until the stamp lands, log loud at every fleet boot so the
    // status is visible. Hard-exit-gated in prod via FISH_PHASE_0_5_8_STAMPED.
    if (process.env.FISH_PHASE_0_5_8_STAMPED !== '1') {
      const msg = '[boot] WARN: FISH_PHASE_0_5_8_STAMPED!=1 — Fish DELETE idempotency (200/204/404 success contract) is ASSUMED, not stamped. See docs/_planning/FISH_AUDIO_PHASE_1.md §3 claim 8. Required for prod cutover.';
      if (process.env.VERCEL_ENV === 'production' && process.env.FISH_PHASE_0_5_8_PROD_OVERRIDE !== '1') {
        console.error(`FATAL: ${msg}`);
        process.exit(1);
      }
      console.warn(msg);
    }
  } else if (fishProbeFailed) {
    // Asymmetry vs Hume (intentional, audit M6): Hume's warn-defer path only
    // console.warn's and leaves _humePricing=null — getHumePricing() at first
    // construction lazy-validates. Fish's warn-defer calls
    // _fishPricingPrimeForBoot({mustValidate:false}) explicitly, which sets
    // _fishProbeFailed=true on the singleton. getFishPricing() reads that flag
    // and retries assertion on the NEXT call (in-process recovery, audit
    // round-1 C4 + round-2 Small on the bridge audit) — so a transient env-
    // probe blip at boot doesn't permanently lock out Fish sessions even if
    // the env var IS set. Hume lacks this recovery upgrade.
    console.warn('[boot] Fish pricing deferred to lazy validation due to probe failure');
    _fishPricingPrimeForBoot({ mustValidate: false });
  }
}

// R4-M6 — Cartesia is only safe with models we've Phase-0-verified for
// outputAudioTranscription. Explicit allowlist; no startsWith fuzz.
const CARTESIA_COMPATIBLE_MODELS = new Set([
  'gemini-3.1-flash-live-preview',
]);

// R3-C2 / S-M7 / R2-M3 user-WS backpressure cap.
// Tightened from 2 MB → 1.4 MB to keep the seconds-of-audio invariant
// honest across BOTH sample rates (R3-M1 introduced per-session 16k):
//   * 24 kHz s16le: 1.4 MB ≈ 30s buffer (was ~42s)
//   * 16 kHz s16le: 1.4 MB ≈ 44s buffer
// At 16k, a 2 MB cap masked slow-client problems for ~64s — too long.
// Per-VM aggregate stays 32 MB; aggregate-breach closes oldest offender.
const USER_WS_BACKPRESSURE_MAX_BYTES = Math.floor(1.4 * 1024 * 1024);
const USER_WS_BACKPRESSURE_WARN_BYTES = Math.floor(0.7 * 1024 * 1024);
const USER_WS_AGGREGATE_MAX_BYTES = 32 * 1024 * 1024;

// sessionId → { ws, openedAt }. Used to compute aggregate bufferedAmount
// and to pick the oldest offender on aggregate breach.
const wsRegistry = new Map();

const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-3.1-flash-live-preview',
]);

// HUME_TTS_PLAN §6.1 — env-level TTS provider default.
// `creators.tts_provider` (per-creator override) wins at session-open. When
// NULL, /api/sessions/open inherits this env value. Validated at boot so a
// typo doesn't silently route every session to the wrong bridge. Older code
// reads VOICE_TTS_LAYER_ENABLED for the "α' on/off" bit; the two flags are
// orthogonal — α' is the TTS layer, VOICE_TTS_PROVIDER is which TTS.
// FISH_AUDIO_PHASE_1 §6 — env-level TTS provider widened to include 'fish'.
// Same semantics as cartesia/hume: `creators.tts_provider` per-creator
// override wins at session-open; this is the default for creators with NULL
// override.
const VOICE_TTS_PROVIDER_VALID = new Set(['cartesia', 'hume', 'fish']);
const VOICE_TTS_PROVIDER = (process.env.VOICE_TTS_PROVIDER || 'cartesia').toLowerCase();
if (!VOICE_TTS_PROVIDER_VALID.has(VOICE_TTS_PROVIDER)) {
  console.error(`FATAL: VOICE_TTS_PROVIDER=${process.env.VOICE_TTS_PROVIDER} invalid (must be 'cartesia', 'hume' or 'fish')`);
  process.exit(1);
}
// Audit C5 (unit-wide, 2026-05-13) — non-cartesia provider env implies the
// α' TTS layer must be on (VOICE_TTS_LAYER_ENABLED=1). Without that combo,
// `useTts` stays false at runtime, the bridge never instantiates, and
// Gemini's stock voice leaks to users — violates CLAUDE.md hard rule
// "Gemini's stock voice is never user-facing, on any tier."
if ((VOICE_TTS_PROVIDER === 'hume' || VOICE_TTS_PROVIDER === 'fish') && !VOICE_TTS_LAYER_ENABLED) {
  console.error(`FATAL: VOICE_TTS_PROVIDER=${VOICE_TTS_PROVIDER} requires VOICE_TTS_LAYER_ENABLED=1 (α' TTS layer must be on)`);
  process.exit(1);
}

// Wire-string → sessions.model_used enum. 2.5 preview strings all map to the
// GA enum value; the exact wire id lives in cogs_log.metadata.model.
const MODEL_TO_ENUM = {
  'gemini-3.1-flash-live-preview':                  'gemini_3_1_flash_live_preview',
  'gemini-2.5-flash-native-audio-preview-12-2025':  'gemini_live_2_5_flash_native_audio',
};

// Pricing constants moved to proxy-handlers.js (PRICING_QUOTED_AT etc.) —
// see SPIKE_A_DEFERRED_FIXUP_PLAN.md §1A.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: env ${name} missing`);
    process.exit(1);
  }
  return v;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// HUME_TTS_PLAN §6.8 — boot-time pricing provisioning. Async because the
// dual-provider probe queries `creators.tts_provider`. Top-level await
// guarantees the function completes BEFORE server.listen() is called, so
// the first session-open never races a missing pricing constant.
await provisionPricing();

// Day-13 audit-build C4 — fail-loud at boot if v2 wiring is misconfigured.
// `callRetrieveKnowledgeV2`'s lazy `getConfig()` would otherwise let the
// proxy start cleanly, then silently degrade every v2 turn to persona-only
// when the first call fires. Hard-exit here keeps the dogfood path honest.
// Skip when v2 is intentionally not wired (default for prod until Day-15).
// DECOUPLED_BRAIN_PLAN P1-6 (audit M6). The orchestrator abandons the
// retrieval wait at this ceiling (persona-only degrade so the deep
// answer starts immediately — no dead air after the hedge).
//
// 2026-05-21 (audit C1) — TWO distinct timers, NOT one. They were both 2500
// and that was the bug: the v2 shim's internal deadline and the orchestrator's
// patience expired at the SAME instant, so a ~2.5s retrieve (measured live:
// 2462–2502ms — right on the cliff) was a coin-flip between grounded and a
// silent persona-only miss that ALSO billed a full pipeline for nothing.
// Once the deep answer moved onto the critical path (the early-trigger fix),
// this cliff went live. Split + raised:
//   • BUDGET (3000) — what the v2 pipeline races against internally
//     (rewrite+embed+topk+rerank). Bills are capped at this.
//   • CEILING (3500) — how long the orchestrator WAITS for retrieval before
//     persona-only. MUST be > BUDGET + HTTP/network overhead so the budget's
//     result is actually consumable (the old "lock to same value" reasoning
//     was wrong — it guaranteed the result was discarded). Constraint that
//     still holds: BUDGET ≤ CEILING, so the shim never bills past the point
//     the orchestrator gave up.
// P0 measured retrieve p95 ≈ 2022ms (common case clears with wide margin); the
// budget/ceiling below are sized for the slow-but-VALID worst case, not the p95.
// 2026-05-23 (Vuk): headroom raised 3000→3500 budget / 3500→4000 ceiling so a
// slow-but-VALID rewrite (cap raised to 2200 in query-rewrite.ts) plus
// embed(~350)+topk(~160)+rerank(~600) ≈ 3310ms still lands INSIDE the budget
// instead of timing out → persona-only "I don't know". TRADEOFF: paraphrase is
// OFF, so the ceiling is pure dead-air before the deep answer's first word;
// 4000 = up to 4s silence + first-token. The proper cover for a longer wait is
// enabling the paraphrase bridge (PARAPHRASE_ENABLED=1). Both env-overridable so
// we can re-tune after the live test WITHOUT a redeploy. Invariant BUDGET ≤
// CEILING is enforced below (the shim self-cancels at BUDGET, the orchestrator
// waits to CEILING, so we never bill past the orchestrator's patience).
const _envPosInt = (name, dflt) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`FATAL: ${name} must be a positive finite number; got '${raw}'`);
    process.exit(1);
  }
  return Math.floor(n);
};
const DECOUPLED_RETRIEVE_BUDGET_MS = _envPosInt('DECOUPLED_RETRIEVE_BUDGET_MS', 3500);
const DECOUPLED_RETRIEVE_CEILING_MS = _envPosInt('DECOUPLED_RETRIEVE_CEILING_MS', 4000);
// 2026-05-25 (fix #1) — how many reranked parent units to INJECT into the brain.
// Was effectively 5 (the shim's DEFAULT_TOP_K, since the proxy passed no topK):
// the brain got the #1 story PLUS 4 lower-ranked distractors, blended them into
// generic advice, and disowned the specific story ("not my story"). The
// reranker is decisive (lumberjack 0.7656 vs next 0.3281) — injecting ONLY the
// top unit gives the brain ONE thing to tell in-voice. Default 1; bump via env
// if testing shows multi-part questions need more context (audit M2 — validated
// for single-story Qs; multi-part/comparative Qs may want 2-3, see deploy notes;
// and audit M3 — bumping it in prod requires a corpus_version bump or
// RAG_CACHE_DISABLED window, since the cache key does NOT include topK). NOTE
// (audit S4): a value ≤0 / non-numeric is boot-FATAL via _envPosInt (process
// exits), NOT floored to 1; only the upper bound is clamped to 5.
const DECOUPLED_INJECT_TOP_K = Math.min(5, _envPosInt('DECOUPLED_INJECT_TOP_K', 1));
// The real invariant is CEILING ≥ BUDGET + the shim client's HTTP_OVERHEAD_GRACE_MS
// (500, in retrieve-knowledge-v2-client.js): the shim self-cancels at BUDGET, its
// AbortController backstops at BUDGET+500, and the orchestrator must still be
// waiting then so a typed/late response is CONSUMED, not discarded at the cliff
// (and so we never bill a retrieve whose result we threw away). A bare BUDGET ≤
// CEILING guard (audit M3) would wrongly accept e.g. 3900/4000. Keep this 500 in
// sync with HTTP_OVERHEAD_GRACE_MS if that constant ever changes.
const RETRIEVE_CLIENT_GRACE_MS = 500;
if (DECOUPLED_RETRIEVE_CEILING_MS < DECOUPLED_RETRIEVE_BUDGET_MS + RETRIEVE_CLIENT_GRACE_MS) {
  console.error(
    `FATAL: DECOUPLED_RETRIEVE_CEILING_MS (${DECOUPLED_RETRIEVE_CEILING_MS}) must be ≥ ` +
    `DECOUPLED_RETRIEVE_BUDGET_MS (${DECOUPLED_RETRIEVE_BUDGET_MS}) + ${RETRIEVE_CLIENT_GRACE_MS} ` +
    `(shim client grace). Either LOWER the budget or RAISE the ceiling — the orchestrator ` +
    `must outwait the shim's self-cancel+grace or it discards a result it already paid for.`,
  );
  process.exit(1);
}
const RAG_V2_PROXY_ENABLED = process.env.RAG_V2_PROXY_ENABLED === '1';
if (RAG_V2_PROXY_ENABLED) {
  if (!process.env.RAG_V2_SHIM_URL) {
    console.error('FATAL: RAG_V2_PROXY_ENABLED=1 but RAG_V2_SHIM_URL not set');
    process.exit(1);
  }
  if (!process.env.INTERNAL_API_SECRET || process.env.INTERNAL_API_SECRET.length < 32) {
    console.error('FATAL: RAG_V2_PROXY_ENABLED=1 but INTERNAL_API_SECRET missing or < 32 chars');
    process.exit(1);
  }
  try {
    new URL(process.env.RAG_V2_SHIM_URL);
  } catch {
    console.error(`FATAL: RAG_V2_SHIM_URL is not a valid URL: ${process.env.RAG_V2_SHIM_URL}`);
    process.exit(1);
  }
  console.log(`[boot] RAG v2 wiring enabled — shim=${process.env.RAG_V2_SHIM_URL}`);
} else {
  console.log('[boot] RAG v2 wiring disabled (set RAG_V2_PROXY_ENABLED=1 to enable)');
}
// Boot-visible decoupled depth + injection config. Fly masks secret VALUES in
// `fly secrets list` (name + digest only), so this is the only way to confirm
// from prod that BRAIN_DEPTH_MODE actually resolved to 'variable' (anything else
// = 'brief'). Also surfaces the inject-top-K so a stray override is visible.
console.log(
  `[boot] decoupled depth=${process.env.BRAIN_DEPTH_MODE === 'variable' ? 'variable' : 'brief (default — set BRAIN_DEPTH_MODE=variable for full answers)'} `
  + `inject_top_k=${DECOUPLED_INJECT_TOP_K}`,
);

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }

// ── HTTP ─────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, build: BUILD, ts: Date.now() }));
    return;
  }
  // R3-C2 (sec) — single source of truth for the α' rollout flag.
  // Vercel polls this endpoint (60s in-process cache) instead of
  // reading its own env, so flipping VOICE_TTS_LAYER_ENABLED on Fly
  // alone propagates to the pre-WS gate at /api/sessions/open. Public
  // (no auth) but only exposes flags + version, no secrets.
  //
  // HUME_TTS_PLAN §6.2 — also exposes `ttsProvider` so the Vercel
  // sessions/open route can compute `sessionProvider = creator.tts_provider
  // ?? proxyCfg.ttsProvider` without reading its own env (single source of
  // truth). `useCartesia` stays for back-compat with older Vercel deploys
  // during the migration window; new code reads `useTtsLayer`.
  if (req.url === '/voice-config') {
    res.writeHead(200, {
      'content-type': 'application/json',
      // Cache control: short, so a Fly secret flip propagates within ~1m.
      'cache-control': 'public, max-age=30',
    });
    res.end(JSON.stringify({
      // Both keys returned during the migration window. New deploys read
      // `useTtsLayer`; older Vercel deploys still read `useCartesia`. Drop
      // the legacy field in a follow-up once Vercel is on the new name.
      useTtsLayer: VOICE_TTS_LAYER_ENABLED,
      useCartesia: VOICE_TTS_LAYER_ENABLED,
      ttsProvider: VOICE_TTS_PROVIDER,
      build: BUILD,
      ts: Date.now(),
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── Ticket consume + session insert ─────────────────────────────────────

async function consumeTicket(ticketId, uaHash) {
  // Atomic single-use consume — see plan §Ticket-based WS auth. service-role
  // bypasses RLS so the RETURNING clause reflects only the row this UPDATE
  // won (Postgres UPDATE is atomic per-row).
  //
  // SIMLI_WIREUP §2 — session_id is the cutover discriminator:
  //   * NULL → legacy admin spike-a path: proxy creates its own session row.
  //   * UUID → /s/[id] cutover path: proxy attaches to the pre-opened row.
  // expected_tier is read so we don't have to round-trip sessions for the
  // CartesiaTTSBridge per-session sample-rate decision (R3-M1).
  const { data, error } = await supabase
    .from('voice_tickets')
    .update({ consumed_at: new Date().toISOString() })
    .eq('ticket_id', ticketId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .eq('bound_ua_hash', uaHash)
    // HUME_TTS_PLAN §6.1 — extended SELECT for tts_provider + hume_* prosody
    // + voice_id_env. The proxy never re-derives provider OR env from its
    // own envvars (Vuk-M5: ticket is the contract). Hume prosody is NULL on
    // cartesia tickets and ignored by the bridge selection.
    .select('user_id, creator_id, session_id, expected_tier, purpose, avatar_provider, system_prompt, prefix_turns, tts_speed, brain_mode, decoupled, tts_provider, hume_tts_speed, hume_trailing_silence, hume_voice_description, hume_model_version, voice_id_env')
    .maybeSingle();
  if (error || !data) return null;
  // creator_id is NOT NULL by CHECK on new rows (migration 0041). A null here
  // means a pre-migration ticket leaked in — refuse rather than guess.
  if (!data.creator_id) return null;
  return {
    userId:         data.user_id,
    creatorId:      data.creator_id,
    sessionId:      data.session_id || null,
    expectedTier:   data.expected_tier || null,
    purpose:        data.purpose || 'voice_session',
    // Audit round 2 / C1 — drives Cartesia per-session sample-rate.
    // Simli/Tavus → 16kHz; HeyGen → 24kHz. NULL is permitted only on
    // voice_clone tickets (no avatar session); voice_session tickets
    // are CHECK-enforced NOT NULL at the DB layer.
    avatarProvider: data.avatar_provider || null,
    // Brain wire-up (PR-2). NULL when the route couldn't compile a
    // persona or the hook had no overlapping sample_content. Bridge
    // falls back to DEFAULT_SYSTEM in that case.
    systemPrompt:   data.system_prompt || null,
    prefixTurns:    (() => {
      if (data.prefix_turns == null) return null;
      if (Array.isArray(data.prefix_turns)) return data.prefix_turns;
      // PR-2 audit M1: future schema change wrapping the array would
      // silently coerce to null otherwise.
      console.warn(`[ws] prefix_turns shape unexpected (type=${typeof data.prefix_turns}); dropping`);
      return null;
    })(),
    // Creator voice-speed (migration 20260511000006). supabase-js
    // returns `numeric` columns as JS string; coerce at the boundary
    // (R2 audit C3). Bridge's CartesiaTTSBridge constructor also
    // defensively coerces, but doing it here keeps the shape clean for
    // any other downstream consumer.
    ttsSpeed:       (() => {
      if (data.tts_speed == null) return null;
      const n = typeof data.tts_speed === 'number' ? data.tts_speed : Number(data.tts_speed);
      return Number.isFinite(n) ? n : null;
    })(),
    // pgvector RAG plan — brain_mode snapshot from voice_tickets (M6).
    // 'drawer' = legacy topic-tag overlap; 'vector' = per-turn pgvector
    // retrieval injected mid-session via the audio gate below.
    brainMode:      (data.brain_mode === 'vector' ? 'vector' : 'drawer'),
    // DECOUPLED_BRAIN_PLAN P1-2 — D7 fail-safe: STRICT === true. Any
    // other value (false/null/undefined/'true'/1/garbage) → false →
    // legacy path. This is THE security boundary for "absent/unparseable
    // → legacy"; never loosen to truthy. DB CHECK guarantees a true
    // snapshot implies brain_mode='vector'.
    decoupled:      (data.decoupled === true),
    // HUME_TTS_PLAN §6.1 + FISH_AUDIO_PHASE_1 §6 — provider snapshot.
    // NOT NULL by DB constraint (migration 0002), but a stray null on a
    // pre-migration ticket would be a tts_provider mismatch trap below —
    // coerce to a guard string. Allowlist set inline so a future enum
    // widen requires this site to be updated explicitly (CLAUDE.md
    // schema-blast-radius rule).
    ttsProvider:    (data.tts_provider === 'hume' ? 'hume'
                     : data.tts_provider === 'fish' ? 'fish'
                     : 'cartesia'),
    // Hume prosody dials (migration 0005). NULL on cartesia tickets — bridge
    // selection branches on ttsProvider, so these are only read on the Hume
    // path. Numeric coercion mirrors ttsSpeed above.
    humeTtsSpeed: (() => {
      if (data.hume_tts_speed == null) return null;
      const n = typeof data.hume_tts_speed === 'number' ? data.hume_tts_speed : Number(data.hume_tts_speed);
      return Number.isFinite(n) ? n : null;
    })(),
    humeTrailingSilence: (() => {
      if (data.hume_trailing_silence == null) return null;
      const n = typeof data.hume_trailing_silence === 'number' ? data.hume_trailing_silence : Number(data.hume_trailing_silence);
      return Number.isFinite(n) ? n : null;
    })(),
    humeVoiceDescription: data.hume_voice_description || null,
    humeModelVersion:     data.hume_model_version || null,
    // HUME_TTS_PLAN §6 audit M1 — env-scoped voice column selector pinned
    // on the ticket. Pre-migration tickets carry NULL → default to
    // 'production' (the historical default).
    voiceIdEnv: (
      data.voice_id_env === 'preview' || data.voice_id_env === 'development'
        ? data.voice_id_env
        : 'production'
    ),
  };
}

// SIMLI_WIREUP §2 — attach to a pre-opened session row (cutover path).
// Verifies the session is still active + owned by the ticket's user; flips
// status='active' + bumps last_heartbeat_at. Replaces openSession() for
// /s/[id] tickets.
async function attachToSession({ sessionId, userId, creatorId, expectedTier }) {
  // Defense-in-depth: filter by creator_id too. The
  // voice_tickets_session_user_match trigger guarantees user_id alignment,
  // but does NOT cross-check creator_id between ticket and session row.
  // A craftily-minted ticket pointing at a stranger's open session would
  // fail user_id match — so this is belt-and-suspenders.
  //
  // Auditor C4 — additionally verify tier_at_session matches the ticket's
  // expected_tier. CLAUDE.md mandates tier never changes mid-session,
  // so a mismatch indicates either a bug or a tampered ticket; refuse.
  let q = supabase
    .from('sessions')
    .update({ status: 'active', last_heartbeat_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('creator_id', creatorId)
    .is('ended_at', null);
  if (expectedTier) q = q.eq('tier_at_session', expectedTier);
  // Read the public-safe columns. Privileged HeyGen tokens live on
  // sessions_private (RLS service-role-only) — separate query below.
  // Day-13: corpus_version_at_session + retrieval_version_at_session
  // become closure consts for the WS lifetime. Snapshot-at-session-open
  // contract; never re-read live (CLAUDE.md tier-routing-at-session-open).
  const { data, error } = await q
    .select(
      'id, tier_at_session, avatar_provider, corpus_version_at_session, retrieval_version_at_session',
    )
    .maybeSingle();
  if (error) {
    console.error('[session-attach]', error);
    captureException(error, { op: 'session-attach', userId, sessionId });
    return { err: 'upstream_error' };
  }
  if (!data) return { err: 'session_not_attachable' };

  // Heygen-only: fetch privileged tokens from the sibling table.
  // Final-audit C1 fix — column-level RLS isn't a thing in Postgres, so
  // these tokens live on a service-role-only sibling table.
  let heygenSessionId = null;
  let heygenSessionToken = null;
  if (data.avatar_provider === 'heygen') {
    const { data: priv, error: privErr } = await supabase
      .from('sessions_private')
      .select('heygen_session_id, heygen_session_token')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (privErr) {
      console.error('[session-attach private]', privErr);
      captureException(privErr, { op: 'session-attach-private', sessionId });
    } else if (priv) {
      heygenSessionId = priv.heygen_session_id ?? null;
      heygenSessionToken = priv.heygen_session_token ?? null;
    }
  }

  // RAG v3 step 6c round-5 M3: pass retrieval_version_at_session through
  // the strict chokepoint at LOAD time, not just at dispatch. The previous
  // `Number(data.retrieval_version_at_session ?? 1)` silently coerced NULL
  // -> 1, which would route a v=3 creator to v1 zero-retrieval if a buggy
  // session-open RPC ever wrote a NULL snapshot. Fail loud here so the
  // session never opens with a corrupt snapshot.
  const rawRv = data.retrieval_version_at_session;
  let retrievalVersionAtSession;
  try {
    resolveRetrievalPath(rawRv); // validates strictly; we keep the integer below
    retrievalVersionAtSession = rawRv;
  } catch (e) {
    if (e instanceof UnknownRetrievalVersionError) {
      throw new Error(
        `session_state_corrupt: sessions.retrieval_version_at_session=${String(rawRv)} `
        + `is not in {1,2,3} for session=${sessionId.slice(0, 8)} -- refusing to open. `
        + 'Investigate the session_open RPC + creators.retrieval_version snapshot path.',
      );
    }
    throw e;
  }
  return {
    sessionId: data.id,
    tier: data.tier_at_session,
    avatarProvider: data.avatar_provider ?? null,
    // Day-13 snapshot consts. corpus_version_at_session NOT NULL DEFAULT 1
    // by schema -- coerce defensively. retrieval_version_at_session is now
    // validated above (round-5 M3) -- forward the raw integer through.
    corpusVersionAtSession: Number(data.corpus_version_at_session ?? 1),
    retrievalVersionAtSession,
    heygenSessionId,
    heygenSessionToken,
  };
}

async function openSession({ userId, creatorId, modelWire, ttsProvider }) {
  const modelEnum = MODEL_TO_ENUM[modelWire];
  // FISH_AUDIO_PHASE_1 wiring audit C4 + TS-widening audit M5 — spike-a
  // admin path is admin-dev only; the spike-a/ticket route hardcodes
  // tts_provider='cartesia'. Refuse ANY non-cartesia ticket reaching
  // this legacy path so a copy-paste / fixture leak fails loud rather
  // than silently opening on the wrong provider. Real provider routing
  // happens through /api/sessions/open.
  if (ttsProvider !== 'cartesia') {
    return { err: `spike_a_${ttsProvider}_unsupported` };
  }
  // Day-13 audit-build M4 — admin spike-a path hard-pins
  // retrieval_version_at_session=1, but the creator may already be at
  // v2 (Day-15+). v1 retrieveTopK queries chunker_version=1 chunks
  // which may not exist for v2-reprocessed creators → admin sees
  // silent zero retrieval. Probe so the surface is visible (admin-only path;
  // one extra read is cheap). As of 2026-06-02 the probe REFUSES v2/v3 (a
  // creator is now live on v3 and would blank every turn on this path).
  let spikeRetrievalSupported = true; // default supported so a read hiccup never locks admin out
  try {
    const { data: cd } = await supabase
      .from('creators')
      .select('retrieval_version')
      .eq('id', creatorId)
      .maybeSingle();
    if (cd) {
      // RAG v3 step 6c: spike-a probe centralized in the helper. Returns a
      // support verdict — v1 (or unknown) = ok; v2/v3 = refuse (hard-pinned
      // v1 retrieval can't serve them). Admin uses real /api/sessions/open.
      spikeRetrievalSupported = assertRetrievalPathSupportedOnSpike(Number(cd.retrieval_version));
    }
  } catch (e) {
    // Non-fatal — admin-only path, never block on probe READ failure (verdict
    // stays `true` so a transient creators-read hiccup doesn't lock admin out).
    // M3: surface to Sentry too — on a v3 creator a swallowed probe-read failure
    // means admin may be in a silently-blanking spike-a session (verdict default
    // true), and the console.warn alone isn't visible to them.
    console.warn(`[session-open spike-a] retrieval_version probe failed: ${e?.message || e}`);
    captureException(e, { op: 'spike_a_retrieval_version_probe', creatorId });
  }
  if (!spikeRetrievalSupported) {
    return { err: 'spike_a_retrieval_version_unsupported' };
  }
  // Audit C3 (unit-wide) + FISH_AUDIO_PHASE_1 §6 — write
  // tts_provider_at_session snapshot on the legacy spike-a admin path too.
  // Without this, sessions opened by the proxy (no /api/sessions/open
  // call) had NULL snapshot, which silently bypassed
  // cogs_insert_turn_voice_v3's provider cross-check (was v2 → v3 in
  // FISH §4 M3; v3 raises on NULL snapshot now).
  const ttsProviderAtSession = ttsProvider === 'hume' ? 'hume'
                             : ttsProvider === 'fish' ? 'fish'
                             : 'cartesia';
  // Day-13: admin spike-a path doesn't read creators.retrieval_version
  // because it doesn't run through session_open RPC's FOR SHARE snapshot.
  // Admin is the only caller of this path; admin will never dogfood v2 via
  // spike-a (they go through real session-open via /api/sessions/open).
  // Explicit DEFAULT 1 is safer than relying on the column default —
  // future renames of the column would still produce the right value
  // here.
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      creator_id: creatorId,
      model_used: modelEnum,
      tier_at_session: 'free', // overwritten by sessions_enforce_tier_and_kill_switch trigger
      status: 'starting',
      tts_provider_at_session: ttsProviderAtSession,
      corpus_version_at_session: 1,
      retrieval_version_at_session: 1,
    })
    .select('id, tier_at_session')
    .single();

  if (error) {
    if (error.code === '23505') return { err: 'session_already_active' };
    if (error.code === 'P0001' || /kill_switch/.test(error.message || '')) return { err: 'kill_switch_fired' };
    console.error('[session-insert]', error);
    captureException(error, { op: 'session-insert', userId, modelWire });
    return { err: 'upstream_error' };
  }
  // Day-13: spike-a path explicitly hard-pins both snapshot values to 1.
  // Mirrors attachToSession's return shape so the caller can use the same
  // closure consts irrespective of which path opened the session.
  return {
    sessionId: data.id,
    tier: data.tier_at_session,
    corpusVersionAtSession: 1,
    retrievalVersionAtSession: 1,
  };
}

async function endSession(sessionId, reason) {
  if (!sessionId) return;
  // B5 audit fix: previously swallowed errors silently — if the UPDATE failed
  // (RLS reject, row gone, network blip) the session sat ended_at=NULL for up
  // to 90s (next reaper tick) and the user's reconnect hit 4002 session_
  // already_active. Capture to Sentry + use .select() so 0-rows-affected
  // surfaces instead of returning success.
  try {
    const { data, error } = await supabase.from('sessions')
      .update({ ended_at: new Date().toISOString(), status: 'ended', end_reason: reason.slice(0, 200) })
      .eq('id', sessionId)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[endSession]', error);
      captureException(error, { level: 'error', op: 'endSession', sessionId, reason: reason.slice(0, 80) });
      return;
    }
    if (!data) {
      const err = new Error(`endSession affected 0 rows for session ${sessionId}`);
      console.error('[endSession]', err.message);
      captureException(err, { level: 'warning', op: 'endSession', sessionId });
    }
  } catch (e) {
    console.error('[endSession] exception', e);
    captureException(e, { level: 'error', op: 'endSession', sessionId });
  }
}

// logTurnCogs moved to proxy-handlers.js (factory makeLogTurnCogs) — see plan
// §1A.0. Wiring: factory instantiated below after closeWs / sessionToWs are
// defined, so the consecutive-failure callback can close the right WS.

// Quota enforcement — plan §Kill-switch. Returns { ok, reason } where ok=false
// means the proxy must close the WS with 1008 quota_exceeded. Called at
// turn_start.
//
// Fail-closed with per-session cache (Round-2 audit C4). Prior behavior failed
// open on RPC error, which let a kill-switched user burn indefinitely during
// any Supabase brownout. Now:
//   • Successful check → cache the snapshot and return the result.
//   • Failed check + prior cached state → trust the cache (fail-closed if
//     already fired or ≥150%).
//   • Failed check + no prior cache → allow ONE cold-start grace turn per
//     session, then deny until the RPC recovers.

// sessionId → { healthy: { fired, over150 } | null, graceUsed: bool }
//   healthy: last successful RPC snapshot (null until first success).
//   graceUsed: true after we've consumed the cold-start free turn.
const quotaCache = new Map();

async function checkQuotaOk(sessionId) {
  let rpc;
  try {
    const { data, error } = await supabase.rpc('voice_check_quota', { p_session_id: sessionId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('voice_check_quota returned no row');
    rpc = { row, error: null };
  } catch (e) {
    const code = e?.code || '';
    // B1: P0002 from voice_check_quota = daily_quotas row missing = quota-state
    // inconsistency. Same fatal semantics as turn_end path: close 4006, page Sentry.
    if (code === 'P0002') {
      console.error('[voice_check_quota] FATAL P0002', e);
      captureException(e, {
        level: 'fatal',
        op: 'voice_check_quota',
        sessionId,
        quotaStateInconsistent: true,
      });
      rpc = { row: null, error: e, fatal: true };
    } else {
      console.error('[voice_check_quota]', e?.message || e);
      captureException(e, { op: 'voice_check_quota', sessionId });
      rpc = { row: null, error: e };
    }
  }
  const { gate, nextCache } = decideQuotaGate({ rpc, priorCache: quotaCache.get(sessionId) });
  quotaCache.set(sessionId, nextCache);
  return gate;
}

// Phase C B4.5: System B (voice_usage_daily/weekly) counter writer.
// Parallel to accumulateSeconds (which writes System A's daily_quotas).
// Different currency by design: System A sums mic + assistant talk
// (broad usage); System B is just assistant talk seconds — Cartesia
// audio when available, Gemini outputSeconds fallback. Migration
// 20260428000002 §"WHY seconds as the currency" treats Cartesia
// voice_tts_audio_seconds as the authoritative cap meter.
//
// Idempotent at the RPC level (PK on user_id, session_id, turn_number);
// a retry from a transient Postgres error is a no-op. Non-fatal: if the
// counter row fails the user gets an under-count for the turn, but
// System A's 150% latch is the backstop.
async function recordVoiceUsage({ userId, sessionId, turnNumber, seconds, turnStartedAt }) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  if (!turnNumber || turnNumber <= 0) return;
  const { error } = await supabase.rpc('voice_usage_record', {
    p_user_id: userId,
    p_session_id: sessionId,
    p_turn_number: turnNumber,
    p_seconds: Number(seconds.toFixed(4)),
    p_turn_started_at: turnStartedAt ? new Date(turnStartedAt).toISOString() : null,
  });
  if (error) throw error;
}

// Returns { ok, fatal, reason }. fatal=true → caller must teardown WS with
// a distinct code (quota-state inconsistency). Round-2 audit C5: previously
// swallowed ALL errors, including P0002 "no daily_quotas row" which grants
// the user free turns until the row is recreated. Now the RPC's documented
// fatal path is surfaced loudly.
async function accumulateSeconds(sessionId, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: true };
  try {
    const { error } = await supabase.rpc('voice_accumulate_seconds', {
      p_session_id: sessionId,
      p_seconds: Number(seconds.toFixed(4)),
    });
    if (!error) return { ok: true };
    const code = error.code || '';
    if (code === 'P0002') {
      // Documented quota-state-inconsistency path. Sentry level=fatal so alerting
      // pages (extras alone never trigger rules — K1 audit fix).
      console.error('[voice_accumulate_seconds] FATAL P0002', error);
      captureException(error, {
        level: 'fatal',
        op: 'voice_accumulate_seconds',
        sessionId,
        quotaStateInconsistent: true,
      });
      return { ok: false, fatal: true, reason: 'quota_state_inconsistent' };
    }
    if (code === '22003') {
      // R4-C2: per-turn second sum exceeded the 3600s RPC oob ceiling.
      // Under the 4000-char R3-C4 transcript cap this should be unreachable
      // (worst-case ~600s). Hitting it means either the cap was bumped
      // without re-deriving the second-equivalent ceiling, or a Gemini
      // turn ran > 30 minutes — both are alarms. Promote to fatal so the
      // WS closes 4006 instead of silently desync'ing seconds_used.
      console.error('[voice_accumulate_seconds] FATAL 22003 (oob)', error);
      captureException(error, {
        level: 'fatal',
        op: 'voice_accumulate_seconds',
        sessionId,
        quotaOob: true,
      });
      return { ok: false, fatal: true, reason: 'quota_oob' };
    }
    console.error('[voice_accumulate_seconds]', error);
    captureException(error, { op: 'voice_accumulate_seconds', sessionId, code });
    return { ok: false, fatal: false, reason: 'quota_accumulate_failed' };
  } catch (e) {
    console.error('[voice_accumulate_seconds] exception', e);
    captureException(e, { op: 'voice_accumulate_seconds', sessionId });
    return { ok: false, fatal: false, reason: 'quota_accumulate_failed' };
  }
}

// runReaper moved to proxy-handlers.js (makeRunReaper / installReaper) — see
// plan §1A.0. Wiring is in the server.listen callback below.

// ── WS server ────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/voice/spike-a' });

function closeWs(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}

// sessionId → ws. Maintained on connection-open, removed on teardown. Used by
// the cogs-failure callback to close the right WS after 3 consecutive failures
// (plan §1A.2). See SPIKE_A_DEFERRED_FIXUP_PLAN.md §1A.0 C-C fix.
const sessionToWs = new Map();

const { logTurnCogs, logBrainLeg, dropSession: dropCogsSession } = makeLogTurnCogs({
  supabase,
  env: 'spike_a',
  onConsecutiveFailure: (sessionId) => {
    const ws = sessionToWs.get(sessionId);
    if (ws) closeWs(ws, 1011, 'cogs_rpc_failed');
  },
});

wss.on('connection', async (ws, req) => {
  ws.binaryType = 'nodebuffer';
  const url = new URL(req.url || '/', 'http://localhost');
  const ticket = url.searchParams.get('ticket') || '';
  const modelWire = url.searchParams.get('model') || '';
  const ua = req.headers['user-agent'] || '';
  const uaHash = sha256Hex(ua);
  const connId = Math.random().toString(36).slice(2, 8);
  console.log(`[ws ${connId}] open ticket=${ticket.slice(0,8)} model=${modelWire}`);

  if (!ticket || !ALLOWED_MODELS.has(modelWire)) {
    console.log(`[ws ${connId}] bad_request`);
    return closeWs(ws, 4004, 'bad_request');
  }

  const consumed = await consumeTicket(ticket, uaHash);
  if (!consumed) { console.log(`[ws ${connId}] invalid_ticket`); return closeWs(ws, 4001, 'invalid_ticket'); }
  const { userId, creatorId, sessionId: ticketSessionId } = consumed;
  // SIMLI_WIREUP §2 — attach path is the /s/[id] cutover; legacy openSession
  // is the admin spike-a path.
  const isAttachPath = !!ticketSessionId;
  console.log(`[ws ${connId}] ticket ok user=${userId.slice(0,8)} creator=${creatorId.slice(0,8)} attach=${isAttachPath}`);

  let sess;
  if (isAttachPath) {
    sess = await attachToSession({
      sessionId: ticketSessionId,
      userId,
      creatorId,
      expectedTier: consumed.expectedTier,
    });
  } else {
    // Audit C3 (unit-wide) — pass ttsProvider so the spike-a admin path's
    // sessions insert writes tts_provider_at_session.
    sess = await openSession({ userId, creatorId, modelWire, ttsProvider: consumed.ttsProvider });
  }
  if (sess.err) { console.log(`[ws ${connId}] session err=${sess.err}`); }
  if (sess.err === 'session_already_active') return closeWs(ws, 4002, 'session_already_active');
  if (sess.err === 'kill_switch_fired')      return closeWs(ws, 4003, 'kill_switch_fired');
  if (sess.err === 'session_not_attachable') return closeWs(ws, 4001, 'session_not_attachable');
  if (sess.err === 'upstream_error')         return closeWs(ws, 4005, 'upstream_error');
  // Default-catch (2026-06-02): ANY openSession err MUST close cleanly here.
  // Without this, an unmapped err (e.g. spike_a_retrieval_version_unsupported)
  // falls through to `sess.sessionId.slice()` below with an undefined id →
  // TypeError in the connection handler (which has no try/catch) → abrupt
  // socket drop / unhandled rejection. The reason string carries the err code
  // to the client. Add a specific `closeWs` mapping ABOVE only when a code
  // needs its own distinct WS close code; otherwise this catch handles it.
  if (sess.err) return closeWs(ws, 4005, sess.err);
  const sessionId = sess.sessionId;
  console.log(`[ws ${connId}] session ok id=${sessionId.slice(0,8)}`);

  // R4-C1 — single-WS-per-session enforcement. If a takeover (R3-C2)
  // re-mints a ticket against an existing active session and BOTH tabs
  // open WSs, mic frames would be duplicated → double Gemini billing,
  // undefined turn state. Evict the older WS first; new attach wins.
  //
  // Auditor C3 fix — `ws.close()` is async on the wire but the OLD WS
  // would keep firing 'message' events until the close handshake
  // propagates (tens of ms on desktop, seconds on iOS Safari TLS-close).
  // During that window the OLD bridge accepts mic frames + pays Gemini
  // tokens. Synchronously removing all message listeners stops mic-frame
  // processing immediately; the close handler still fires for teardown().
  const existing = wsRegistry.get(sessionId);
  if (existing && existing.ws !== ws) {
    console.warn(`[ws ${connId}] evicting prior WS for session=${sessionId.slice(0,8)}`);
    try {
      existing.ws.send(JSON.stringify({ type: 'error', code: 'session_evicted', at: Date.now() }));
    } catch {}
    // Synchronous: stop mic frames + control messages from reaching the
    // old bridge BEFORE the async close completes.
    try { existing.ws.removeAllListeners('message'); } catch {}
    try { existing.ws.close(4002, 'session_already_active'); } catch {}
    // Audit row in cogs_log so ops can see how often this fires.
    try {
      await supabase.from('cogs_log').insert({
        user_id: userId,
        session_id: sessionId,
        service: 'gemini',
        operation: 'voice_ws_evicted',
        units: 1,
        unit_label: 'event',
        cost_usd: 0,
        environment: 'production',
        metadata: { reason: 'r4_c1_dual_ws_attach', conn_id: connId },
      });
    } catch (e) { captureException(e, { op: 'voice_ws_evicted_audit', sessionId }); }
  }
  sessionToWs.set(sessionId, ws);
  wsRegistry.set(sessionId, { ws, openedAt: Date.now() });

  let bridge = null;
  // HUME_TTS_PLAN §6.4 — single bridge variable for either provider. Both
  // CartesiaTTSBridge and HumeTTSBridge expose the same interface (open /
  // turnStart / sendText / turnEnd / cancel / close / on / getMetrics).
  let ttsBridge = null;
  // FISH_AUDIO_PHASE_1 §6 round-3 C4 — auto-fallback state. `ttsBridgeProvider`
  // mirrors the LIVE bridge's provider (mutated on sidecar swap); `ttsProvider`
  // stays the session SNAPSHOT (immutable across the session) so cogs/Sentry
  // can still report "session was billed as fish but fell back". Audit C2 fix.
  let ttsBridgeProvider = null;
  // Capability for Fish→Cartesia auto-fallback. Resolved at session-open from
  // the same `creators` row read used to look up the active voice id. Null →
  // fallback handler closes 1011 fish_fallback_required_no_sidecar.
  let cartesiaSidecarVoiceId = null;
  let fallbackUsed = false;            // per-session latch, set SYNCHRONOUSLY before await (audit C3)
  let cancelDuringFallback = false;    // user barge-in during sidecar.open() (audit M3)
  let currentTurnTextBuffer = '';      // per-turn text accumulator for replay
  // Unsubscribe handle for the current ttsBridge listener — captured at
  // registration so the fallback handler can detach the dead-bridge listener
  // synchronously before constructing the sidecar (audit C4).
  let offTtsBridge = null;
  // Session-level mirror of the bridge's sample-rate so the auto-fallback
  // handler can construct the Cartesia sidecar with the right rate. The
  // existing `ttsSampleRate` declaration inside the bridge-construct try{}
  // is block-scoped and not in scope at the handler.
  let ttsBridgeSampleRate = null;
  // Per-turn fallback markers — set in the fallback_required handler; read
  // by logTurnCogs at turn_end so the marker lands on the exact turn that
  // fell back (audit M1). Subsequent turns on the same session are billed
  // as normal cartesia (the swap is session-permanent but the FALLBACK
  // EVENT was per-turn).
  let fallbackInvokedTurn = null;
  let fallbackInvokedReason = null;
  let closed = false;
  let lastHeartbeatAt = Date.now();
  let heartbeatInterval = null;
  let turnNumber = 0;
  let ttsTurnDead = false; // R3-M1 / R4-S1 — relay-loop gate for barge-in (provider-neutral)
  // 2026-05-27 (audit C3) — consecutive decoupled turn_complete_timeout recoveries.
  // ONE timeout is a recoverable Gemini hiccup (answer already played). But if
  // Gemini Live wedges into "accepts input, never emits turn_complete", every
  // turn would silently recover with a per-turn timeout latency tax and an
  // unbounded session. After MAX consecutive timeouts we stop pretending it's
  // healthy and close LOUD so the client does a clean reconnect (fresh Gemini
  // session). Reset to 0 on any real turn_complete (bridge event + the turnEnd
  // resolve path).
  let consecutiveTurnCompleteTimeouts = 0;
  const MAX_CONSECUTIVE_TURN_COMPLETE_TIMEOUTS = 2;
  // Audit M1 — decoupled bridge.turnEnd wait for Gemini's turn_complete. The
  // turn finalizes on the off-Live deep answer (awaitTurnSpoken), so this only
  // bounds RECOVERY latency on a Gemini hiccup. 15s = generous over the ~2s
  // normal (maxOutputTokens-capped) AND conservative against a long user
  // utterance's STT-finalize tail (avoids false-positive recovery), while well
  // under the legacy 30s so the C3 streak-guard stays responsive.
  const DECOUPLED_TURN_END_TIMEOUT_MS = 15_000;

  // ── pgvector RAG plan — vector-mode state ──────────────────────────────
  //
  // Closure-captured `creatorId` + `userId` from the consumed voice_ticket
  // (R3 M4 fix — application-layer trust chain). NEVER re-read from any
  // per-message field. `brainMode` selects which retrieval path runs.
  const brainMode = consumed.brainMode;          // 'drawer' | 'vector'
  // DECOUPLED_BRAIN_PLAN P1-2 — bound ONCE from the consumed snapshot
  // (R3-M4 trust chain), never re-read per-message. true ⇒ off-Live
  // paraphrase→RAG→TTS path; the 1548/1572/981 decoupled branches
  // (P1-5) gate on this. Byte-identical legacy when false.
  const decoupled = consumed.decoupled === true; // strict; D7 fail-safe
  const ticketCreatorId = consumed.creatorId;    // used for creator_knowledge_topk
  const ticketUserId = consumed.userId;          // used for voice_retrieval_budget
  // Day-13 — snapshot consts from sessions (attachToSession / openSession).
  // retrievalVersionAtSession routes per-turn retrieval: 1 → legacy
  // retrieveTopK (in-proc), 2 → HTTP shim to /api/internal/retrieve-knowledge
  // (orchestrator runs on Vercel). corpusVersionAtSession rides every v2
  // call as the cache key — never live-read mid-session (CLAUDE.md
  // tier-routing-at-session-open contract).
  const retrievalVersionAtSession = Number(sess.retrievalVersionAtSession ?? 1);
  const corpusVersionAtSession = Number(sess.corpusVersionAtSession ?? 1);
  // Day-13 audit C5 — last assistant response lives in-memory as the
  // source-of-truth for the NEXT turn's rewrite call. The DB UPSERT to
  // voice_session_state is durable-fallback only (survives WS replacement
  // on Gemini Live 15-min reopen). Initialized null = first-turn /
  // post-resumption signal to the rewriter.
  let lastAssistantResponseClosure = null;
  //
  // Audio gate (R2 C1 / R3 M1). Between bridge `turn_complete` and resolution
  // of pendingInjection, we hold inbound audio frames in `audioHold` so the
  // injection text lands BEFORE the next user-turn audio reaches Gemini.
  // 200ms ring buffer (cap = 200ms × 16kHz × 2 bytes = 6400 bytes; we use
  // a generous 32KB cap to also tolerate 24kHz). Overflow flushes the gate
  // without injection (telemetry event); we always prefer answering over
  // freezing the user mid-speech.
  let forwardAudio = true;
  let audioHold = [];
  let audioHoldBytes = 0;
  const AUDIO_HOLD_MAX_BYTES = 32 * 1024;
  let pendingInjection = null; // { promise, turnNumber, skip }
  let retrievalSkippedTruncationCount = 0;
  let retrievalSkippedShortUtteranceCount = 0; // audit M3
  let retrievalEmptyCount = 0;
  let retrievalTimeoutCount = 0;
  let injectionLandedCount = 0;
  let injectionOverflowCount = 0;

  // Audit M3: short-utterance skip. "yeah" / "ok" / "mm-hm" don't need a
  // pgvector query — they're conversational fillers between substantive
  // turns. 20 chars OR 1.5s is the lower bound for "could plausibly be a
  // substantive question." Tightens daily budget headroom 3-5×.
  const SHORT_UTTERANCE_MIN_CHARS   = 20;
  const SHORT_UTTERANCE_MIN_SECONDS = 1.5;
  function shortUtterance(text, audioSeconds) {
    if (typeof text !== 'string') return true;
    if (text.length < SHORT_UTTERANCE_MIN_CHARS) return true;
    if (Number.isFinite(audioSeconds) && audioSeconds < SHORT_UTTERANCE_MIN_SECONDS) return true;
    return false;
  }

  // R3 M1 truncation heuristic: ~150 wpm × 6 chars/word ÷ 60s = 15 chars/sec.
  // Trigger when transcript.length < 0.6 × expectedChars AND audioSeconds > 12.
  // Below 12s a fast speaker can legitimately ratio under 0.6 without truncation.
  function truncationSuspected(text, audioSeconds) {
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 12) return false;
    const expected = audioSeconds * 15;
    return text.length < 0.6 * expected;
  }
  // Phase C B4.5: wall-clock turn-start anchor for voice_usage_record's
  // day-bucketing. A turn that begins at 23:58 → 00:05 books to the day
  // it began (matches user intuition; admin "usage per day" reports use
  // the same anchor). Reset at every turn_start.
  let turnStartedAt = null;

  // Post-build audit C3 — HeyGen LiveAvatar Lite heartbeat.
  // Server drops the WS at ~120s of voice silence (Phase 0 §9). The
  // bridge can't fire keep-alive (browser doesn't have the privileged
  // session JWT). Voice-proxy holds the snapshot from sessions row +
  // hits /v1/sessions/keep-alive every 30s while the session is live.
  // Sub-90s margin = comfortable; anything over 120s = silent drop.
  let heygenHeartbeatInterval = null;
  const heygenSessionId = consumed.sessionId && sess.heygenSessionId ? sess.heygenSessionId : null;
  const heygenSessionToken = consumed.sessionId && sess.heygenSessionToken ? sess.heygenSessionToken : null;
  const isHeygenSession = sess.avatarProvider === 'heygen' && !!heygenSessionToken && !!heygenSessionId;
  if (isHeygenSession) {
    const HEYGEN_HEARTBEAT_MS = Number(process.env.LIVEAVATAR_HEARTBEAT_MS ?? 30000);
    heygenHeartbeatInterval = setInterval(async () => {
      if (closed) return;
      try {
        const r = await fetch('https://api.liveavatar.com/v1/sessions/keep-alive', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${heygenSessionToken}`,
          },
          body: JSON.stringify({ session_id: heygenSessionId }),
        });
        if (!r.ok) {
          // 401/403 → session token expired or invalidated; nothing to
          // do but let the bridge surface the WS drop. 5xx → transient,
          // log and let the next tick retry.
          console.warn(`[ws ${connId}] heygen-keepalive ${r.status} session=${heygenSessionId.slice(0, 8)}`);
        }
      } catch (e) {
        captureException(e, { op: 'heygen_keepalive', connId, sessionId, heygen_session_id: heygenSessionId });
      }
    }, HEYGEN_HEARTBEAT_MS);
    console.log(`[ws ${connId}] heygen heartbeat started every=${HEYGEN_HEARTBEAT_MS}ms heygen_session=${heygenSessionId.slice(0, 8)}`);
  }

  // R3-A8 / R4-S8 — snapshot the α' rollback flag ONCE per session. No
  // mid-session re-read.
  // `useTtsLayer` reflects "α' is on" (separate TTS bridge active, regardless
  // of which provider). The actual provider (cartesia vs hume) lives on the
  // ticket; we never re-derive from env. (Renamed 2026-05-14 from
  // `useCartesia` — the old name was misleading once Hume joined the layer.)
  const useTtsLayer = VOICE_TTS_LAYER_ENABLED;
  const ttsProvider = consumed.ttsProvider; // 'cartesia' | 'hume' | 'fish', from ticket
  // Audit C5 (unit-wide) + FISH_AUDIO_PHASE_1 wiring audit C1 — `useTts`
  // activates the bridge. With α' off entirely, a ticket that requests Hume
  // or Fish would skip bridge instantiation and leak Gemini stock audio.
  // Activate the bridge when α' is on OR the ticket explicitly asks for a
  // non-cartesia provider (per-creator override). The boot-time assertion
  // above guards the env=hume|fish case; this guards the per-creator
  // override case.
  const useTts = useTtsLayer || ttsProvider === 'hume' || ttsProvider === 'fish';

  const teardown = async (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatInterval);
    if (heygenHeartbeatInterval) clearInterval(heygenHeartbeatInterval);
    quotaCache.delete(sessionId);
    sessionToWs.delete(sessionId);
    wsRegistry.delete(sessionId);
    dropCogsSession(sessionId);
    // Brain wire-up (PR-2 / R3 audit M5). Surface always-replay token
    // cost. Logged structured + Sentry breadcrumb so reseed frequency
    // is operator-visible. PostHog `brain_prefix_reseeded` (Vercel-side
    // captureServerSafe) is not wired from the proxy — the structured
    // log line and Sentry are sufficient for v1; pipe to PostHog later
    // if reseed×byteSize becomes a material cost.
    if (bridge) {
      try {
        const m = bridge.getSeedMetrics();
        if (m.replayCount > 0) {
          console.log(`[ws ${connId}] brain.prefix_reseeded count=${m.replayCount} bytes=${m.lastByteSize} reason=${reason} session=${sessionId.slice(0,8)}`);
          captureMessage('brain.prefix_reseeded', 'info', {
            connId, sessionId, replayCount: m.replayCount, lastByteSize: m.lastByteSize, reason,
          });
        }
      } catch (metricsErr) {
        captureException(metricsErr, { op: 'brain_seed_metrics', connId, sessionId });
      }
    }
    // pgvector RAG (vector mode) — per-session retrieval metrics. Logged
    // alongside the brain-prefix metrics so operators can grep one stream
    // for session-end signals. Skips emit entirely on drawer mode (no
    // retrieval ran).
    if (brainMode === 'vector' && !decoupled) {
      console.log(
        `[ws ${connId}] vector.metrics injected=${injectionLandedCount} ` +
        `skipped_short=${retrievalSkippedShortUtteranceCount} ` +
        `skipped_truncation=${retrievalSkippedTruncationCount} ` +
        `empty=${retrievalEmptyCount} ` +
        `timeout=${retrievalTimeoutCount} ` +
        `overflow=${injectionOverflowCount} ` +
        `session=${sessionId.slice(0, 8)}`,
      );
    }
    // DECOUPLED_BRAIN_PLAN P1-5.2 (§13 981) — decoupled emits its OWN
    // metrics line (the vector counters are all-zero on this path; a
    // misleading vector.metrics line is suppressed above via !decoupled).
    if (decoupled && decoupledOrch) {
      const m = decoupledOrch.metricsSnapshot();
      if (m) {
        // Whole-build audit C1 — field names MUST match metricsSnapshot()
        // (`lastTurnNumber` / `lastParaFirstMs` / `lastDeepFirstMs`); the
        // pre-fix readers `m.turnNumber` / `m.paraphrase?.firstChunkMs` /
        // `m.deep?.firstChunkMs` resolved to `undefined` on every session,
        // turning the (A)-gate first-audio metric — the whole reason for
        // the decoupled re-arch — into a blind log line.
        console.log(
          `[ws ${connId}] decoupled.metrics turns=${m.turns} ` +
          `last_turn=${m.lastTurnNumber ?? 'na'} ` +
          `barged=${m.barged} ` +
          // P1-10 audit M2 — spurious-barge + trivial-Q observability
          `interrupted_suppressed=${m.interruptedSuppressed ?? 0} ` +
          `trivial_turns=${m.trivialTurns ?? 0} ` +
          // C-5 audit C1 — truncated-transcript turns (persona-only, retrieval
          // skipped). Surfaced here so the skip is OBSERVABLE/tunable in prod,
          // not buried in the degraded string. A rising rate = Gemini STT
          // dropping long utterances.
          `truncated_turns=${m.truncatedTurns ?? 0} ` +
          // B1 — deep answers guillotined at MAX_TOKENS (mid-thought cut). Should
          // be ~0 now the token cap sits above the graceful 4000-char ceiling.
          `deep_truncated=${m.deepTruncated ?? 0} ` +
          `max_deep_chars=${m.maxDeepChars ?? 'na'} ` +
          `degraded=${(m.degraded || []).join(',') || 'none'} ` +
          `para_first_ms=${m.lastParaFirstMs ?? 'na'} ` +
          `deep_first_ms=${m.lastDeepFirstMs ?? 'na'} ` +
          `session=${sessionId.slice(0, 8)}`,
        );
      }
    }
    // R4-M1 — null-check INSTANCES, not booleans. Either bridge may be
    // null if the open path bailed early.
    try { if (ttsBridge) await ttsBridge.close(); } catch {}
    try { if (bridge)    await bridge.close();    } catch {}
    // Post-build audit C3 — close the HeyGen session server-side. The
    // bridge close()s the WebSocket but doesn't call /v1/sessions/stop
    // (it has no JWT). Idempotent per Phase 0 §11.
    if (isHeygenSession) {
      try {
        await fetch('https://api.liveavatar.com/v1/sessions/stop', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${heygenSessionToken}`,
          },
          body: JSON.stringify({ session_id: heygenSessionId, reason: 'USER_CLOSED' }),
        });
      } catch (e) {
        captureException(e, { op: 'heygen_session_stop', connId, sessionId });
      }
    }
    await endSession(sessionId, reason);
  };

  // R4-M6 + FISH_AUDIO_PHASE_1 wiring audit M1 — model gate before any
  // bridge instantiation. Gated on `useTts` (not `useTtsLayer`) so a
  // per-creator hume/fish override session with α' off still passes
  // through here — those sessions need outputTranscription too.
  // The CARTESIA_COMPATIBLE_MODELS Set is really "Gemini models that
  // support outputTranscription"; the legacy name is kept to avoid a
  // rename ripple in this slice.
  if (useTts && !CARTESIA_COMPATIBLE_MODELS.has(modelWire)) {
    console.log(`[ws ${connId}] model_not_compatible_with_outputTranscription provider=${ttsProvider} model=${modelWire}`);
    await teardown('model_not_compatible');
    return closeWs(ws, 4010, 'model_not_compatible');
  }

  // R3-Phase3 / HUME_TTS_PLAN §6.2 — voice id lookup. Fail-closed when α'
  // is on but the creator's env-scoped voice column for the resolved
  // provider is NULL. The column picked depends on ttsProvider AND
  // voice_id_env — BOTH come from the ticket (audit M1 fix: no longer
  // reads its own VOICE_ID_ENV env var; ticket-as-contract).
  // For Hume we also surface the human-readable voice NAME — the DELETE
  // worker keys by name.
  //
  // Punch-list (audit S14, unit-wide) — this re-queries `creators` per
  // WS open. The Vuk-M5 ticket-as-contract pattern says pin everything
  // we need onto the ticket. A future PR can pin `voice_id` + `hume_voice_name`
  // onto voice_tickets and eliminate this DB read. Not urgent — the
  // query is single-row + cheap, but it's a residual per-session DB hit
  // that the architecture says shouldn't exist.
  let creatorVoiceId = null;
  let creatorHumeVoiceName = null;
  if (useTts) {
    try {
      const env = consumed.voiceIdEnv;
      let voiceCol;
      if (ttsProvider === 'hume') {
        voiceCol = env === 'production' ? 'hume_voice_id'
                 : env === 'preview'    ? 'hume_voice_id_preview'
                 :                        'hume_voice_id_dev';
      } else if (ttsProvider === 'fish') {
        // FISH_AUDIO_PHASE_1 §6 / migration 20260608100005 — env-scoped
        // fish_voice_id columns mirror the hume_voice_id_<env> pattern.
        voiceCol = env === 'production' ? 'fish_voice_id'
                 : env === 'preview'    ? 'fish_voice_id_preview'
                 :                        'fish_voice_id_dev';
      } else {
        voiceCol = env === 'production' ? 'voice_id'
                 : env === 'preview'    ? 'voice_id_preview'
                 :                        'voice_id_dev';
      }
      // Hume DELETE is keyed by NAME; cartesia + fish DELETE by ID. Only
      // Hume needs the companion name column.
      const nameCol = ttsProvider === 'hume'
        ? (env === 'production' ? 'hume_voice_name'
          : env === 'preview'    ? 'hume_voice_name_preview'
          :                        'hume_voice_name_dev')
        : null;
      // FISH_AUDIO_PHASE_1 §6 round-3 C4 — Fish sessions ALSO pull the
      // env-scoped Cartesia voice_id from the same row read so the auto-
      // fallback handler has a sidecar voice ready without a second DB hit.
      // Cartesia is the universal fallback target; creators flipped to Fish
      // are expected to KEEP their Cartesia voice populated as the safety net
      // (per FISH_AUDIO_PHASE_1.md §11 Rollback runbook).
      const cartesiaCol = ttsProvider === 'fish'
        ? (env === 'production' ? 'voice_id'
          : env === 'preview'    ? 'voice_id_preview'
          :                        'voice_id_dev')
        : null;
      const selectFields = [voiceCol];
      if (nameCol) selectFields.push(nameCol);
      if (cartesiaCol) selectFields.push(cartesiaCol);
      const selectList = selectFields.join(', ');
      const { data, error } = await supabase
        .from('creators')
        .select(selectList)
        .eq('id', creatorId)
        .maybeSingle();
      if (error) throw error;
      creatorVoiceId = data?.[voiceCol] || null;
      if (nameCol) creatorHumeVoiceName = data?.[nameCol] || null;
      if (cartesiaCol) cartesiaSidecarVoiceId = data?.[cartesiaCol] || null;
    } catch (e) {
      console.error(`[ws ${connId}] voice-id-lookup`, e);
      captureException(e, { op: 'voice-id-lookup', sessionId, creatorId, ttsProvider });
      await teardown('voice_id_lookup_failed');
      return closeWs(ws, 4005, 'upstream_error');
    }
    if (!creatorVoiceId) {
      // Audit M7 — include the column queried (env-resolved) so operators
      // bisect missing-clone vs wrong-env-column without a second query.
      console.log(`[ws ${connId}] tts_no_voice provider=${ttsProvider} env=${consumed.voiceIdEnv} creator=${creatorId.slice(0,8)}`);
      await teardown(`tts_no_voice_${ttsProvider}`);
      // HUME_TTS_PLAN §6.3 — 4009 kept for back-compat with the harness when
      // provider=cartesia; 4014 used for Hume + Fish (non-cartesia).
      if (ttsProvider === 'cartesia') {
        return closeWs(ws, 4009, 'cartesia_no_voice');
      }
      return closeWs(ws, 4014, `tts_no_voice_${ttsProvider}`);
    }
    // Whole-build audit M4: fail loud when α' is on but the ticket carries
    // no system_prompt. The cloned voice attached to a generic-mentor
    // brain is the worst-of-both fallback. Same gate for both providers.
    if (!consumed.systemPrompt) {
      console.log(`[ws ${connId}] brain_unset_with_tts provider=${ttsProvider} creator=${creatorId.slice(0,8)} ticket=${ticket.slice(0,8)}`);
      captureMessage('brain.unset_with_tts', 'warning', { connId, sessionId, creatorId, ttsProvider });
      await teardown('brain_unset_with_tts');
      // Audit M1 (unit-wide) — provider-aware close reason.
      return closeWs(ws, 4013, `brain_unset_with_${ttsProvider}`);
    }

    // FISH_AUDIO_PHASE_1 wiring audit C5 — Fish-specific pre-flight.
    // The boot-time probe can warn-defer FISH_API_KEY/pricing validation
    // when no fish creator existed at boot (lazy-prime pattern). If the
    // fleet then flips a creator to fish without redeploying, the FIRST
    // fish session-open is where the env-missing surfaces. Close with a
    // distinct 4014 + fish_unprovisioned reason so a missing-env misconfig
    // doesn't bisect as "upstream gemini failure" in dashboards.
    if (ttsProvider === 'fish') {
      if (!FISH_API_KEY) {
        console.error(`[ws ${connId}] fish_unprovisioned no-api-key sess=${sessionId.slice(0,8)} creator=${creatorId.slice(0,8)}`);
        captureMessage('fish_unprovisioned.api_key', 'error', { connId, sessionId, creatorId });
        await teardown('fish_unprovisioned_api_key');
        return closeWs(ws, 4014, 'fish_unprovisioned_api_key');
      }
      try { getFishPricing(); }
      catch (e) {
        console.error(`[ws ${connId}] fish_unprovisioned pricing-validation FAIL:`, e?.message || e);
        captureException(e, { op: 'fish_pricing_unprovisioned', sessionId, creatorId });
        await teardown('fish_unprovisioned_pricing');
        return closeWs(ws, 4014, 'fish_unprovisioned_pricing');
      }
    }
  }

  // R3-C3 / R4-S8 — SERIAL open: Gemini first (it doesn't accept user
  // audio until 'ready' is sent), then Cartesia. If Cartesia rejects we
  // close Gemini before user-WS close to prevent token-bill leaks.
  try {
    bridge = new GeminiBridge({
      apiKey: GEMINI_API_KEY,
      // Audit C4 + FISH_AUDIO_PHASE_1 wiring audit C1 — MUST be `useTts`,
      // NOT `useTtsLayer`. `useTts = useTtsLayer || ttsProvider === 'hume'
      // || ttsProvider === 'fish'`. If a creator has a per-creator
      // `tts_provider='hume'` or `'fish'` override while the fleet env
      // layer flag is OFF (useTtsLayer=false), driving these off
      // useTtsLayer leaves Gemini in audio-out mode (NOT discarding)
      // WHILE the alternative bridge is also open → Gemini's stock
      // synthesized voice can reach the user. That violates the CLAUDE.md
      // hard rule "Gemini's stock voice is never user-facing, on any tier,
      // any failure mode." Gating on `useTts` makes the per-creator
      // override a correct α' session (transcript out, audio discarded).
      // The legacy (layer off, cartesia, no override) path keeps
      // useTts=false → audio-out preserved, no regression.
      enableOutputTranscription: useTts,
      discardAudioOut: useTts,
      // pgvector RAG plan (vector mode). When the ticket's brain_mode is
      // 'vector', enable inputAudioTranscription so we receive
      // serverContent.inputTranscription.text per user-turn to drive
      // retrieval (R3 M1). Drawer mode keeps current behavior — flagged
      // for staged rollout (BRAIN_ENABLE_INPUT_TRANSCRIPTION_DRAWER).
      enableInputTranscription:
        consumed.brainMode === 'vector'
        // DECOUPLED_BRAIN_PLAN P1-2 — decoupled needs the user transcript
        // to feed the off-Live brain. `|| false` when decoupled off ⇒
        // byte-identical legacy (§13 proof). Audit M4: use the ONCE-bound
        // `decoupled` const (L869), NOT a re-read of consumed.decoupled —
        // matches the §13 guard-site spec and removes future-drift risk
        // if the bind ever gains a staging override.
        || decoupled
        || process.env.BRAIN_ENABLE_INPUT_TRANSCRIPTION_DRAWER === '1',
      // DECOUPLED_BRAIN_PLAN P1-6 (audit C1) — D-GoAway proactive
      // resumption-handle reopen is ONLY safe on the STT-only decoupled
      // path (no persona/prefix re-seed → regression-immune). Passing the
      // once-bound `decoupled` const (L877) hard-gates it: legacy keeps
      // its audited reactive-only reopen, byte-identical pre-P1-6.
      decoupled,
    });
    console.log(`[ws ${connId}] gemini.open start (tts_layer=${useTtsLayer} useTts=${useTts} provider=${ttsProvider} brain=${consumed.brainMode} decoupled=${decoupled})`);
    const t0 = Date.now();
    // Brain wire-up (PR-2 + pgvector RAG). systemInstruction + brainPrefix
    // ride the ticket; bridge.open() seeds prefix_turns post-setupComplete
    // with turnComplete:false (R2 audit C2). Replays on every reopen via
    // _lastOpenArgs (R2 C3 / R3 M5). In vector mode, prefix_turns is null
    // by DB invariant (M6) and per-turn retrieval injects via the audio gate.
    await bridge.open({
      model: modelWire,
      sessionId,
      systemInstruction: consumed.systemPrompt || undefined,
      brainPrefix: consumed.prefixTurns || null,
    });
    console.log(`[ws ${connId}] gemini.open ok in ${Date.now() - t0}ms (sysprompt=${consumed.systemPrompt ? consumed.systemPrompt.length : 0}c prefix=${consumed.prefixTurns ? 'y' : 'n'} brain=${consumed.brainMode})`);
  } catch (e) {
    console.error(`[ws ${connId}] gemini-open FAIL:`, e?.message || e);
    captureException(e, { op: 'bridge-open', connId, modelWire, sessionId });
    await teardown('bridge_open_failed');
    return closeWs(ws, 4005, 'upstream_error');
  }

  if (useTts) {
    try {
      // Per-session sample rate driven by the ticket's avatar_provider
      // (audit-r2 C1). The TTS bridge ships output_format.sample_rate per
      // WS init; mismatched cadence to the avatar pipeline = chipmunk-pitch
      // or hard-reject at the avatar's audio_buffer_appended.
      //   simli   → 16 kHz (Trinity-1 SDK requires PCM16 LE @ 16k)
      //   tavus   → 16 kHz (echo-mode parity with Simli)
      //   heygen  → 24 kHz (LiveAvatar Lite, PHASE_0_HEYGEN.md §6)
      // Legacy admin spike-a path (no ticketSessionId, no avatar_provider
      // because the ticket was minted before this column existed OR is a
      // voice_clone) defaults to 24 kHz so existing harness fixtures stay
      // green. Hume honors the same sample-rate query param.
      let ttsSampleRate;
      if (consumed.avatarProvider === 'heygen') {
        ttsSampleRate = 24000;
      } else if (consumed.avatarProvider === 'simli' || consumed.avatarProvider === 'tavus') {
        ttsSampleRate = 16000;
      } else {
        // Fallback: legacy/admin paths.
        ttsSampleRate = isAttachPath ? 16000 : 24000;
      }
      // HUME_TTS_PLAN §6.4 — branch construction on ttsProvider. Both
      // bridges expose the same interface; downstream relay-loop code
      // talks to `ttsBridge` regardless of which class backs it.
      if (ttsProvider === 'cartesia') {
        ttsBridge = new CartesiaTTSBridge({
          apiKey: CARTESIA_API_KEY,
          voiceId: creatorVoiceId,
          sampleRate: ttsSampleRate,
          // Cartesia treats NULL/1.0 as "omit generation_config.speed" via
          // shouldSendSpeed().
          ttsSpeed: consumed.ttsSpeed,
        });
      } else if (ttsProvider === 'hume') {
        // HUME_API_KEY validated at boot (provisionPricing). Pricing object
        // sourced from the validated cache.
        ttsBridge = new HumeTTSBridge({
          apiKey: HUME_API_KEY,
          voiceId: creatorVoiceId,
          voiceName: creatorHumeVoiceName,
          // Audit S2 — pass 16000 explicitly, NOT ttsSampleRate. Hume
          // Octave 2 always emits 48k and the bridge always resamples to
          // 16k; the constructor warns on any non-16k arg. Passing the
          // avatar-derived ttsSampleRate (24000 for heygen/spike-a) would
          // emit a spurious warn on every such session-open for no effect.
          sampleRate: 16000,
          ttsSpeed: consumed.humeTtsSpeed,
          trailingSilence: consumed.humeTrailingSilence,
          description: consumed.humeVoiceDescription,
          // Audit S17 (unit-wide) — modelVersion is required-by-contract
          // upstream (mint helper enforces; route defaults to '2' on null).
          // The `|| '2'` here is defense-in-depth against a future code
          // path that bypasses mint validation — never silently degrade
          // the model selection.
          modelVersion: consumed.humeModelVersion || '2',
          pricing: getHumePricing(),
        });
      } else if (ttsProvider === 'fish') {
        // FISH_AUDIO_PHASE_1 §6. FISH_API_KEY may be unvalidated at boot
        // when env defaults to cartesia AND probeFailed (provisionPricing
        // warn-defers); the bridge constructor throws synchronously if
        // pricing is missing, which the catch below maps to a clean
        // 4005 upstream_error. Same `pricing` singleton pattern as Hume.
        if (!FISH_API_KEY) {
          // Hard-fail INSIDE try so the catch below maps to upstream_error;
          // do not crash the proxy on a single mis-provisioned ticket.
          throw new Error('FISH_API_KEY missing at session-open: provider=fish ticket but boot was deferred without env');
        }
        ttsBridge = new FishTTSBridge({
          apiKey: FISH_API_KEY,
          voiceId: creatorVoiceId,
          pricing: getFishPricing(),
          model: FISH_TTS_MODEL,
          // Phase 0.5 #1 confirmed Fish PCM @ 16k works → no resampler.
          // Honors per-session avatar sample-rate routing same as cartesia.
          sampleRate: ttsSampleRate,
          // Per-creator playback speed (creators.tts_speed → ticket →
          // here → prosody.speed in start envelope). Shares the SAME column
          // that drives cartesia's generation_config.speed; range
          // [0.6, 1.5] (DB CHECK) sits inside Fish's wire range [0.5, 2.0].
          // Bridge omits `prosody` entirely on null/1.0.
          ttsSpeed: consumed.ttsSpeed,
          // Phase 0.5 #6 long-answer drain measured 16.8s p99 → 34s floor
          // (script-recommended × 2). Bridge default already 34000ms;
          // pass explicit for visibility.
          finalizeTimeoutMs: 34_000,
        });
      } else {
        throw new Error(`unknown ttsProvider: ${ttsProvider}`);
      }
      const t0 = Date.now();
      await ttsBridge.open();
      // FISH_AUDIO_PHASE_1 §6 round-3 C4 — mirror the live bridge's provider
      // for post-fallback observability gates (audit C2: prewarm-next-turn
      // gate, listener wiring). Mutates on sidecar swap; ttsProvider stays
      // the session snapshot.
      ttsBridgeProvider = ttsProvider;
      // Pin the sample-rate at the session level so the auto-fallback
      // handler can re-use it when constructing the Cartesia sidecar.
      ttsBridgeSampleRate = ttsSampleRate;
      console.log(`[ws ${connId}] tts.open ok provider=${ttsProvider} in ${Date.now() - t0}ms`);
      // FISH_AUDIO_PHASE_1 §3 Phase 0.5 #2 + wiring audit M5 — speculative
      // pre-open for turn 1. Phase 0.5 measured Fish cold TTFA p99 ≈ 1229ms
      // vs Cartesia ~90ms — without pre-open, every turn eats the WS-setup
      // delay BEFORE first audio. prewarmTurn opens the per-turn WS in the
      // background; the subsequent `turnStart(contextId)` finds the warm
      // socket and sends `start` immediately. Fire-and-forget — bridge
      // emits `prewarm_ok` (logged above in event handler) or
      // `fallback_required` (handled with closeWs) on failure. Cartesia/
      // Hume bridges share a session-long WS; prewarm is fish-only today.
      if (ttsProvider === 'fish' && typeof ttsBridge.prewarmTurn === 'function') {
        const firstCtx = `${sessionId}:1`;
        try { ttsBridge.prewarmTurn(firstCtx); }
        catch (e) { captureException(e, { op: 'fish_prewarm_first_turn', sessionId, contextId: firstCtx }); }
      }
    } catch (e) {
      console.error(`[ws ${connId}] tts-open FAIL provider=${ttsProvider}:`, e?.message || e);
      captureException(e, { op: 'tts-open', connId, sessionId, ttsProvider });
      // R3-C3 — close Gemini before user WS so it doesn't accept audio
      // for a session that can't synthesize.
      try { await bridge?.close(); } catch {}
      bridge = null;
      await teardown('tts_open_failed');
      return closeWs(ws, 4005, 'upstream_error');
    }
  }

  // Mark session active + start heartbeat touches on sessions.last_heartbeat_at.
  // M6 audit fix: error was silently discarded; if the UPDATE failed the row
  // stayed status='starting' and the admin "live sessions" filter missed it.
  try {
    const { error: activateErr } = await supabase.from('sessions')
      .update({ status: 'active', last_heartbeat_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (activateErr) {
      console.error('[activate-session]', activateErr);
      captureException(activateErr, { op: 'activate-session', sessionId });
    }
  } catch (e) {
    console.error('[activate-session] exception', e);
    captureException(e, { op: 'activate-session', sessionId });
  }

  // Audit S4 (unit-wide) — `useCartesia` was the α' on/off flag pre-Hume;
  // with provider routing it's a misnomer when ttsProvider='hume'. We emit
  // BOTH the new `useTts` AND the legacy `useCartesia: useTts` alias on
  // the ready frame so older clients (pre-§6 harness, in-flight tabs at
  // deploy time) keep parsing. `useCartesia` is retired with §8 step 6.
  // No client should rely on it for routing decisions — it means "α' is
  // active," not "the provider is cartesia."
  ws.send(JSON.stringify({ type: 'ready', sessionId, build: BUILD, useTts, useCartesia: useTts, ttsProvider }));

  // R3-C2 / R4-C4 / S-M7 — backpressure-aware send. Applied to every
  // audio frame forwarded to the user WS (Gemini fallback or Cartesia α').
  // Three-tier cap:
  //   * per-session warn (1 MB)   → Sentry breadcrumb + user-visible
  //                                  `slow_connection` advisory event
  //   * per-session hard (2 MB)   → close 4012 backpressure
  //   * VM-aggregate hard (32 MB) → close oldest offender 4012
  let bpWarned = false;
  function sendBinaryWithBackpressure(bytes) {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > USER_WS_BACKPRESSURE_MAX_BYTES) {
      console.warn(`[ws ${connId}] backpressure-cap bufferedAmount=${ws.bufferedAmount}`);
      captureException(new Error('user_ws_backpressure_cap'), {
        level: 'warning',
        op: 'backpressure',
        sessionId,
        bufferedAmount: ws.bufferedAmount,
      });
      try { ws.send(JSON.stringify({ type: 'error', code: 'client_too_slow' })); } catch {}
      teardown('backpressure').catch(() => {});
      return closeWs(ws, 4012, 'backpressure');
    }
    if (!bpWarned && ws.bufferedAmount > USER_WS_BACKPRESSURE_WARN_BYTES) {
      bpWarned = true;
      // U-M5 — give the user a chance to act before forced disconnect.
      try { ws.send(JSON.stringify({ type: 'warning', code: 'slow_connection', at: Date.now() })); } catch {}
      captureException(new Error('user_ws_backpressure_warn'), {
        level: 'warning',
        op: 'backpressure_warn',
        sessionId,
        bufferedAmount: ws.bufferedAmount,
      });
    }
    // S-M7 — VM-aggregate guard. Cheap O(N) sum per send; N ≤ a few
    // hundred concurrent sessions per Fly machine. If ever a hot path,
    // amortize via a running counter.
    let aggregate = 0;
    let oldest = { sessionId: null, ws: null, openedAt: Infinity, buffered: 0 };
    for (const [sid, entry] of wsRegistry.entries()) {
      const b = entry.ws.bufferedAmount || 0;
      aggregate += b;
      if (b >= USER_WS_BACKPRESSURE_WARN_BYTES && entry.openedAt < oldest.openedAt) {
        oldest = { sessionId: sid, ws: entry.ws, openedAt: entry.openedAt, buffered: b };
      }
    }
    if (aggregate > USER_WS_AGGREGATE_MAX_BYTES && oldest.ws) {
      console.warn(`[ws ${connId}] vm-aggregate-backpressure aggregate=${aggregate} closing=${oldest.sessionId?.slice(0,8)}`);
      captureException(new Error('user_ws_vm_aggregate_backpressure'), {
        level: 'error',
        op: 'backpressure_aggregate',
        aggregate,
        offenderSessionId: oldest.sessionId,
        offenderBuffered: oldest.buffered,
      });
      try { oldest.ws.send(JSON.stringify({ type: 'error', code: 'client_too_slow' })); } catch {}
      try { oldest.ws.close(4012, 'backpressure'); } catch {}
    }
    ws.send(bytes, { binary: true });
  }

  // ── Vector-mode retrieval helpers (audit C1 fix + Day-13 v2 branch) ───
  //
  // retrieveTopK + buildInjectionEnvelope are static-imported from the
  // proxy-side JS mirrors at the top of this file. The previous attempt
  // dynamic-imported the .ts originals from src/lib/voice; Node's ESM
  // loader rejects .ts extensions and the catch installed silent sentinels,
  // so vector mode appeared to work but never actually retrieved anything.
  //
  // RAG v3 step 6c: dispatch chokepoint. resolveRetrievalPath() maps
  // v=1/2/3 -> 'v1'/'v2'/'v3' tokens. Throws UnknownRetrievalVersionError
  // on unknown (which the catch below maps to a hard close). v2 AND v3
  // both go through the Vercel shim (route.ts dispatches based on the
  // session snapshot); only v1 still runs in-proc retrieveTopK.
  //
  // Run retrieval for a user turn; the race against the 800ms ceiling
  // happens in the turn_complete handler.
  function kickoffRetrieval(transcript, turnNum) {
    let pathToken;
    try {
      pathToken = resolveRetrievalPath(retrievalVersionAtSession);
    } catch (e) {
      // Fail loud on unknown version: never silent-default to v1.
      console.error(
        `[ws ${connId}] kickoffRetrieval: ${e?.message || e}`,
      );
      captureException(e, {
        op: 'vector.retrieve.unknown_version',
        sessionId,
        turnNumber: turnNum,
        retrievalVersionAtSession,
      });
      pendingInjection = { skip: true, turnNumber: turnNum };
      return;
    }
    if ((pathToken === 'v2' || pathToken === 'v3') && !RAG_V2_PROXY_ENABLED) {
      // Safety net: session is marked v2/v3 at DB layer but the proxy
      // wasn't deployed with RAG_V2_PROXY_ENABLED=1 yet. Running v1
      // retrieveTopK would query chunker_version=1 chunks that may not
      // exist for a v2/v3-reprocessed creator -- silent zero results.
      // Skip retrieval entirely; user gets persona-only and we emit a
      // loud signal for ops to flip the env.
      console.error(
        `[ws ${connId}] ${pathToken} session detected but RAG_V2_PROXY_ENABLED=0 -- skipping retrieval (sessionId=${sessionId.slice(0, 8)})`,
      );
      captureException(new Error(`${pathToken}_session_proxy_disabled`), {
        op: 'vector.retrieve.proxy_disabled',
        sessionId,
        turnNumber: turnNum,
      });
      pendingInjection = { skip: true, turnNumber: turnNum };
      return;
    }
    if (pathToken === 'v2' || pathToken === 'v3') {
      // Shim does rewrite -> cache -> route (v3 only) -> topk -> rerank
      // -> cache-upsert and returns {parents, telemetry, budgetExceeded,
      // rewriteFallback, posthogEvents}. The Vercel route dispatches v2
      // vs v3 based on sessions.retrieval_version_at_session snapshot;
      // the client (callRetrieveKnowledgeV2) is version-agnostic.
      // Budget = 4000ms target -- clamped server-side to [1000, 8000].
      // We pass relative duration, not absolute epoch (audit C4: Fly<->
      // Vercel clock skew).
      //
      // Day-13 audit-build C1: per-turn AbortController so barge-in
      // (bridge `interrupted`) cancels the in-flight HTTP fetch. Without
      // this, an impatient user who barges every turn burns 2-3x budget
      // (orchestrator still runs to completion server-side, increments
      // counter, writes cogs_log for paid legs).
      const ac = new AbortController();
      pendingInjection = {
        turnNumber: turnNum,
        version: pathToken === 'v3' ? 3 : 2,
        skip: false,
        abort: () => {
          try { ac.abort(); } catch {}
        },
        promise: callRetrieveKnowledgeV2({
          userId: ticketUserId,
          creatorId: ticketCreatorId,
          sessionId,
          rawUtterance: transcript,
          lastAssistantResponse: lastAssistantResponseClosure,
          corpusVersionAtSession,
          budgetMs: 4000,
          signal: ac.signal,
        }).catch((err) => {
          // Day-13 audit M3: NEVER retry. Single-shot. Failures degrade
          // to persona-only (empty parents) so the turn still happens.
          captureException(err, {
            op: `vector.retrieve.${pathToken}`,
            sessionId,
            turnNumber: turnNum,
            code: err instanceof RetrieveV2ClientError ? err.code : 'unknown',
          });
          return { parents: [], budgetExceeded: false, rewriteFallback: false, posthogEvents: [] };
        }),
      };
      return;
    }
    // pathToken === 'v1' -- the only remaining branch (resolveRetrievalPath
    // already filtered unknowns into the catch above).
    pendingInjection = {
      turnNumber: turnNum,
      version: 1,
      skip: false,
      promise: retrieveTopK({
        supabase,
        geminiApiKey: GEMINI_API_KEY,
        userId: ticketUserId,
        creatorId: ticketCreatorId,
        queryText: transcript,
        sessionId,
      }).catch((err) => {
        captureException(err, { op: 'vector.retrieve', sessionId, turnNumber: turnNum });
        return { passages: [], budgetExceeded: false };
      }),
    };
  }

  // Audio-gate flush. Drains audioHold to the bridge in order; clears state.
  function flushAudioHold() {
    if (audioHold.length === 0) {
      forwardAudio = true;
      audioHoldBytes = 0;
      return;
    }
    for (const buf of audioHold) {
      try {
        bridge.sendAudio({ bytes: buf, mimeType: 'audio/pcm;rate=16000' });
      } catch (e) {
        // bridge_not_open mid-flush — break and let next turn rebuild.
        console.warn(`[ws ${connId}] audioHold flush abort: ${e?.message || e}`);
        break;
      }
    }
    audioHold = [];
    audioHoldBytes = 0;
    forwardAudio = true;
  }

  // Race pendingInjection against an 800ms ceiling. On result with passages,
  // call bridge.injectText. Always flush the audio gate at the end.
  //
  // Day-13: v1 returns `{passages: [{text, sourceType}]}`; v2 returns
  // `{parents: [{text, sourceType, title, score, ...}], posthogEvents, ...}`.
  // Branch on version snapshot to normalize the envelope input. Then emit
  // PostHog events from v2 telemetry + envelope oversize.
  async function resolveInjectionAtTurnComplete() {
    if (!pendingInjection || pendingInjection.skip) {
      flushAudioHold();
      pendingInjection = null;
      return;
    }
    const version = pendingInjection.version || 1;
    const promise = pendingInjection.promise;
    pendingInjection = null;

    let result = null;
    try {
      result = await Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 800)),
      ]);
    } catch (e) {
      // Caught above; swallow defensively.
      result = null;
    }
    if (result === '__timeout__') {
      retrievalTimeoutCount += 1;
      flushAudioHold();
      return;
    }
    // Normalize v1 vs v2/v3 result shapes into the envelope's input.
    // RAG v3 step 6c round-5 C1: v3 sessions emit pendingInjection.version=3
    // and the shim returns parents in the SAME shape as v2 -- so the
    // parents-shape branch must cover BOTH 2 and 3, else v3 parents get
    // dropped on the floor and the user blanks every turn (the exact bug
    // class the §5 chokepoint exists to prevent, replayed at a different
    // layer). Same for the PostHog batch + envelope-oversize emission below.
    const isShimVersion = version === 2 || version === 3;
    const envelopePassages =
      isShimVersion && Array.isArray(result?.parents)
        ? result.parents.map((p) => ({
            text: p.text,
            sourceType: p.sourceType,
            title: p.title ?? undefined,
            score: typeof p.score === 'number' ? p.score : undefined,
          }))
        : Array.isArray(result?.passages)
          ? result.passages.map((p) => ({ text: p.text, sourceType: p.sourceType }))
          : [];

    // v2/v3 telemetry -> PostHog batch -- fire regardless of envelope result.
    // Cache-hit / cache-miss / budget-exceeded / rewrite-fallback land here.
    if (isShimVersion && Array.isArray(result?.posthogEvents) && result.posthogEvents.length > 0) {
      posthogCaptureBatch({
        events: result.posthogEvents,
        distinctId: ticketUserId,
        sessionId,
      });
    }

    if (envelopePassages.length === 0) {
      retrievalEmptyCount += 1;
      flushAudioHold();
      return;
    }
    try {
      const envelope = buildInjectionEnvelope({ passages: envelopePassages });
      // Day-13 audit M6 / cross-cutting: emit `rag_envelope_oversize` when
      // input exceeded INJECTION_HARD_INPUT_BYTES even after lowest-score
      // drops. Distinct from cogs_log (envelope isn't a paid API).
      if (envelope?.oversize === true && isShimVersion) {
        posthogCaptureBatch({
          events: [
            {
              name: 'rag_envelope_oversize',
              properties: {
                user_id: ticketUserId,
                creator_id: ticketCreatorId,
                session_id: sessionId,
                dropped_passages: envelope.droppedPassages,
              },
            },
          ],
          distinctId: ticketUserId,
          sessionId,
        });
      }
      if (envelope && envelope.passageCount > 0) {
        bridge.injectText(envelope.text);
        injectionLandedCount += 1;
      }
    } catch (e) {
      captureException(e, { op: 'vector.inject', sessionId, turnNumber });
    } finally {
      flushAudioHold();
    }
  }

  // ── DECOUPLED_BRAIN_PLAN P1-5.2 — off-Live orchestrator ───────────────
  // Built ONLY for a decoupled ticket (decoupled ⇒ brain_mode 'vector'
  // by migration invariant). Owns the paraphrase→deep-answer utterance.
  // The legacy vector/drawer path is byte-identical when `decoupled` is
  // false: decoupledOrch stays null and every event site below is gated
  // on it. North star: first audio fast, seamless handoff, instant
  // barge-in, never silence/error to the user.
  let decoupledOrch = null;
  let decoupledFatalFired = false; // audit C2 — onFatal idempotency latch
  let goAwayReopenFailedFired = false; // audit NEW-M5 — fail teardown one-shot
  // 2026-06-12 prod incident — budget for UNEXPECTED Gemini upstream closes
  // (non-1000, non-goAway). Each one is recovered via the same lazy-reopen-
  // on-next-turn_start path as the audited 1000-close quirk; the budget
  // keeps a hard upstream failure (auth/quota/model gone) failing loud
  // instead of looping silent recoveries forever.
  // Budget derivation (audit S4): 1 covers the observed single-drop
  // incident; 3 tolerates a flappy Google-side window across a long
  // session while still bounding a hard failure (auth/model-gone, which
  // would close on every reopen) to ~3 wasted user turns before the loud
  // teardown. The 1000-close quirk stays UNbudgeted — it's a documented
  // benign SDK behavior (js-genai#707), not a failure signal.
  let upstreamCloseRecoveries = 0;
  const UPSTREAM_CLOSE_RECOVERY_BUDGET = 3;
  // Audit M3 — set when we relay a response_truncated warning; correlated
  // into the recovered-close Sentry context (incident precursor signal).
  let lastResponseTruncatedAt = null;
  // Audit M2 — one log per closed-bridge window, not one per 32ms audio
  // frame (a half-second of mic audio between close and reopen is ~15
  // frames; per-frame console.error buries the line that matters).
  let sendAudioFailLogged = false;
  if (decoupled) {
    // Audit M5 — decoupled REQUIRES the α' TTS layer (the deep answer is
    // spoken in the creator's cloned voice; CLAUDE.md hard rule). The
    // boot gate FATALs this, but its probe can DEFER on a Supabase blip
    // at Fly boot. This is the session-open backstop: without it every
    // ttsSendText silently discards the entire paraphrase + deep answer
    // → total silence to the user with no error (the "never silence"
    // rule violated via a resilience seam).
    if (!useTts) {
      captureException(new Error('decoupled_without_tts_layer'), {
        op: 'decoupled.no_tts', sessionId, ttsProvider,
      });
      // Whole-build audit C3 — must teardown() BEFORE closeWs so the
      // sessions row records `decoupled_no_tts_layer` as the end_reason
      // (registry-classified red-flag in fatal-end-reasons.js). The pre-
      // fix bare-close path fell into the WS onclose handler with
      // teardown reason `client_close_1011_decoupled_no_tts_layer`,
      // which is NOT in the registry → burn-in monitor classified a
      // fleet-wide misconfig as ordinary user-hangup → alert dark.
      await teardown('decoupled_no_tts_layer');
      return closeWs(ws, 1011, 'decoupled_no_tts_layer');
    }
    // retrieve(question, signal) → L2 envelope text | null. Mirrors the
    // v1/v2 normalization of resolveInjectionAtTurnComplete but RETURNS
    // the envelope instead of injecting it into Gemini (decoupled never
    // injects — that is the legacy double-answer bug path).
    const retrieveEnvelopeForDecoupled = async (question, signal) => {
      // RAG v3 step 6c: same chokepoint pattern as kickoffRetrieval --
      // resolveRetrievalPath() throws on unknown so the LIVE decoupled
      // path cannot silently fall through to v1 (the exact bug class
      // round-3 C-3 / round-4 C5 close).
      let pathToken;
      try {
        pathToken = resolveRetrievalPath(retrievalVersionAtSession);
      } catch (e) {
        captureException(e, { op: 'decoupled.retrieve.unknown_version', sessionId });
        return null;
      }
      if ((pathToken === 'v2' || pathToken === 'v3') && !RAG_V2_PROXY_ENABLED) return null;
      let result;
      try {
        if (pathToken === 'v2' || pathToken === 'v3') {
          result = await callRetrieveKnowledgeV2({
            userId: ticketUserId, creatorId: ticketCreatorId, sessionId,
            rawUtterance: question,
            // 2026-05-21 (audit C2) — prefer the orchestrator's EAGER
            // lastAssistantResponse(): the early-trigger fix means the deep
            // answer's `final` lands (and lastCompleted updates) seconds before
            // this turn's `turn_end` handler writes lastAssistantResponseClosure
            // (which is gated on Gemini's slow turn_complete). A quick follow-up
            // ("tell me more about that") arriving in that window would otherwise
            // rewrite against the turn-N-1 answer. The closure remains the
            // durable fallback for the Gemini-Live 15-min reopen (when the
            // orchestrator's in-memory lastCompleted is gone).
            lastAssistantResponse:
              (decoupledOrch && decoupledOrch.lastAssistantResponse()) || lastAssistantResponseClosure,
            corpusVersionAtSession, budgetMs: DECOUPLED_RETRIEVE_BUDGET_MS, signal,
            // fix #1 — inject only the top reranked unit(s), not the default 5.
            // Stops the 5-unit blend that made the brain disown the specific story.
            topK: DECOUPLED_INJECT_TOP_K,
          });
        } else {
          // pathToken === 'v1'
          result = await retrieveTopK({
            supabase, geminiApiKey: GEMINI_API_KEY,
            userId: ticketUserId, creatorId: ticketCreatorId,
            queryText: question, sessionId,
          });
        }
      } catch (e) {
        captureException(e, { op: 'decoupled.retrieve', sessionId });
        return null;
      }
      if (result && Array.isArray(result.posthogEvents) && result.posthogEvents.length > 0) {
        posthogCaptureBatch({ events: result.posthogEvents, distinctId: ticketUserId, sessionId });
      }
      const passages = Array.isArray(result?.parents)
        ? result.parents.map((p) => ({
            text: p.text, sourceType: p.sourceType,
            title: p.title ?? undefined,
            score: typeof p.score === 'number' ? p.score : undefined,
          }))
        : Array.isArray(result?.passages)
          ? result.passages.map((p) => ({ text: p.text, sourceType: p.sourceType }))
          : [];
      if (passages.length === 0) return null;
      try {
        const envelope = buildInjectionEnvelope({ passages });
        return envelope && envelope.passageCount > 0 ? envelope.text : null;
      } catch (e) {
        captureException(e, { op: 'decoupled.envelope', sessionId });
        return null;
      }
    };
    decoupledOrch = makeDecoupledOrchestrator({
      generateParaphrase,
      generateDeepAnswer,
      retrieve: retrieveEnvelopeForDecoupled,
      ttsSendText: (t) => {
        // FISH_AUDIO_PHASE_1 §6 round-3 C4 (code audit C1) — accumulate
        // per-turn text for auto-fallback replay. Bounded at 4200 chars
        // (OUTPUT_CHAR_CEILING + OUTPUT_CHAR_SLACK from
        // decoupled-orchestrator.js) — decoupled mode bypasses gemini-bridge's
        // OUTPUT_TRANSCRIPT_MAX_CHARS cap because text comes from
        // generateDeepAnswer not the transcript pipe. Two-mode gate:
        //   (a) pre-fallback Fish session — accumulate so we can replay
        //       on a fallback. Stop on first audio (handler clears the
        //       buffer there).
        //   (b) in-flight fallback (latch flipped, sidecar opening) —
        //       KEEP accumulating so chunks streaming during the
        //       ~200-1000ms cartesia cold-open are not lost. The IIFE
        //       replays the FULL buffer after the swap.
        // After the IIFE swaps `ttsBridge` to the sidecar, subsequent chunks
        // land directly via the lex-rebound `ttsBridge.sendText` below — no
        // need to buffer further.
        //
        // Sanitize markdown HERE (audit C1/C2 2026-06-09 — was previously
        // only inside fish-bridge.sendText). Doing it upstream means:
        //   * The fallback-replay buffer holds sanitized text → cartesia
        //     sidecar gets the same clean stream fish would have.
        //   * Cogs billing is consistent across providers (sanitized chars
        //     billed once, never raw).
        //   * Pure-markdown chunks (e.g. lone `**`) never reach the bridge
        //     → bridge lifecycle gates (`_sentFirstChunkOfTurn`) stay sane.
        // Bridge keeps its own idempotent sanitize as defense-in-depth.
        const sanitized = sanitizeForTts(t);
        if (!sanitized) return;
        const accumulating =
          (ttsBridgeProvider === 'fish' && !fallbackUsed) ||
          (fallbackUsed && !ttsBridgeProvider); // open-window detector
        if (accumulating) {
          let room = 4200 - currentTurnTextBuffer.length;
          if (room > 0) {
            let chunk = room >= sanitized.length ? sanitized : sanitized.slice(0, room);
            // Code audit M5 — avoid splitting a UTF-16 surrogate pair at the
            // slice boundary. An orphan high surrogate would surface as
            // "Invalid transcript" at Cartesia. Trim back one code unit when
            // the last char is a high surrogate.
            if (chunk.length > 0 && (chunk.charCodeAt(chunk.length - 1) & 0xFC00) === 0xD800) {
              chunk = chunk.slice(0, -1);
            }
            currentTurnTextBuffer += chunk;
          }
        }
        if (useTts && ttsBridge) {
          try { ttsBridge.sendText(sanitized); } catch (err) {
            captureException(err, { op: 'tts.sendText', sessionId, ttsProvider });
          }
        }
      },
      logBrainLeg,
      persona: consumed.systemPrompt || null,
      apiKey: GEMINI_API_KEY,
      userId: ticketUserId,
      sessionId,
      // Phase 3 (audit C1) — session tier snapshot. The AUTHORITATIVE source
      // is sess.tier (sessions.tier_at_session, set by the kill-switch trigger
      // at session-open), NOT consumed.* (the ticket-consume result carries
      // expectedTier, never `tier`). Gates the variable-depth word budget
      // (free tighter, paid full). Coerce any non-paid/unknown value to 'free'
      // — the SAFE tighter budget; a session must never accidentally get the
      // paid length budget from a stray tier string.
      tier: (sess.tier === 'premium' || sess.tier === 'boardroom') ? sess.tier : 'free',
      // Per-utterance "deep answer done" → tell the browser this turn's audio
      // has finished streaming so it can flush the Simli tail-carry (the last
      // ≤187ms that was stranded → "cut off mid-word"). Fired EARLY (when the
      // deep answer finishes), not on the +6–20s-late Gemini turn_complete.
      // Same WS as audio_out → ordered after the last audio chunk; the browser
      // still gates a short trailing-audio grace before flushing.
      onDeepAnswerDone: (turnNum) => {
        try {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'deep_answer_done' }));
        } catch { /* ws closing — nothing to flush */ }
        // Mid-word-cutoff fix (2026-05-27, v2). The deep answer's full text is now
        // in Cartesia's buffer. Send a manual flush (continue:true + flush:true —
        // does NOT close the context) so Cartesia synthesizes the final buffered
        // unit IMMEDIATELY instead of holding it under continue:true until the
        // turn_end continue:false (which is gated behind Gemini's 6-21s-late
        // turn_complete). This makes the eventual `done` land inside the (now
        // bumped) turn_end finalize window → no timeout → no context-null → no
        // dropped tail. Cartesia-only (Hume has no flush()). Context-guarded so a
        // racing next-turn turnStart can't get its in-flight partial flushed.
        // The end-of-AUDIO signal to the client is `tts_audio_done` (emitted on
        // Cartesia's real `done`), NOT this — see the ttsBridge turn_done handler.
        if (useTts && ttsBridge && typeof ttsBridge.flush === 'function') {
          try {
            const expectCtx = (typeof turnNum === 'number') ? `${sessionId}:${turnNum}` : undefined;
            ttsBridge.flush(expectCtx);
          } catch (err) {
            captureException(err, { op: 'tts.flush', sessionId, ttsProvider });
          }
        }
      },
      onFatal: () => {
        // Audit C2 — idempotent. The orchestrator's `fatal` latch
        // already blocks a second paid call, but onFatal can still be
        // invoked once from each in-flight generator (paraphrase + deep)
        // before the latch is observed; a second teardown + closeWs
        // racing the first is the double-close hazard. Fire once.
        if (decoupledFatalFired) return;
        decoupledFatalFired = true;
        try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', code: 'cogs_misconfig', op: 'decoupled' })); } catch {}
        teardown('decoupled_misconfigured').catch(() => {});
        closeWs(ws, 1011, 'cogs_misconfig');
      },
      onPersonaNull: () => console.warn(`[ws ${connId}] brain_persona_null decoupled session=${sessionId.slice(0, 8)}`),
      // 2026-05-21 (audit C1) — the orchestrator CEILING (3500) is
      // deliberately LARGER than the retrieve HTTP BUDGET (3000, above), so
      // the pipeline's result can actually be consumed instead of discarded
      // at the cliff. BUDGET ≤ CEILING still holds (the shim self-cancels at
      // 3000, the orchestrator waits to 3500), so the wasted-billing-tail
      // concern the old "lock to same value" comment worried about is still
      // covered — the shim never bills past the orchestrator's patience.
      retrieveCeilingMs: DECOUPLED_RETRIEVE_CEILING_MS,
      // DECOUPLED_BRAIN_PLAN — paraphrase OFF by default. Strict === '1'
      // parse (CLAUDE.md flag convention). When 0/unset the deep answer is
      // the sole voice (no hedge, no double-talk, no contradiction).
      paraphraseEnabled: process.env.PARAPHRASE_ENABLED === '1',
      log: {
        warn: (m) => console.warn(`[ws ${connId}] ${m}`),
        error: (m) => console.error(`[ws ${connId}] ${m}`),
      },
      captureException,
    });
  }

  // ── Gemini events ─────────────────────────────────────────────────────
  bridge.on((e) => {
    if (closed) return;
    if (e.kind === 'audio_out') {
      // R3-S3 — when α' is on the bridge already discards audio_out at
      // emit time (discardAudioOut:true). This branch is the rollback
      // path: Gemini's audio goes straight to the user.
      if (!useTts) sendBinaryWithBackpressure(e.chunk.bytes);
    } else if (e.kind === 'output_transcription_chunk') {
      // R3-C4 — pipe transcript text into the active TTS bridge. The
      // bridge's _turnDead flag drops the chunk if a barge-in already
      // fired synchronously. sendText is a no-op when bridge isn't open
      // or turn isn't started. Provider-neutral after HUME_TTS_PLAN §6.4
      // rename.
      //
      // DECOUPLED_BRAIN_PLAN P1-5.2 (§13 — site identified during P1-5.2
      // wiring, NOT in the original enumeration): in decoupled mode
      // Gemini's own answer transcript MUST NOT reach TTS — the
      // orchestrator drives TTS from the paraphrase + off-Live deep
      // answer. Piping Gemini's discarded answer here would be a second
      // voice over the orchestrator's. `&& !decoupled` ⇒ byte-identical
      // when the flag is false (`&& !false` = unchanged predicate+body).
      if (useTts && ttsBridge && !decoupled) {
        // Audit C1/C2 (2026-06-09) — sanitize markdown BEFORE wire. Same
        // policy as the decoupled `ttsSendText` site above; bridge keeps
        // its own pass as idempotent defense-in-depth.
        const sanitized = sanitizeForTts(e.text);
        if (!sanitized) return;
        try { ttsBridge.sendText(sanitized); } catch (err) {
          captureException(err, { op: 'tts.sendText', sessionId, ttsProvider });
        }
      }
    } else if (e.kind === 'transcript_runaway') {
      // L-M4 — bumped from 'warning' to 'error'. R4-C2 made the
      // OUTPUT_TRANSCRIPT_MAX_CHARS cap load-bearing for the kill-switch;
      // hitting it is a bug-class signal (model loop, prompt-injection,
      // or cap mis-tuning), not just noise. Sentry alert routes off this.
      console.error(`[ws ${connId}] transcript_runaway chars=${e.characterCount}`);
      captureException(new Error('transcript_runaway'), {
        level: 'error',
        op: 'transcript_runaway',
        sessionId,
        characterCount: e.characterCount,
      });
    } else if (e.kind === 'input_transcription') {
      // pgvector RAG plan (vector mode). Single chunk per user-turn for 3.1
      // Live. Kick off retrieval BEFORE turn_complete (which the model emits
      // immediately after when its clarifier finishes generating). The race
      // resolves in resolveInjectionAtTurnComplete().
      if (brainMode !== 'vector') return;
      // DECOUPLED_BRAIN_PLAN P1-5.2 (§13 1548) — decoupled replaces the
      // entire retrieve→inject path with the off-Live orchestrator. Fires
      // EVERY turn (B deleted; (A) is the sole gate — the short/trunc
      // skips below are a vector-injection optimization that does not
      // apply: the paraphrase is the dead-air mask on every utterance).
      // Gated on decoupledOrch ⇒ byte-identical when the flag is false.
      if (decoupled && decoupledOrch) {
        // C-5 — apply the SAME truncation heuristic the legacy vector path uses
        // below. The early-trigger used to return before that check, so a >12s
        // utterance whose transcript Gemini dropped >40% of would silently
        // ground + answer a PARTIAL question (decoupled answers from the
        // transcript, not the discarded audio). Pass the flag so the
        // orchestrator skips retrieval (persona-only) and records it; count it
        // on the same metric the legacy path reports.
        const decoupledTruncated = truncationSuspected(e.text, e.durationSec);
        if (decoupledTruncated) {
          retrievalSkippedTruncationCount += 1;
          console.warn(`[ws ${connId}] input_transcription truncated (decoupled) — persona-only deep answer (chars=${e.text.length} sec=${Number(e.durationSec).toFixed(2)})`);
        }
        decoupledOrch.onUserTranscript(e.text, turnNumber, { truncationSuspected: decoupledTruncated });
        // DECOUPLED LATENCY FIX (2026-05-21) — start the REAL deep answer the
        // INSTANT we have the final user transcript. Do NOT wait for Gemini's
        // serverContent.turnComplete: in decoupled mode Gemini still generates
        // a full AUDIO answer we DISCARD, and turn_complete only fires AFTER
        // that wasted generation. PROVEN by [latency] timestamps: transcript
        // ready at +228ms / +260ms, but turn_complete at +6693ms / +20894ms —
        // 7-21s of dead air scaling with answer length. Triggering here
        // collapses it to retrieval + deep_first (~3s, grounded). The
        // serverContent.turnComplete branch below still calls onTurnComplete
        // as a fallback (empty/garbage-transcript turns never reach here); the
        // orchestrator's `t.done` guard makes the second call RETURN WITHOUT
        // resolving spoken — the in-flight first call owns resolveSpoken (it
        // resolves only after the deep answer fully streams). Resolving here
        // would close the Cartesia context mid-answer → silent avatar.
        decoupledOrch.onTurnComplete().catch((err) => {
          captureException(err, { op: 'decoupled.turn_complete_early', sessionId });
        });
        return;
      }
      // Audit M3: skip retrieval for conversational fillers. The clarifier
      // pattern means turn N+1 ("maintaining habits") is often <20 chars
      // and doesn't carry substantive intent — the retrieval was already
      // primed on turn N. Skip burns one budget call per filler turn for
      // no gain.
      if (shortUtterance(e.text, e.durationSec)) {
        retrievalSkippedShortUtteranceCount += 1;
        pendingInjection = { skip: true, turnNumber };
        return;
      }
      if (truncationSuspected(e.text, e.durationSec)) {
        retrievalSkippedTruncationCount += 1;
        pendingInjection = { skip: true, turnNumber };
        console.warn(`[ws ${connId}] input_transcription truncated — skipping retrieval (chars=${e.text.length} sec=${e.durationSec.toFixed(2)})`);
        return;
      }
      kickoffRetrieval(e.text, turnNumber);
    } else if (e.kind === 'turn_complete') {
      consecutiveTurnCompleteTimeouts = 0; // audit C3 — a real turn_complete = Gemini healthy.
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'turn_complete', at: e.at }));
      // pgvector RAG plan — audio gate. Microtask-defer the race so any
      // same-envelope input_transcription set pendingInjection FIRST (R3 M1
      // belt-and-suspenders; bridge's _onMessage already iterates input
      // before turn_complete, but we don't trust that to never refactor).
      if (brainMode === 'vector' && !decoupled) {
        forwardAudio = false;
        setImmediate(() => {
          resolveInjectionAtTurnComplete().catch((err) => {
            captureException(err, { op: 'vector.resolve_injection', sessionId });
            flushAudioHold();
          });
        });
      } else if (brainMode === 'vector' && decoupled && decoupledOrch) {
        // DECOUPLED_BRAIN_PLAN P1-5.2 (§13 1572) — NO audio gate / NO
        // Gemini injection on the decoupled path (forwardAudio stays
        // true; nothing is injected back into Live). The orchestrator
        // awaits retrieval and streams the deep answer to TTS, seamlessly
        // continuing the paraphrase. `&& !decoupled` above ⇒ the legacy
        // branch is byte-identical when the flag is false.
        decoupledOrch.onTurnComplete().catch((err) => {
          captureException(err, { op: 'decoupled.turn_complete', sessionId });
        });
      }
    } else if (e.kind === 'interrupted') {
      // P1-10 spurious-barge fix (2026-05-20). Gemini Live emits
      // `serverContent.interrupted` when ITS OWN audio generation is
      // interrupted by incoming user audio — based on Gemini's internal
      // timeline. In decoupled mode we DISCARD that audio (Cartesia/Hume
      // is what the user actually hears), so Gemini's audio-gen timeline
      // is irrelevant to whether the user is barging in. A user who waits
      // for Cartesia to finish, then asks the next question, will still
      // trigger Gemini's interrupted (because Gemini Live is still
      // generating its own audio response in parallel). That spurious
      // event used to abort the orchestrator + (until this commit) NEVER
      // call ttsBridge.cancel(), leaving the Cartesia context orphaned →
      // "Invalid context ID" on the next turn's first sendText → silent
      // audio for the rest of the session.
      // NOTE (DECOUPLED_STT_OUTPUT_COST_PLAN, 2026-05-21): the maxOutputTokens
      // cap shrinks Gemini's discarded parallel-audio window from ~5.6s to
      // ~0.6s, so spurious interrupteds fire far less often — but the heuristic
      // below keys off Cartesia's getLastChunkAt(), not Gemini's timeline, so
      // its correctness is unchanged; only the spurious RATE drops.
      //
      // 2026-05-27 — ROOT CAUSE of the random mid-word cutoff.
      // We run MANUAL VAD (automaticActivityDetection.disabled=true): per the
      // Gemini Live docs, in manual VAD the CLIENT owns turn boundaries via
      // activityStart/activityEnd, and `interrupted` is an AUTOMATIC-VAD barge
      // signal ("the user barged in"). In our push-to-talk UX the user CANNOT
      // barge during playback (the mic isn't in talk-mode); a real barge is the
      // mic-tap, which the CLIENT signals with a `cancel` control message
      // (handled in msg.type==='cancel' below). So Gemini's `interrupted` —
      // which fires on its OWN discarded parallel-audio timeline — is ALWAYS
      // spurious here.
      //
      // The OLD heuristic suppressed it only when Cartesia was idle >1000ms,
      // i.e. it FORWARDED it whenever Cartesia was ACTIVELY playing — sending
      // the client a ClearBuffer + cancelling the live Cartesia context, which
      // CUT THE ANSWER MID-WORD whenever Gemini's timeline happened to overlap
      // playback. That overlap is non-deterministic → "2-3 turns fine, then one
      // drops at random." Forwarding during active playback is exactly the bug,
      // not the safe case.
      //
      // Fix: in decoupled mode ALWAYS suppress. Do NOT forward (no avatar cut),
      // do NOT cancel TTS (don't kill the playing answer), do NOT abort the
      // orchestrator (let the turn finish → ttsBridge.turnEnd finalizes the
      // context cleanly, so no orphaned-context "Invalid context ID" either).
      // Legacy (non-decoupled / true auto-VAD) keeps forwarding as before.
      // LOAD-BEARING on manual VAD: this is only correct because
      // automaticActivityDetection.disabled=true is HARDCODED in
      // gemini-bridge.js (~L442). If that ever becomes configurable, a real
      // auto-VAD barge could arrive via `interrupted` and this branch would
      // wrongly ignore it — re-gate then.
      let suppress = false;
      if (decoupled) {
        suppress = true;
        const lastChunk = (useTts && ttsBridge && typeof ttsBridge.getLastChunkAt === 'function')
          ? (ttsBridge.getLastChunkAt() || 0) : 0;
        const idleMs = lastChunk === 0 ? -1 : (Date.now() - lastChunk);
        // idleMs small (≈40ms) = Cartesia was actively playing when Gemini fired
        // interrupted ⇒ this is a cut the OLD code would have caused, now prevented.
        console.log(`[ws ${connId}] interrupted SUPPRESSED (decoupled manual-VAD, tts idleMs=${idleMs}; real barge = client cancel)`);
        if (decoupledOrch && typeof decoupledOrch.recordInterruptedSuppressed === 'function') {
          try { decoupledOrch.recordInterruptedSuppressed(); } catch {}
        }
      }
      if (!suppress) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'interrupted', at: e.at }));
        // P1-10 audit C2 — ORDER MATTERS. Cancel TTS bridge FIRST
        // (synchronous: flips _turnDead=true + nulls _currentContextId
        // → any in-flight paraphrase delta the orchestrator hasn't yet
        // thrown out of its for-await will hit a no-op sendText). THEN
        // abort the orchestrator. Pre-audit ordering let a 1-3 chunk
        // burst of audio reach Cartesia AFTER the user already barged
        // (microtask race between AbortSignal flip and the orchestrator
        // generator's next iteration).
        if (useTts && ttsBridge) {
          try { ttsBridge.cancel(); } catch {}
        } else if (fallbackUsed && !ttsBridge) {
          // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit M3) — user barged
          // DURING the auto-fallback's await sidecar.open(). The bridge
          // ref is null between the dead-fish-close and sidecar-wire; flag
          // it so the IIFE skips the post-open replay and closes the
          // sidecar quietly.
          cancelDuringFallback = true;
        }
        // Day-13 audit-build C1 — cancel in-flight v2 retrieval on barge-in.
        if (pendingInjection && typeof pendingInjection.abort === 'function') {
          try { pendingInjection.abort(); } catch {}
        }
        // DECOUPLED_BRAIN_PLAN P1-5.2 — barge-in: abort the in-flight
        // paraphrase/deep generators + retrieval. Each throws with
        // `.partial` (P0-4a server-billed) → the orchestrator still writes
        // the cogs leg (M6).
        if (decoupled && decoupledOrch) {
          try { decoupledOrch.onInterrupted(); } catch {}
        }
      }
    } else if (e.kind === 'error') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', at: e.at, message: e.message }));
    } else if (e.kind === 'go_away') {
      // DECOUPLED_BRAIN_PLAN P1-6 — observability only. The bridge owns
      // the proactive resumption-handle reopen at the next VAD-silence;
      // nothing for the proxy to do but record the advance warning.
      console.log(`[ws ${connId}] gemini go_away timeLeftMs=${e.timeLeftMs} reopen_in_ms=${e.deadlineInMs} session=${sessionId.slice(0, 8)}`);
    } else if (e.kind === 'go_away_reopen') {
      // The bridge's intentional close is suppressed (no 'closed'
      // event); we only see start/ok/fail/aborted_user_closed. ok ⇒
      // fresh session, next turn_start is seamless. fail ⇒ the session
      // is genuinely past the cap and unrecoverable (the reactive
      // 1000-close fallback cannot help) → tear down cleanly instead of
      // a server ABORTED.
      if (e.phase === 'fail') {
        // Audit NEW-M5 — one-shot (mirrors decoupledFatalFired). The
        // synchronous `closed` latch + the `if (closed) return` at the
        // top of this handler already prevent a second teardown, but a
        // dedicated latch keeps captureException / upstream_closed /
        // closeWs provably single-fire and matches the decoupled-fatal
        // pattern the codebase already uses for this exact hazard.
        if (goAwayReopenFailedFired) return;
        goAwayReopenFailedFired = true;
        console.error(`[ws ${connId}] gemini go_away_reopen FAILED (${e.reason}): ${e.message} — tearing down`);
        captureException(new Error('go_away_reopen_failed'), { op: 'gemini.go_away_reopen', sessionId, reason: e.reason });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'upstream_closed', at: e.at, code: 1011, reason: 'go_away_reopen_failed' }));
        teardown('go_away_reopen_failed').catch(() => {});
        closeWs(ws, 1011, 'go_away_reopen_failed');
      } else if (e.phase === 'aborted_user_closed') {
        // Audit M5 — the user closed mid-bounce. EXPECTED outcome, not a
        // failure: the user-close path owns its own teardown. Do NOT
        // captureException (phantom Sentry on every hangup-during-goAway)
        // and do NOT send upstream_closed / fire a racing teardown.
        console.log(`[ws ${connId}] gemini go_away_reopen aborted (user closed mid-bounce, ${e.reason}) session=${sessionId.slice(0, 8)}`);
      } else {
        console.log(`[ws ${connId}] gemini go_away_reopen ${e.phase} (${e.reason}) session=${sessionId.slice(0, 8)}`);
      }
    } else if (e.kind === 'closed') {
      // Phase 0.5 fix (2026-05-07). Google's js-genai#707 closes the
      // Gemini WS with code=1000 after a turn instead of holding it
      // open. Pre-fix the proxy tore the whole session down here, which
      // killed the user-WS and made my lazy-reopen in turn_start
      // unreachable. Rule now: a 1000 close = "Google's quirk, recover
      // on next turn_start via bridge.reopen()." Anything else (4xxx,
      // 1006 abnormal, etc.) = real upstream failure → tear down.
      if (e.code === 1000) {
        console.log(`[ws ${connId}] gemini upstream 1000-close — staying open for lazy reopen on next turn_start`);
        return;
      }
      // 2026-06-12 prod incident — Google dropped the Gemini WS with a
      // non-1000 code (~4:40 into a session, preceded by a truncation
      // warning). The old rule ("anything else = real upstream failure →
      // tear down") killed a session whose avatar/LiveKit + TTS legs were
      // perfectly healthy: the browser showed a dead reconnect overlay
      // while the avatar kept working. In decoupled mode Gemini is ONLY
      // the STT leg — it sits idle for minutes during long answers, which
      // makes sporadic upstream drops likely, and the next turn_start's
      // lazy bridge.reopen() (resumption handle + brain re-seed, the same
      // audited path the 1000-quirk uses) fully recovers it. Budgeted:
      // past the budget we fall through to the loud teardown so a hard
      // upstream failure still fails fast. Worst case for a recovered
      // close: one mid-speech turn is swallowed (client turn-dead
      // watchdog surfaces it; the following tap reopens).
      if (upstreamCloseRecoveries < UPSTREAM_CLOSE_RECOVERY_BUDGET) {
        upstreamCloseRecoveries += 1;
        console.warn(`[ws ${connId}] gemini upstream UNEXPECTED close code=${e.code} reason="${e.reason || ''}" — deferred reopen on next turn_start (recovery ${upstreamCloseRecoveries}/${UPSTREAM_CLOSE_RECOVERY_BUDGET}) session=${sessionId.slice(0, 8)}`);
        // 'info' level (audit M1) — sporadic drops during long idle answers
        // are EXPECTED in decoupled mode; warning-level would bury real
        // signal fleet-wide. Matches the 'gemini.reopen ok' precedent.
        // lastResponseTruncatedAt (audit M3): the 2026-06-12 incident close
        // was preceded 14s by a response_truncated warning — correlating
        // the two in Sentry tells us whether truncation predicts the drop.
        captureMessage('gemini.upstream_unexpected_close_recovered', 'info', {
          op: 'gemini.upstream_close', connId, sessionId, userId,
          code: e.code, reason: e.reason, recoveries: upstreamCloseRecoveries,
          msSinceResponseTruncated: lastResponseTruncatedAt ? (Date.now() - lastResponseTruncatedAt) : null,
        });
        return;
      }
      console.error(`[ws ${connId}] gemini upstream close code=${e.code} reason="${e.reason || ''}" — recovery budget exhausted (${UPSTREAM_CLOSE_RECOVERY_BUDGET}), tearing down session=${sessionId.slice(0, 8)}`);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'upstream_closed', at: e.at, code: e.code, reason: e.reason }));
      teardown('upstream_closed').catch(() => {});
      closeWs(ws, 1011, 'upstream_closed');
    }
  });

  // HUME_TTS_PLAN §6.9 / unit-wide-audit C2 fix — Hume's per-turn cap
  // emits `protocol_violation`. Pre-audit code wrote a second cogs row
  // inline + closed 4006 immediately. Audit C1 caught the race: the
  // normal `logTurnCogs` at turn_end runs concurrently and the cogs_log
  // UNIQUE (session_id, turn_number) ON CONFLICT DO NOTHING silently
  // drops one of the two writes.
  //
  // Resolution: SET A LATCH here, let turn_end run normally, the
  // turn_end logTurnCogs picks up `humeCapExceeded:true` from metadata
  // (single writer, no race), then closes 4006 after cogs lands.
  let humeCapExceededLatch = false;

  // Audit S13 (unit-wide) — the ttsBridge.on() handler registered below
  // captures closures over `ws`, `sessionId`, `humeCapExceededLatch`, etc.
  // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit C4) — bridge .close() does NOT
  // call removeAllListeners on either provider; the auto-fallback swap MUST
  // capture the unsubscribe handle returned by .on() so the dead-bridge
  // listener can be detached synchronously before constructing the sidecar.
  // Without offTtsBridge(), the dead Fish bridge's `closed` event (which
  // fires synchronously AFTER fallback_required per fish-bridge.js:937→945)
  // would re-enter the same handler closure and leak references.

  // ── TTS bridge event wiring (provider-neutral, swappable) ─────────────
  // Factored into wireTtsBridgeListeners so the same handler body serves
  // both initial bridge construction AND the post-fallback sidecar.
  function wireTtsBridgeListeners(bridge) {
    if (offTtsBridge) {
      try { offTtsBridge(); } catch {}
      offTtsBridge = null;
    }
    offTtsBridge = bridge.on((e) => {
      if (closed) return;
      if (e.kind === 'audio_out') {
        // FISH_AUDIO_PHASE_1 §6 round-3 C4 — first audio for this turn means
        // fallback is no longer possible (voice-mid-switch is worse UX than
        // the error). Drop the buffer; spare allocations for the rest of the
        // turn.
        if (currentTurnTextBuffer.length > 0) currentTurnTextBuffer = '';
        // R3-M1 / R4-S1 — relay-loop gate, in addition to the bridge's
        // own _turnDead check. Belt-and-suspenders against late chunks
        // from the WS receive buffer at cancel time.
        if (ttsTurnDead) return;
        sendBinaryWithBackpressure(e.chunk.bytes);
      } else if (e.kind === 'turn_done') {
        // Mid-word-cutoff fix (2026-05-27, v2). Cartesia's REAL end-of-audio for
        // this turn (`done` after the flush/continue:false synthesized the last
        // chunk). Tell the client to flush the Simli tail ONCE here — this
        // replaces the old client-side 200ms tail-flush that fired repeatedly on
        // mid-answer synthesis gaps (the stutter). Context-gated (audit M1): a
        // superseded/old turn's late `done` must NOT trigger a flush of the
        // CURRENT turn's in-flight carry. turnEnd's internal handler also fires on
        // this same event to resolve metrics — coexisting listeners.
        const liveCtx = `${sessionId}:${turnNumber}`;
        if (e.contextId === liveCtx && ws.readyState === ws.OPEN) {
          try { ws.send(JSON.stringify({ type: 'tts_audio_done' })); } catch {}
        }
        // FISH_AUDIO_PHASE_1 wiring audit M5 — speculative pre-open for
        // the NEXT turn. Fire-and-forget; bridge's prewarmIdleTimeoutMs
        // (25s default) auto-closes the warm WS if the user doesn't speak.
        // Limited to fish — cartesia/hume share a session-long WS.
        //
        // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit C2) — gate on the LIVE
        // bridge's provider (`ttsBridgeProvider`), NOT the session snapshot
        // (`ttsProvider`). Post-fallback the sidecar is Cartesia but
        // ttsProvider stays 'fish'; without this fix the handler would try
        // to call prewarmTurn() on a Cartesia bridge that has no such
        // method (the typeof guard would catch it, but it's noise + a sign
        // of stale assumption).
        if (e.contextId === liveCtx && ttsBridgeProvider === 'fish' && ttsBridge && typeof ttsBridge.prewarmTurn === 'function') {
          const nextCtx = `${sessionId}:${turnNumber + 1}`;
          try { ttsBridge.prewarmTurn(nextCtx); }
          catch (err) { captureException(err, { op: 'fish_prewarm_next_turn', sessionId, contextId: nextCtx }); }
        }
      } else if (e.kind === 'reconnected') {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts_reconnected', at: e.at }));
      } else if (e.kind === 'error') {
        // §6.9 latch: protocol_violation (per-turn cap) is non-fatal; flip
        // the flag and let turn_end's logTurnCogs handle the metadata +
        // delayed 4006 close. No inline cogs write here.
        if (e.code === 'protocol_violation' && ttsProvider === 'hume') {
          humeCapExceededLatch = true;
          // Send a user-visible truncation warning so the half-sentence
          // they just heard isn't followed by silence with no signal.
          if (ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify({ type: 'warning', code: 'response_truncated_cap', at: e.at })); } catch {}
          }
          return;
        }
        // Diagnostic 2026-05-04 — surface TTS error details to Fly logs.
        // textSample exists on cartesia; humeMessage on hume (denylisted
        // from Sentry by name in sentry.js TRANSCRIPT_KEYS).
        console.error(
          `[tts.error provider=${ttsProvider}] code=${e.code} message=${e.message} fatal=${e.fatal} sample=${JSON.stringify((e.textSample || '').slice(0, 200))}`,
        );
        if (e.fatal) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', code: 'tts_failed', at: e.at, detail: e.code }));
          }
          // HUME_TTS_PLAN §4.5 unit-wide M5 — humeMessage carries Hume's
          // verbatim error body; Sentry scrub denies the key by name, but
          // we forward it via Sentry's `extra` so a future ops view can
          // see it. Cartesia uses textSample.
          captureException(new Error(`${ttsProvider}.${e.code}`), {
            op: 'tts.error',
            sessionId,
            ttsProvider,
            ttsCode: e.code,
            detail: e.message,
            textSample: e.textSample,
            humeMessage: e.humeMessage,
          });
          teardown('tts_failed').catch(() => {});
          closeWs(ws, 1011, 'tts_failed');
        } else {
          // Phase 0.5 (2026-05-07). Recoverable per-turn rejection
          // ("Invalid transcript" et al on Cartesia; payload_parse on Hume).
          // Bridge already killed the turn locally. Kill the relay-loop
          // gate so any in-flight chunks for this dead turn are dropped.
          ttsTurnDead = true;
          if (ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'warning', code: 'tts_chunk_rejected', at: e.at, detail: e.code }));
            } catch {}
          }
          captureException(new Error(`${ttsProvider}.${e.code}_recoverable`), {
            level: 'warning',
            op: 'tts.error_recoverable',
            sessionId,
            ttsProvider,
            ttsCode: e.code,
            detail: e.message,
            textSample: e.textSample,
            humeMessage: e.humeMessage,
          });
        }
      } else if (e.kind === 'closed') {
        // Idle-window close handled by the bridge's auto-reconnect
        // (R3-M2 / R4-M2). No action required here.
      } else if (e.kind === 'fallback_required') {
        // FISH_AUDIO_PHASE_1 §6 round-3 C4 — auto-fallback re-dispatch.
        // Fish bridge emits this on pre-first-audio failures (prewarm WS
        // open, turnStart WS open, finish:error pre-first-audio, WS close
        // pre-first-audio). Re-dispatch the same turn's text to a Cartesia
        // sidecar inline. Once first audio has played, the bridge no
        // longer emits fallback_required (voice-mid-switch worse than
        // silence). Session-permanent swap: subsequent turns use the
        // sidecar via the lex-rebound `ttsBridge`.
        //
        // Audit C3 — set latch SYNCHRONOUSLY before any await so a second
        // synchronous emission (fish-bridge.js:937 emits fallback_required
        // then 945 emits `closed` on the same tick) can't race the first
        // open. Audit C4 — detach this listener from the dead Fish bridge
        // BEFORE constructing the sidecar so its trailing `closed` event
        // doesn't re-enter the wired handler graph.
        if (fallbackUsed) {
          // Second fallback (Cartesia ALSO failed) → loud-fail.
          console.error(`[ws ${connId}] fallback.cartesia_sidecar_also_failed code=${e.code}`);
          captureException(new Error('tts.fallback_double_failure'), {
            op: 'tts.fallback_double_failure',
            sessionId,
            ttsProvider,
            code: e.code,
          });
          if (ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify({ type: 'error', code: 'tts_failed', at: Date.now(), detail: 'fallback_double_failure' })); } catch {}
          }
          teardown('fallback_double_failure').catch(() => {});
          closeWs(ws, 1011, 'cartesia_sidecar_also_failed');
          return;
        }
        // Capability check: no Cartesia voice id → no sidecar possible.
        if (!cartesiaSidecarVoiceId || !CARTESIA_API_KEY) {
          fallbackUsed = true;
          console.error(`[ws ${connId}] fish.fallback_required NO SIDECAR code=${e.code} reason=missing_cartesia_voice_id_or_key`);
          captureException(new Error('fish.fallback_required.no_sidecar'), {
            op: 'fish.fallback_required.no_sidecar',
            sessionId,
            ttsProvider,
            code: e.code,
            hasVoiceId: !!cartesiaSidecarVoiceId,
            hasApiKey: !!CARTESIA_API_KEY,
          });
          if (ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify({ type: 'error', code: 'tts_failed', at: Date.now(), detail: 'fish_fallback_required_no_sidecar' })); } catch {}
          }
          teardown('fish_fallback_required_no_sidecar').catch(() => {});
          closeWs(ws, 1011, 'fish_fallback_required_no_sidecar');
          return;
        }
        // Latch BEFORE any await — synchronous re-entry from fish-bridge's
        // trailing `closed` event must short-circuit at the top of this
        // branch on the next call (audit C3).
        fallbackUsed = true;
        const fallbackReason = e.code || 'unknown';
        const fallbackContextId = e.contextId;
        const liveTurnContextId = `${sessionId}:${turnNumber}`;
        // Code audit C3 — the fallback contextId may NOT match the current
        // live turn (prewarmTurn for the NEXT turn can fire fallback_required
        // while turn N's buffer still has content). Replay text ONLY if the
        // failure was for the current live turn; for next-turn prewarm
        // failure, the buffer is irrelevant — that turn will own its own text.
        const replayForLiveTurn = fallbackContextId === liveTurnContextId;
        // Audit M1 — record which turn fell back so logTurnCogs marks the
        // correct cogs row. Reset only at this latch — subsequent turns
        // bypass the gate (turnNumber !== fallbackInvokedTurn).
        fallbackInvokedTurn = turnNumber;
        fallbackInvokedReason = fallbackReason;
        console.error(`[ws ${connId}] fish.fallback_required code=${fallbackReason} contextId=${fallbackContextId} live_ctx=${liveTurnContextId} replay_chars=${currentTurnTextBuffer.length} cartesia_voice=${(cartesiaSidecarVoiceId || 'null').slice(0,8)} fish_msg=${JSON.stringify(e.message || '')}`);

        // FISH_AUDIO_PHASE_1 §6 round-3 C4 (code audit M4) — hint the
        // client that voice synthesis is mid-swap so the avatar lipsync
        // can suppress its tail-flush during the ~200-1000ms cartesia
        // cold-open. Without this the avatar freezes mid-mouth-open then
        // resumes with the cartesia voice. Info-level frame; no toast,
        // no error overlay. Silent UX with a tiny "Switching voice…"
        // badge in session-client.tsx. Audit M4 deferred from the
        // previous slice — applied here.
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'tts_provider_switching',
              from: ttsProvider,        // 'fish' (the session snapshot)
              to: 'cartesia',           // always the fallback target
              at: Date.now(),
            }));
          } catch {}
        }

        // Detach listener from the dead Fish bridge synchronously (audit C4).
        if (offTtsBridge) {
          try { offTtsBridge(); } catch {}
          offTtsBridge = null;
        }
        // Fire-and-forget close on the dead fish bridge; teardown will also
        // call ttsBridge.close() after we swap, but the dead bridge needs
        // its WS torn down regardless. Catch + swallow — close() failure on
        // a dying bridge is not actionable.
        const deadFishBridge = ttsBridge;
        ttsBridge = null;
        ttsBridgeProvider = null;
        // Audit S2 — capture dead-bridge close errors instead of swallowing
        // (CLAUDE.md "no silent voice exception" rule). Idempotent on
        // already-closed bridges; warnings only.
        try { deadFishBridge?.close(); }
        catch (closeErr) {
          captureException(closeErr, {
            level: 'warning',
            op: 'fish.fallback.dead_bridge_close',
            sessionId,
          });
        }

        // Construct + open the Cartesia sidecar. Async; track barge-in
        // during the await (audit M3 — cancelDuringFallback).
        (async () => {
          let sidecar;
          try {
            sidecar = new CartesiaTTSBridge({
              apiKey: CARTESIA_API_KEY,
              voiceId: cartesiaSidecarVoiceId,
              sampleRate: ttsBridgeSampleRate,
              ttsSpeed: consumed.ttsSpeed,
            });
            await sidecar.open();
          } catch (openErr) {
            console.error(`[ws ${connId}] fish.fallback sidecar.open FAILED:`, openErr?.message || openErr);
            captureException(openErr, {
              op: 'tts.fallback.sidecar_open_failed',
              sessionId,
              ttsProvider,
              fallback_reason: fallbackReason,
            });
            if (ws.readyState === ws.OPEN) {
              try { ws.send(JSON.stringify({ type: 'error', code: 'tts_failed', at: Date.now(), detail: 'fish_fallback_open_failed' })); } catch {}
            }
            await teardown('fish_fallback_open_failed').catch(() => {});
            return closeWs(ws, 1011, 'fish_fallback_open_failed');
          }

          // Swap the lex-rebound bridge AFTER successful open so the
          // decoupledOrch ttsSendText closure routes subsequent chunks
          // here. `ttsBridge` is the `let` at the top of this scope; the
          // closures at ttsSendText (line ~2058) read it lexically.
          // Code audit C1 — captures the FINAL buffer (pre-latch + in-flight
          // chunks accumulated during the open await window). Read AFTER
          // the swap so any chunks landing in the microtask between
          // ttsBridge=sidecar and wireTtsBridgeListeners reach the buffer
          // via the open-window accumulator gate.
          ttsBridge = sidecar;
          ttsBridgeProvider = 'cartesia';
          // Re-wire the listener on the sidecar — same handler body, captures
          // the new `offTtsBridge`. From this point on the handler reads
          // ttsBridge as the cartesia sidecar.
          wireTtsBridgeListeners(sidecar);

          // Final-audit C1 (2026-06-09) — update sessions.tts_provider_at_session
          // to 'cartesia' so subsequent logTurnCogs calls don't fail the v3 RPC
          // cross-check (`p_tts_provider != session_snapshot` raises 22023).
          // Without this, every post-fallback turn's cogs row is silently
          // dropped AND the proxy closes WS 1011 cogs_rpc_failed after 3
          // consecutive RPC failures — i.e., every fallback session terminates
          // within ~3 turns of the fallback firing. Fire-and-forget: a failed
          // UPDATE here just means the cogs hole persists; we still want the
          // user to hear cartesia, so don't gate on the result.
          supabase
            .from('sessions')
            .update({ tts_provider_at_session: 'cartesia' })
            .eq('id', sessionId)
            .then(({ error: snapErr }) => {
              if (snapErr) {
                captureException(snapErr, {
                  level: 'warning',
                  op: 'fish.fallback.snapshot_update_failed',
                  sessionId,
                  fallback_reason: fallbackReason,
                });
              }
            });

          // If barge-in fired during await, close the sidecar quietly and
          // do not replay. The user already cancelled (audit M3).
          if (cancelDuringFallback || closed || ws.readyState !== ws.OPEN) {
            try { sidecar.cancel?.(); } catch {}
            return;
          }

          // Read buffer AFTER swap (code audit C1). Any chunks streamed
          // during the open window were appended via the open-window gate.
          const replayText = currentTurnTextBuffer;
          // Replay the buffered turn text. Skip when the buffer is empty
          // OR the failure was for a non-live context (audit C3, C5): the
          // orchestrator's normal turnStart at the user's next mic-tap
          // will own the sidecar's first context. Otherwise queue
          // turnStart + sendText + flush so the answer-so-far is
          // synthesized; remaining Gemini chunks land via the lex-rebound
          // `ttsBridge.sendText`.
          if (replayText.length > 0 && replayForLiveTurn) {
            try {
              await sidecar.turnStart(fallbackContextId);
              sidecar.sendText(replayText);
              if (typeof sidecar.flush === 'function') sidecar.flush(fallbackContextId);
              // Drop the buffer — replay is in cartesia's queue now.
              currentTurnTextBuffer = '';
            } catch (replayErr) {
              console.error(`[ws ${connId}] fish.fallback sidecar replay FAILED:`, replayErr?.message || replayErr);
              captureException(replayErr, {
                op: 'tts.fallback.replay_failed',
                sessionId,
                ttsProvider,
                fallback_reason: fallbackReason,
              });
              // Audit M7 — sidecar is in a half-open state after a failed
              // replay (turnStart took, sendText/flush didn't). Subsequent
              // chunks via lex-rebound would throw `sendText before
              // turnStart` on a fresh context. Mark the turn dead so the
              // relay-loop gate drops further audio, and the orchestrator
              // recovers on the next user turn.
              ttsTurnDead = true;
            }
          }

          // Sentry breadcrumb (audit M6) — captureMessage (NOT
          // captureException) so Sentry classifies as a warning event,
          // not an error-grouped issue.
          captureMessage('tts.fallback_invoked', 'warning', {
            op: 'tts.fallback_invoked',
            sessionId,
            ttsProvider,
            fallback_reason: fallbackReason,
            replay_chars: replayText.length,
            replay_for_live_turn: replayForLiveTurn,
          });
        })();
      } else if (e.kind === 'prewarm_ok') {
        // FISH_AUDIO_PHASE_1 §3 Phase 0.5 #2 — speculative pre-open
        // success. Lifecycle observability only; the prewarmTurn call
        // site below logs the start, this confirms the warm WS is ready.
        console.log(`[ws ${connId}] fish.prewarm_ok contextId=${e.contextId} ttfaSetupMs=${e.ttfaSetupMs ?? 'na'}`);
      } else if (e.kind === 'tts_config') {
        // Audit M7 (2026-06-09) — observability for "creator set
        // tts_speed but doesn't sound different" triage. One line per
        // start envelope so a grep proves the bridge actually emitted
        // prosody on the wire. `prosody:null` means the bridge omitted
        // the field (speed was null or 1.0, see shouldSendSpeed).
        console.log(`[ws ${connId}] tts.config provider=${ttsBridgeProvider || ttsProvider} prosody=${JSON.stringify(e.prosody)} ctx=${e.contextId}`);
      }
    });
  }
  // Initial registration — wires the active bridge. Sidecar re-wires from
  // inside the fallback_required handler via the same helper.
  if (useTts && ttsBridge) {
    wireTtsBridgeListeners(ttsBridge);
  }


  // Heartbeat: ws.ping every 20s. Client must pong (native WS behavior).
  // On pong, touch sessions.last_heartbeat_at for reaper input.
  heartbeatInterval = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) return;
    if (Date.now() - lastHeartbeatAt > 90_000) {
      await teardown('heartbeat_timeout');
      return closeWs(ws, 1011, 'heartbeat_timeout');
    }
    try { ws.ping(); } catch {}
  }, 20_000);

  ws.on('pong', async () => {
    lastHeartbeatAt = Date.now();
    try {
      await supabase.from('sessions')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('id', sessionId);
    } catch {}
  });

  // Client → proxy: binary = PCM audio chunk, text = control JSON
  ws.on('message', async (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      // pgvector RAG plan — audio gate (R2 C1). When forwardAudio=false
      // (between bridge turn_complete and resolveInjectionAtTurnComplete),
      // accumulate frames in audioHold to preserve text-before-audio ordering
      // at the turn boundary. Overflow flushes the gate without injection;
      // we prefer answering over freezing the user.
      if (!forwardAudio) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (audioHoldBytes + buf.length > AUDIO_HOLD_MAX_BYTES) {
          injectionOverflowCount += 1;
          console.warn(`[ws ${connId}] audio-gate overflow at ${audioHoldBytes + buf.length} bytes — flushing without injection`);
          flushAudioHold();
          // Fall through to forward the current frame.
        } else {
          audioHold.push(buf);
          audioHoldBytes += buf.length;
          return;
        }
      }
      try {
        bridge.sendAudio({ bytes: data, mimeType: 'audio/pcm;rate=16000' });
        sendAudioFailLogged = false; // healthy frame — re-arm the one-shot log
      }
      catch (e) {
        // Send-audio failures are usually a closed-mid-frame race (1000-close
        // / unexpected-close recovery both reopen lazily on next turn_start).
        // Audit M2 — log ONCE per failure window, not per 32ms frame: a
        // sustained burst still surfaces (the one-shot re-arms on the next
        // healthy frame, so each distinct window logs exactly once).
        if (!sendAudioFailLogged) {
          sendAudioFailLogged = true;
          console.error(`[ws ${connId}] [send-audio] FAIL (further frames in this window suppressed):`, e?.message || e);
        }
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    try {
      if (msg.type === 'turn_start') {
        const gate = await checkQuotaOk(sessionId);
        if (!gate.ok) {
          ws.send(JSON.stringify({ type: 'error', code: gate.reason, op: 'turn_start' }));
          await teardown(gate.reason);
          const closeCode = gate.fatal ? 4006 : 1008;
          return closeWs(ws, closeCode, gate.reason);
        }
        turnNumber += 1;
        turnStartedAt = Date.now(); // Phase C B4.5 — voice_usage_record day anchor
        // R3-M1 / U-C5 — clear the relay-loop barge-in flag BEFORE bridge
        // turnStart so any race with a stale chunk in the WS receive
        // buffer drops cleanly. (Was post-turnStart; moved per audit C3.)
        ttsTurnDead = false;
        // FISH_AUDIO_PHASE_1 §6 round-3 C4 (code audit C3) — clear the
        // accumulated turn-text buffer at every turn boundary so a previous
        // turn that ended WITHOUT firing audio_out (finalize_timeout, etc.)
        // can't leak its text into a next-turn prewarm-fallback replay. The
        // audio_out clear at line ~2528 covers the happy path; this is the
        // exhaustive boundary.
        currentTurnTextBuffer = '';
        // §6.9 latch reset per-turn — see protocol_violation handler.
        humeCapExceededLatch = false;
        // pgvector RAG plan — barge-in / new-turn reset of the audio gate.
        // If the client signals turn_start while we're still mid-injection
        // (forwardAudio=false), the user has barge-in'd the clarifier. Drop
        // the pending injection and flush any held audio so the new turn
        // streams cleanly. The user's pending question is the new substantive
        // turn; retrieval will re-fire on the next input_transcription.
        if (!forwardAudio || pendingInjection) {
          pendingInjection = null;
          flushAudioHold();
        }
        // Phase 0.5 fix (2026-05-07). Google's 3.1 Live preview sometimes
        // closes the WS with code=1000 after a turn instead of holding it
        // open (js-genai#707). The [google-live-workaround] in
        // gemini-bridge synthesizes a turn_complete so the CURRENT turn
        // resolves, but subsequent turn_starts then throw bridge_not_open.
        // Symptom: "stops hearing me after turn 1." Lazy-reopen here so
        // multi-turn conversations survive the upstream bug. Cost: brief
        // (~200ms) reconnect latency on the affected turn + fresh Gemini
        // context (no history). Acceptable until Google fixes upstream.
        if (bridge._closed) {
          try {
            await bridge.reopen();
            // Phase C B3.4: surface success-path frequency to Sentry as
            // info-level event. js-genai#707 reopen rate is invisible
            // today (only failures captured) — frequency feeds into
            // memory project_voice_session_history_loss for triage. Tagged
            // with userId per B3.5.
            captureMessage('gemini.reopen ok', 'info', {
              op: 'bridge-reopen-success', connId, sessionId, userId, turnNumber,
            });
          } catch (e) {
            console.error(`[ws ${connId}] gemini.reopen FAIL:`, e?.message || e);
            // B3.5: include userId so Sentry can group / filter by user.
            captureException(e, { op: 'bridge-reopen', connId, sessionId, userId });
            await teardown('bridge_reopen_failed');
            return closeWs(ws, 4005, 'upstream_error');
          }
          // Re-attach event handler — the new ai.live.connect emits via
          // the SAME EventEmitter instance (this.emit) so existing
          // bridge.on() handler stays wired. No re-registration needed.
        }
        bridge.turnStart();
        // R4-M2 / U-C5 — TTS bridge turnStart can throw `tts_reconnecting`
        // synchronously when the bridge is in its auto-reconnect window
        // (Cartesia and Hume both auto-reconnect on idle/network glitch).
        // Wait up to 1500ms for the `reconnected` event before giving up.
        // Audit R3-C1 — listener-attach race verified false-positive: JS is
        // single-threaded and `ttsBridge.on(handler)` runs synchronously
        // inside the Promise body BEFORE the await yields.
        if (useTts && ttsBridge) {
          let attempt = 0;
          while (attempt < 2) {
            try {
              // FISH_AUDIO_PHASE_1 §6 round-3 C4 (code audit C4) — Fish's
              // turnStart is async (per-turn WS open round-trip); cartesia +
              // hume are sync (session-long WS). The await accepts both: a
              // sync throw becomes a rejected promise, the existing
              // `e?.code === 'tts_reconnecting'` branch still works because
              // both throw an Error with `.code`. Without the await, fish's
              // promise rejection escapes as an unhandled rejection and the
              // try/catch matches nothing.
              await ttsBridge.turnStart(`${sessionId}:${turnNumber}`);
              break; // success
            } catch (e) {
              if (e?.code === 'tts_reconnecting' && attempt === 0) {
                attempt += 1;
                const waited = await new Promise((resolve) => {
                  const to = setTimeout(() => { off(); resolve(false); }, 1500);
                  const off = ttsBridge.on((ev) => {
                    if (ev.kind === 'reconnected') { clearTimeout(to); off(); resolve(true); }
                    else if (ev.kind === 'error' && ev.fatal) { clearTimeout(to); off(); resolve(false); }
                  });
                });
                if (!waited) {
                  ws.send(JSON.stringify({ type: 'error', code: 'tts_reconnecting', op: 'turn_start' }));
                  await teardown('tts_reconnecting');
                  return closeWs(ws, 4011, 'tts_reconnecting');
                }
                continue;
              }
              if (e?.code === 'tts_reconnecting') {
                ws.send(JSON.stringify({ type: 'error', code: 'tts_reconnecting', op: 'turn_start' }));
                await teardown('tts_reconnecting');
                return closeWs(ws, 4011, 'tts_reconnecting');
              }
              captureException(e, { op: 'tts.turnStart', sessionId, ttsProvider });
              await teardown('tts_turn_start_failed');
              return closeWs(ws, 4005, 'upstream_error');
            }
          }
        }
      } else if (msg.type === 'turn_end') {
        // 2026-05-21 (audit M6) — capture the turn being ended BEFORE the
        // await below. `bridge.turnEnd()` waits for Gemini's turn_complete
        // (+7–21s in decoupled mode), and the user can start the NEXT turn in
        // that window (turn_start increments `turnNumber`). The early-trigger
        // fix means THIS turn's deep answer already finished speaking, so if a
        // newer turn superseded it we must NOT run the TTS finalization here —
        // `ttsBridge.turnEnd()` flushes the bridge's `_currentContextId`, which
        // now belongs to the NEWER turn, and would cut its audio mid-word.
        const endingTurn = turnNumber;
        let metrics;
        let recoveredFromTimeout = false;
        let turnSpokenOk = false; // audit M-2 — did the deep answer actually play this turn?
        // Audit C-NEW-1 — when set, this turn FINALIZES NORMALLY (its answer
        // played → its COGS/quota MUST be written) and the session closes for a
        // clean reconnect only AFTER cogs land (see the cogsPromise tail).
        let geminiUnresponsiveEscalate = false;
        try {
          const turnEndTimeoutMs = msg.timeoutMs || (decoupled ? DECOUPLED_TURN_END_TIMEOUT_MS : 30_000);
          metrics = await bridge.turnEnd({ timeoutMs: turnEndTimeoutMs });
        } catch (e) {
          // 2026-05-27 — turn_complete_timeout must NOT kill a decoupled session.
          // In decoupled mode the off-Live deep answer streams to TTS and plays
          // INDEPENDENTLY of Gemini Live's `turn_complete` (Gemini is STT-only;
          // its turn_complete is a turn-boundary/COGS signal, not the answer).
          // Gemini intermittently fails to emit turn_complete (observed live
          // 2026-05-27 session 55e67485: clean open, answer played, then the
          // await threw → session torn down MID-ANSWER on a long reply). Recover:
          // finalize the turn with the byte counts we DID observe and keep the
          // session alive. The genuinely-fatal cases — Gemini WS dead
          // (`ws_closed_mid_turn`) or a fatal bridge error — still throw through
          // to the [control] catch. Legacy (non-decoupled) keeps strict behavior.
          if (decoupled && e && e.message === 'turn_complete_timeout' && typeof bridge.getPartialTurnMetrics === 'function') {
            consecutiveTurnCompleteTimeouts += 1;
            // M6 — partialMetrics was snapshotted at activityEnd (before the
            // await), so a racing next-turn turnStart can't have zeroed it.
            metrics = e.partialMetrics || bridge.getPartialTurnMetrics();
            recoveredFromTimeout = true;
            // C3 escalation is decided AFTER the answer-delivery check below
            // (audit M-2): a timeout whose answer still PLAYED is a healthy turn
            // Gemini just didn't emit turn_complete for, and must not count
            // toward the wedge streak.
            const inS = (typeof metrics.inputSeconds === 'number') ? metrics.inputSeconds.toFixed(1) : '?';
            console.warn(`[ws ${connId}] turn_complete_timeout (turn ${endingTurn}, streak ${consecutiveTurnCompleteTimeouts}, inputS=${inS}) — decoupled non-fatal; finalizing + keeping session`);
          } else if (
            // Upstream-close-recovery audit C1 (2026-06-12 incident): the
            // mid-answer Gemini close rejects THIS await with
            // 'ws_closed_mid_turn …' — the stay-open decision was already
            // made by the bridge 'closed' handler (it runs FIRST: it was
            // registered at session open, before turnEnd's temporary
            // listener, and emit() calls listeners in registration order).
            // If that handler chose recovery (`closed` latch still false),
            // absorb the rejection exactly like the timeout path: finalize
            // with partial metrics, keep the session, let the next
            // turn_start lazy-reopen. If it chose teardown (budget
            // exhausted → `closed` latch true), throw through as before.
            // Audit C2: the budget is incremented ONLY in the 'closed'
            // handler — this catch never mutates it. Deliberately does NOT
            // touch consecutiveTurnCompleteTimeouts (different failure
            // class: the bridge reopens next turn; the wedge streak is for
            // a live-but-mute Gemini).
            decoupled && e && typeof e.message === 'string'
              && e.message.startsWith('ws_closed_mid_turn')
              && !closed
              && typeof bridge.getPartialTurnMetrics === 'function'
          ) {
            metrics = bridge.getPartialTurnMetrics();
            recoveredFromTimeout = true;
            console.warn(`[ws ${connId}] ${e.message} (turn ${endingTurn}) — decoupled non-fatal; finalizing + deferred reopen on next turn_start (recovery ${upstreamCloseRecoveries}/${UPSTREAM_CLOSE_RECOVERY_BUDGET})`);
          } else {
            throw e;
          }
        }
        const superseded = decoupled && turnNumber !== endingTurn;
        // DECOUPLED_BRAIN_PLAN P1-5.2 — the off-Live deep answer streams to TTS
        // gated behind retrieval. Wait (bounded) for the orchestrator to finish
        // speaking THIS turn before continue:false, so the answer isn't
        // truncated to the hedge. Skipped when superseded (M6): that turn
        // already spoke and `turn` now points at the newer one.
        // Decoupled-only ⇒ legacy path byte-identical.
        if (decoupled && decoupledOrch && !superseded) {
          // Audit Small — floor the wait so a buggy/malicious client sending a
          // tiny timeoutMs can't let continue:false race ahead of the deep
          // answer (the exact C1 truncation this gate prevents). Client cannot
          // shrink it below the floor; can still extend it (e.g. 60s).
          // Floor = 30s (audit M3): the wait covers deep-answer GENERATION
          // streaming to TTS, whose worst case is retrieval (≤retrieveCeilingMs
          // 3.5s) + a Haiku FAILOVER (Gemini stalls ~2s, then Haiku streams a
          // full tier-aware ~450-word answer FROM SCRATCH) — which a hand-picked
          // 15s could still blow through, truncating to the hedge (the exact C1
          // failure). So we floor at the orchestrator's OWN hard cap
          // (turnSpokenTimeoutMs = 30s): the client can EXTEND but never shrink
          // the wait below the bound the orchestrator already enforces, so the
          // gate can't truncate a generation the orchestrator would still allow.
          // Today's client sends NO timeoutMs (→ 30s), so behavior is unchanged;
          // this hardens the variable-depth + failover ramp. resolveSpoken on a
          // finished/superseded turn returns INSTANTLY, so the floor only bites
          // an unresolved turn — exactly the case it must not cut short.
          const spokenWaitMs = Math.max(msg.timeoutMs || 30_000, 30_000);
          try { await decoupledOrch.awaitTurnSpoken(spokenWaitMs); turnSpokenOk = true; }
          catch (e) { captureException(e, { op: 'decoupled.awaitTurnSpoken', sessionId }); }
        }
        // Audit M-2 — decide C3 escalation only AFTER the answer-delivery check.
        // A recovered timeout whose deep answer GENUINELY PLAYED (awaitTurnSpoken
        // resolved) — or that the user already moved past (superseded) — is a
        // HEALTHY turn Gemini merely failed to emit turn_complete for; reset the
        // streak so a slow-but-fine answer (e.g. a 16–29s Haiku failover that
        // trips the 15s turn_complete wait) can never accumulate toward a false
        // reconnect. Escalate ONLY when the answer ALSO failed to deliver on
        // consecutive timeouts — the genuine "everything wedged" case.
        if (recoveredFromTimeout) {
          if (superseded || turnSpokenOk) {
            consecutiveTurnCompleteTimeouts = 0;
          } else {
            geminiUnresponsiveEscalate = consecutiveTurnCompleteTimeouts >= MAX_CONSECUTIVE_TURN_COMPLETE_TIMEOUTS;
          }
        }
        if (superseded) {
          console.warn(`[ws ${connId}] turn_end superseded — turn ${endingTurn} finalized cogs-only (turn ${turnNumber} now live, TTS finalize skipped)`);
        }
        let ttsMetrics = null;
        if (useTts && ttsBridge && !superseded) {
          // R3-C1 / R4-C1 — always await; bridge resolves with partial:true
          // on timeout/error so logTurnCogs (and the Gemini legs) always
          // land. NEVER throw out of this path.
          // 2026-05-27 (v2) — bumped 10s → 60s. THE long-answer cutoff: a long
          // answer is still streaming audio when continue:false is sent; the old
          // 10s timeout resolved partial → cleanup() nulled _currentContextId →
          // every still-arriving Cartesia chunk hit the ctx-mismatch drop
          // (cartesia-bridge.js) → avatar cut mid-word. The early flush at
          // deep_answer_done clears most of the backlog so `done` usually lands
          // fast, but a genuinely long monologue needs headroom before the
          // context is nulled. 60s covers realistic answers; null-on-timeout
          // stays as the stuck-Cartesia safety net (now rare). Hume keeps 10s
          // (its turnEnd already carries flush; no decoupled long-tail path).
          // FISH_AUDIO_PHASE_1 §3 #6 — Fish long-answer drain measured
          // 16.8s p99 → 34s floor. Cartesia keeps 60s (decoupled long-tail).
          // Hume keeps 10s (turnEnd already carries flush; no long tail).
          const ttsFinalizeTimeoutMs = ttsProvider === 'cartesia' ? 60_000
                                     : ttsProvider === 'fish'     ? 34_000
                                     :                              10_000;
          ttsMetrics = await ttsBridge.turnEnd({ timeoutMs: ttsFinalizeTimeoutMs });
        }
        // U-M6 — surface a user-facing warning when the TTS bridge returned
        // partial. The cogs row records the partial flag for dashboard
        // reconciliation; this lets the client UI show "(this response was
        // cut off — ask again)" instead of failing silent.
        if (ttsMetrics?.partial) {
          lastResponseTruncatedAt = Date.now(); // audit M3 — close-precursor signal
          try {
            ws.send(JSON.stringify({
              type: 'warning',
              code: 'response_truncated',
              at: Date.now(),
              characters: ttsMetrics.characters,
            }));
          } catch {}
        }
        // `cartesia` envelope key kept for back-compat with the harness +
        // existing client code; carries the active bridge's metrics either
        // way (regardless of provider — name is legacy, not literal). New
        // `tts` key alongside for future readers. Drop `cartesia` with the
        // §8 step 6 retire-back-compat PR after clients migrate. Audit S8.
        // Day-13 audit C5 / M4 / audit-build M3 — last_assistant_response
        // handling. The closure const is the source-of-truth for the NEXT
        // turn's rewriter; the DB UPSERT is durable-fallback for WS
        // replacement on Gemini Live 15-min reopen. Length-gated >=
        // MIN_PERSIST_CHARS so failed/partial turns don't poison turn
        // N+1's context.
        //
        // audit-build M3: update the closure BEFORE ws.send(turn_end_ack).
        // Gemini 3.1 Live can emit turn_complete + next-turn's
        // input_transcription in a single synchronous parse cycle; if we
        // updated AFTER ws.send, the next input_transcription handler
        // (which calls kickoffRetrieval reading the closure) could
        // observe stale turn-N-1 data.
        // RAG v3 step 6c: decoupled mode is gated on v=2 OR v=3 (both
        // use the same off-Live deep-answer architecture). v=1 sessions
        // never decouple. Wrap in the chokepoint -- a missed v4 here would
        // silently route to the legacy outputTranscript path.
        let decoupledPathToken;
        try {
          decoupledPathToken = resolveRetrievalPath(retrievalVersionAtSession);
        } catch {
          // Unknown version at this late point is already alarming, but
          // the kickoffRetrieval site has emitted a captureException.
          // Here we just fall through to the v=1 transcript source.
          decoupledPathToken = 'v1';
        }
        if (decoupledPathToken === 'v2' || decoupledPathToken === 'v3') {
          // DECOUPLED_BRAIN_PLAN P1-5.2 / R4-M4 (§13 1911-1916, the ONLY
          // non-byte-identical site): in decoupled mode Gemini's
          // `metrics.outputTranscript` is its DISCARDED answer — wrong
          // source for the next turn's retrieval rewrite. Use the
          // off-Live deep-answer text instead. When `decoupled` is false
          // the ternary's else-branch is the EXACT original expression ⇒
          // byte-identical legacy.
          const transcript = decoupled
            ? ((decoupledOrch && decoupledOrch.lastAssistantResponse()) || '')
            : (typeof metrics?.outputTranscript === 'string'
              ? metrics.outputTranscript
              : '');
          if (transcript.length >= MIN_PERSIST_CHARS) {
            lastAssistantResponseClosure = transcript.slice(0, VOICE_SESSION_STATE_MAX_CHARS);
            // Fire-and-forget. The writer never throws; errors land in
            // Sentry via onError but don't block the turn lifecycle.
            persistLastAssistantResponse(
              supabase,
              sessionId,
              lastAssistantResponseClosure,
              (err, ctx) =>
                captureException(err, { op: ctx?.stage || 'voice_session_state', sessionId }),
            );
          }
        }

        // Audit C2 — recovered turn_complete_timeout: Gemini never emitted
        // turn_complete, so the proxy never sent the client its `turn_complete`
        // frame (normally sent at the bridge turn_complete event). Without it
        // the client's reducer stays stuck at phase 'speaking' → the next mic
        // tap is misread as a barge-in. Synthesize the boundary now (the answer
        // is confirmed done via awaitTurnSpoken above), matching the normal
        // late-turn_complete timing. Skip when superseded — the newer turn owns
        // the boundary.
        if (recoveredFromTimeout && !superseded && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'turn_complete', at: Date.now() }));
        }
        ws.send(JSON.stringify({ type: 'turn_end_ack', metrics, cartesia: ttsMetrics, tts: ttsMetrics, ttsProvider }));
        // FISH_AUDIO_PHASE_1 §6 round-3 C4 (code audit C2) — POST-fallback
        // the live bridge is cartesia. Bill chars/cost at cartesia's rate
        // (the actual provider that synthesized) so the cogs row isn't
        // 3.5x underbilled at Fish's price. The session snapshot
        // (`ttsProvider`) stays 'fish' for session attribution, but the
        // turn cogs row reflects who actually did the work.
        const cogsProvider = ttsBridgeProvider || ttsProvider;
        // Audit M3 — every post-fallback turn carries `tts_fallback_session`
        // so dashboards can find ALL turns of a degraded session, not just
        // the one turn the swap happened on. `tts_fallback_invoked` is the
        // narrower per-turn marker.
        const isPostFallbackTurn = fallbackUsed;
        const isFallbackTurnSelf = fallbackInvokedTurn === turnNumber;
        const cogsPromise = logTurnCogs({
          userId, sessionId, turnNumber,
          inputSeconds: metrics.inputSeconds,
          outputSeconds: metrics.outputSeconds,
          usageMetadata: metrics.usageMetadata,
          // logTurnCogs ignores `tts` if undefined (back-compat). The
          // factory keeps the `cartesia` key as a legacy alias and the new
          // `tts` carries the provider tag.
          ttsProvider: cogsProvider,
          tts: ttsMetrics,
          // §6.9 / audit-C1 — the per-turn cap signal lands as metadata
          // on the normal turn_end cogs row. Single writer, no race with
          // a separate cap-flush. 4006 close fires AFTER cogs resolve.
          humeCapExceeded: humeCapExceededLatch,
          // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit M1 + M3) — turn-level
          // + session-level fallback markers.
          extraMetadata: isPostFallbackTurn
            ? {
                tts_fallback_session: true,
                session_snapshot_provider: ttsProvider, // 'fish' even after swap
                ...(isFallbackTurnSelf
                  ? { tts_fallback_invoked: true, fallback_reason: fallbackInvokedReason }
                  : {}),
              }
            : null,
        });
        cogsPromise.catch((e) => {
          // R4-S3 fail-closed: getCartesiaPricing/getHumePricing throws if
          // env is missing/zero. The validators run at module-load (proxy
          // boot) so this catch is dead in steady state.
          captureException(e, { op: 'logTurnCogs', sessionId, fatal: true });
          ws.send(JSON.stringify({ type: 'error', code: 'cogs_misconfig', op: 'turn_end' }));
          teardown('cogs_misconfig').catch(() => {});
          closeWs(ws, 1011, 'cogs_misconfig');
        });
        if (humeCapExceededLatch) {
          // §6.9 / audit-C1 — close 4006 AFTER cogs lands. await-then-close
          // serializes the writes; the latch is a per-turn flag, reset on
          // next turn_start. R3-C1 rule satisfied: capped cogs row landed
          // before WS close.
          cogsPromise.finally(() => {
            if (ws.readyState === ws.OPEN) {
              try { ws.send(JSON.stringify({ type: 'error', code: 'quota_state_inconsistent', at: Date.now() })); } catch {}
            }
            teardown('hume_per_turn_cap_exceeded').catch(() => {});
            closeWs(ws, 4006, 'quota_state_inconsistent');
          });
        } else if (geminiUnresponsiveEscalate) {
          // Audit C3 + C-NEW-1 — Gemini Live wedged (MAX consecutive
          // turn_complete_timeouts whose answers ALSO failed to play). This
          // turn's books closed normally above (turn_end_ack sent, cogs queued).
          // Close for a CLEAN RECONNECT only after cogs land (mirrors the humeCap
          // pattern), with NO error frame so the client maps the non-4002 close
          // to 'reconnecting' (tap-to-resume) → fresh, un-wedged Gemini session,
          // NOT a fatal redirect. `else if` (audit M-1): mutually exclusive with
          // the Hume-cap close so a single turn can't register two finally-closes
          // (cap-exceeded is the more specific terminal reason → wins).
          cogsPromise.finally(() => {
            teardown('gemini_unresponsive').catch(() => {});
            closeWs(ws, 1011, 'gemini_unresponsive');
          });
        }
        // R4-C1 — quota math: when α' is on, sum mic seconds + REAL TTS
        // audio seconds. L-C2 fix: when TTS returns `partial:true` (hang/
        // timeout/error mid-turn), fall back to Gemini's `outputSeconds`
        // so the kill-switch still sees real assistant-talk seconds.
        let quotaSeconds;
        if (useTts) {
          if (ttsMetrics?.partial) {
            quotaSeconds = (metrics.inputSeconds || 0) + (metrics.outputSeconds || 0);
          } else {
            quotaSeconds = (metrics.inputSeconds || 0) + ((ttsMetrics?.audioSeconds) || 0);
          }
        } else {
          quotaSeconds = (metrics.inputSeconds || 0) + (metrics.outputSeconds || 0);
        }
        accumulateSeconds(sessionId, quotaSeconds)
          .then(async (res) => {
            if (res?.fatal) {
              ws.send(JSON.stringify({ type: 'error', code: res.reason, op: 'turn_end' }));
              await teardown(res.reason);
              closeWs(ws, 4006, res.reason);
            }
          })
          .catch((e) => {
            // Non-fatal accumulate failure: quota seconds for this turn
            // are dropped (user gets a free turn). Surface to Sentry
            // rather than swallowing — repeated drops indicate a quota
            // RPC outage that the kill-switch's degraded-snapshot path
            // should be handling, but we want to see it.
            captureException(e, { level: 'warning', op: 'accumulateSeconds', sessionId });
          });

        // Phase C B4.5 — System B counter (voice_usage_daily/weekly).
        // Currency = "audio the user actually heard" (migration
        // 20260428000002 §"WHY seconds as the currency"). When α' is on,
        // ttsMetrics.audioSeconds is the truth — even on partial:true it
        // reports delivered audio bytes / sample rate, so it accurately
        // captures the partial-delivered seconds. We DO NOT fall back to
        // Gemini's outputSeconds on TTS partial (audit C1): outputSeconds
        // is the DISCARDED Gemini audio in Pipeline α' — billing the user
        // for audio they never heard would create support tickets.
        let assistantSeconds;
        if (useTts) {
          assistantSeconds = ttsMetrics?.audioSeconds || 0;
        } else {
          assistantSeconds = metrics?.outputSeconds || 0;
        }
        recordVoiceUsage({
          userId, sessionId, turnNumber,
          seconds: assistantSeconds,
          turnStartedAt,
        }).catch((e) => {
          // Non-fatal: counter undercount for this turn. System A's
          // 150% latch (now correctly anchored to profile cap after
          // 20260510000001) is the backstop.
          captureException(e, { level: 'warning', op: 'voice_usage_record', sessionId });
        });
      } else if (msg.type === 'cancel') {
        // R3-M1 / R4-S1 — set the relay-loop flag SYNCHRONOUSLY before any
        // await, then ws-send cancel to the active TTS bridge. Bridge.cancel
        // also sets its own flag synchronously.
        ttsTurnDead = true;
        bridge.cancel();
        if (useTts && ttsBridge) {
          ttsBridge.cancel();
        } else if (fallbackUsed && !ttsBridge) {
          // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit M3) — client cancel
          // arrived DURING the auto-fallback's await sidecar.open(). The
          // IIFE checks this flag post-open and skips replay.
          cancelDuringFallback = true;
        }
        // Re-audit M1 — a CLIENT mic-tap barge sends `cancel`. In decoupled mode
        // (2026-05-27) the proxy now ALWAYS suppresses Gemini's `interrupted`, so
        // this client `cancel` is the SOLE barge signal that reaches the
        // orchestrator — making this onInterrupted() call load-bearing, not a
        // backstop. Notify the orchestrator so (1) the in-flight deep
        // generate/Haiku stream is ABORTED — otherwise it runs to completion and
        // keeps billing after the user already moved on; and (2) `t.barged` is
        // set, which correctly SUPPRESSES the deep_answer_done tail-flush signal
        // (a flush after a barge could nudge a stale frame). abortTurn is
        // idempotent and null-safe, so a cancel with no live turn is a no-op.
        if (decoupled && decoupledOrch) {
          try { decoupledOrch.onInterrupted(); } catch {}
        }
      }
    } catch (e) {
      console.error('[control]', msg?.type, e);
      // A throw that ESCAPES to this catch means the control handler did NOT
      // finish — that is fatal by definition (the recoverable turn_complete_
      // timeout is absorbed locally in the turn_end handler and never reaches
      // here). Keep the original fatal contract so a genuinely broken handler
      // (e.g. bridge_not_open in turn_start) is surfaced, not silently swallowed.
      // Audit Small — also capture server-side so a swallowed control throw
      // isn't invisible beyond the Fly log line.
      captureException(e, { op: 'control', msgType: msg?.type, sessionId });
      // Audit M-NEW-5 — clamp: e.message can be an upstream-derived string
      // (e.g. `ws_closed_mid_turn code=… reason=<google text>`). Bound it so
      // unexpected upstream text can't bloat/poison the payload. NOTE (audit
      // S1, 2026-06-12): today's proxy-client reads only `msg.code` from
      // error frames and DROPS `message` — this string reaches Sentry/logs,
      // not the user; the clamp is defense for a future client that renders it.
      const safeMsg = typeof e?.message === 'string' ? e.message.slice(0, 120) : 'control_error';
      ws.send(JSON.stringify({ type: 'error', message: safeMsg, op: msg?.type }));
    }
  });

  ws.on('close', (code, reason) => {
    teardown(`client_close_${code}_${String(reason || '').slice(0, 60)}`).catch(() => {});
  });

  ws.on('error', (e) => {
    console.error('[ws-error]', e);
    teardown('ws_error').catch(() => {});
  });
});

// ── Start ────────────────────────────────────────────────────────────────

let reaperHandle = null;
let voiceDeleteHandle = null;
let simliFaceDeleteHandle = null;
let faceUploadReaperHandle = null;
let embedWorkerHandle = null;
let corpusReprocessWorkerHandle = null;
// Day-5-unit-audit C1: hold the worker OBJECT (not just .handle) so the
// SIGTERM handler can call signalShutdown() before killing the interval.
let corpusReprocessWorker = null;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`voice-proxy listening on :${PORT} (build=${BUILD})`);
  // Reaper: 20s cadence + 60s threshold (RPC default). Fires once at boot for
  // proxy-crash recovery, then every 20s. See plan §1B.
  reaperHandle = installReaper({ supabase }).handle;
  // R4-M3 + HUME_TTS_PLAN §5.4 + FISH_AUDIO_PHASE_1 §4 M4 — voice-delete
  // worker (deferred provider DELETE queue). Install whenever α' is on +
  // ANY provider key is set (per-row dispatch checks the right key by
  // `tts_provider`; a missing key for a given provider leaves those rows
  // in skip-bump until the 24h orphan window catches them). HUME_API_KEY
  // and FISH_API_KEY also forwarded so hume/fish queue rows can dispatch
  // without a separate worker boot.
  if (VOICE_TTS_LAYER_ENABLED && (CARTESIA_API_KEY || HUME_API_KEY || FISH_API_KEY)) {
    voiceDeleteHandle = makeVoiceDeleteWorker({
      supabase,
      cartesiaApiKey: CARTESIA_API_KEY || null,
      humeApiKey:     HUME_API_KEY     || null,
      fishApiKey:     FISH_API_KEY     || null,
    }).install().handle;
  }
  // SIMLI_WIREUP §12a.3 / R3-Missing-3 — Simli face-delete worker.
  // Drains simli_face_delete_queue rows (creator deletion + force-retrain).
  // No-op without SIMLI_API_KEY; queue rows accumulate harmlessly until
  // the env is set + Fly redeploys.
  if (SIMLI_API_KEY) {
    simliFaceDeleteHandle = makeSimliFaceDeleteWorker({ supabase, simliApiKey: SIMLI_API_KEY })
      .install().handle;
  } else {
    console.warn('[boot] SIMLI_API_KEY missing — simli-face-delete-worker disabled');
  }
  // Auditor R3-NC2 — stale-pending face-upload reaper. No vendor key
  // needed; just calls the SECURITY DEFINER RPC. Always on.
  faceUploadReaperHandle = makeFaceUploadReaper({ supabase }).install().handle;
  // pgvector RAG plan — embed-worker (in-process, R3 M5). Spawns alongside
  // the other workers; same Fly app, same env. Polls
  // sample_content_embedding_jobs every 5s and chunks + embeds via
  // gemini-embedding-001. No-op without GEMINI_API_KEY (validated at boot
  // already; this is defensive).
  if (GEMINI_API_KEY) {
    embedWorkerHandle = makeEmbedWorker({
      supabase,
      geminiApiKey: GEMINI_API_KEY,
      flyMachineId: BUILD,
    }).install().handle;
  }

  // Day-5 RAG SOTA — corpus reprocess worker. Runs alongside the legacy
  // embed worker; polls a different queue (corpus_reprocess_jobs) and runs
  // the full v2 pipeline (sanitize → narrative-chunk → contextual-gen →
  // embed → _insert_chunk_v2_unsafe). No-op if either INTERNAL_API_* env
  // is missing — legacy worker still handles v1 creators.
  if (GEMINI_API_KEY && INTERNAL_API_BASE_URL && INTERNAL_API_SECRET) {
    if (INTERNAL_API_SECRET.length < 32) {
      // eslint-disable-next-line no-console
      console.error('[boot] INTERNAL_API_SECRET < 32 chars — corpus reprocess worker DISABLED');
    } else {
      corpusReprocessWorker = makeCorpusReprocessWorker({
        supabase,
        geminiApiKey: GEMINI_API_KEY,
        internalApiBaseUrl: INTERNAL_API_BASE_URL,
        internalApiSecret: INTERNAL_API_SECRET,
        flyMachineId: BUILD,
      });
      corpusReprocessWorkerHandle = corpusReprocessWorker.install().handle;
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('[boot] INTERNAL_API_BASE_URL or INTERNAL_API_SECRET missing — corpus reprocess worker disabled (legacy embed-worker still active)');
  }
});

// Graceful shutdown — stop the reaper interval so node exits cleanly when the
// http server's connections drain. SIGTERM is what Fly sends on deploy.
//
// HUME_TTS_PLAN §8 audit C3 — `http.Server#close()` stops accepting new
// connections but does NOT close upgraded WebSockets. Without explicit WS
// drain, every in-flight voice session at deploy time gets hung up at the
// 30s backstop. We now send a `code=1012 (service_restart)` close to each
// open WS so the client side can reconnect/retry gracefully and any held
// state (cogs writes, session_close) drains via the existing teardown path.
function shutdown(signal) {
  console.log(`[shutdown] ${signal} — clearing reaper + delete workers + draining ${wss.clients.size} live WS sessions`);
  // Day-5-unit-audit C1: signal the reprocess worker BEFORE clearing
  // intervals so an in-flight 9-min tick can drain at the next checkpoint
  // (Flash done, unit boundary). The tick's finally block flushes cogs_log
  // for whatever was paid so far — no silent spend loss on deploys.
  if (corpusReprocessWorker) {
    try { corpusReprocessWorker.signalShutdown(); }
    catch (e) { console.error('[shutdown] signalShutdown failed', e); }
  }
  if (reaperHandle) clearInterval(reaperHandle);
  if (voiceDeleteHandle) clearInterval(voiceDeleteHandle);
  if (simliFaceDeleteHandle) clearInterval(simliFaceDeleteHandle);
  if (faceUploadReaperHandle) clearInterval(faceUploadReaperHandle);
  if (embedWorkerHandle) clearInterval(embedWorkerHandle);
  if (corpusReprocessWorkerHandle) clearInterval(corpusReprocessWorkerHandle);

  // HUME_TTS_PLAN §8 audit C3 — graceful WS drain. Send a user-visible
  // signal frame first so the client can show a reconnect notice, then
  // close with 1012 (service_restart per RFC 6455 — clients SHOULD retry).
  // The existing `ws.on('close', ...)` handler at index.js:1632-1634 fires
  // teardown → endSession → cogs flush, so no per-session cleanup needed
  // here. We just stop accepting new connections and drain.
  for (const client of wss.clients) {
    try {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: 'shutdown', code: 'service_restart', at: Date.now() }));
        client.close(1012, 'service_restart');
      }
    } catch (e) {
      console.error('[shutdown] WS drain error', e?.message || e);
    }
  }

  // Day-13 audit-build M2 — drain in-flight PostHog batches before
  // exiting so v2 telemetry isn't silently dropped on deploys. Bounded
  // grace = 1500ms (matches batch AbortController). Best-effort; if
  // PostHog is wedged we still exit.
  posthogDrainInFlight({ timeoutMs: 1500 })
    .then((r) => {
      if (!r.drained) {
        console.warn(`[shutdown] posthog drain incomplete (remaining=${r.remaining})`);
      }
    })
    .catch(() => {});

  server.close(() => process.exit(0));
  // Day-5-unit-audit C1: hard-exit backstop bumped 5s → 30s. The reprocess
  // worker's drain checkpoint + bumpFailure + cogs_log flush is ~1-3s on a
  // healthy network; the extended budget gives slow networks headroom
  // without unduly delaying clean deploys (typical deploy: server.close
  // exits within seconds, this timeout never fires).
  setTimeout(() => process.exit(0), 30_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
  captureException(e, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  captureException(e, { kind: 'uncaughtException' });
  // Give Sentry ~1s to flush before exit.
  setTimeout(() => process.exit(1), 1000);
});
