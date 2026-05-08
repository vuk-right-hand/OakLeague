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
//   4009 cartesia_no_voice       — useCartesia=true but creators.voice_id IS NULL
//   4010 model_not_compatible    — useCartesia=true with a non-allowlisted model
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
import { decideQuotaGate } from './quota-gate.js';
import { makeLogTurnCogs, installReaper, VOICE_CARTESIA_ENABLED, getCartesiaPricing } from './proxy-handlers.js';
import { makeVoiceDeleteWorker } from './voice-delete-worker.js';
import { makeSimliFaceDeleteWorker } from './simli-face-delete-worker.js';
import { makeFaceUploadReaper } from './face-upload-reaper.js';

const PORT = Number(process.env.PORT || 8080);
const BUILD = process.env.FLY_MACHINE_ID || 'local';

const SUPABASE_URL          = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY  = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_API_KEY        = requireEnv('GEMINI_API_KEY');
// CARTESIA_API_KEY is required only when VOICE_CARTESIA_ENABLED=1.
const CARTESIA_API_KEY      = process.env.CARTESIA_API_KEY || '';
// SIMLI_API_KEY drives the simli-face-delete-worker (R3-Missing-3).
// Optional — worker no-ops if absent. Set in Fly secrets when /s/[id]
// cutover ships.
const SIMLI_API_KEY         = process.env.SIMLI_API_KEY || '';
if (VOICE_CARTESIA_ENABLED) {
  if (!CARTESIA_API_KEY) {
    console.error('FATAL: CARTESIA_API_KEY missing while VOICE_CARTESIA_ENABLED=1');
    process.exit(1);
  }
  // Trip the pricing-env validator at boot so a missing rate is a hard fail.
  getCartesiaPricing();
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
  // reading its own env, so flipping VOICE_CARTESIA_ENABLED on Fly
  // alone propagates to the pre-WS gate at /api/sessions/open. Public
  // (no auth) but only exposes flags + version, no secrets.
  if (req.url === '/voice-config') {
    res.writeHead(200, {
      'content-type': 'application/json',
      // Cache control: short, so a Fly secret flip propagates within ~1m.
      'cache-control': 'public, max-age=30',
    });
    res.end(JSON.stringify({
      useCartesia: VOICE_CARTESIA_ENABLED,
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
    .select('user_id, creator_id, session_id, expected_tier, purpose, avatar_provider')
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
  const { data, error } = await q
    .select('id, tier_at_session, avatar_provider')
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

  return {
    sessionId: data.id,
    tier: data.tier_at_session,
    avatarProvider: data.avatar_provider ?? null,
    heygenSessionId,
    heygenSessionToken,
  };
}

async function openSession({ userId, creatorId, modelWire }) {
  const modelEnum = MODEL_TO_ENUM[modelWire];
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      creator_id: creatorId,
      model_used: modelEnum,
      tier_at_session: 'free', // overwritten by sessions_enforce_tier_and_kill_switch trigger
      status: 'starting',
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
  return { sessionId: data.id, tier: data.tier_at_session };
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

const { logTurnCogs, dropSession: dropCogsSession } = makeLogTurnCogs({
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
    sess = await openSession({ userId, creatorId, modelWire });
  }
  if (sess.err) { console.log(`[ws ${connId}] session err=${sess.err}`); }
  if (sess.err === 'session_already_active') return closeWs(ws, 4002, 'session_already_active');
  if (sess.err === 'kill_switch_fired')      return closeWs(ws, 4003, 'kill_switch_fired');
  if (sess.err === 'session_not_attachable') return closeWs(ws, 4001, 'session_not_attachable');
  if (sess.err === 'upstream_error')         return closeWs(ws, 4005, 'upstream_error');
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
  let cartesia = null;
  let closed = false;
  let lastHeartbeatAt = Date.now();
  let heartbeatInterval = null;
  let turnNumber = 0;
  let cartesiaTurnDead = false; // R3-M1 / R4-S1 — relay-loop gate for barge-in
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

  // R3-A8 / R4-S8 — snapshot the rollback flag and model gate ONCE per
  // session. No mid-session re-read.
  const useCartesia = VOICE_CARTESIA_ENABLED;

  const teardown = async (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatInterval);
    if (heygenHeartbeatInterval) clearInterval(heygenHeartbeatInterval);
    quotaCache.delete(sessionId);
    sessionToWs.delete(sessionId);
    wsRegistry.delete(sessionId);
    dropCogsSession(sessionId);
    // R4-M1 — null-check INSTANCES, not booleans. Either bridge may be
    // null if the open path bailed early.
    try { if (cartesia) await cartesia.close(); } catch {}
    try { if (bridge)   await bridge.close();   } catch {}
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

  // R4-M6 — model gate before any bridge instantiation when α' is on.
  if (useCartesia && !CARTESIA_COMPATIBLE_MODELS.has(modelWire)) {
    console.log(`[ws ${connId}] model_not_compatible_with_cartesia ${modelWire}`);
    await teardown('model_not_compatible_with_cartesia');
    return closeWs(ws, 4010, 'model_not_compatible');
  }

  // R3-Phase3 — voice id lookup. Fail-closed when α' is on but creator
  // hasn't been cloned yet.
  let creatorVoiceId = null;
  if (useCartesia) {
    try {
      const { data, error } = await supabase
        .from('creators')
        .select('voice_id')
        .eq('id', creatorId)
        .maybeSingle();
      if (error) throw error;
      creatorVoiceId = data?.voice_id || null;
    } catch (e) {
      console.error(`[ws ${connId}] voice-id-lookup`, e);
      captureException(e, { op: 'voice-id-lookup', sessionId, creatorId });
      await teardown('voice_id_lookup_failed');
      return closeWs(ws, 4005, 'upstream_error');
    }
    if (!creatorVoiceId) {
      console.log(`[ws ${connId}] cartesia_no_voice creator=${creatorId.slice(0,8)}`);
      await teardown('cartesia_no_voice');
      return closeWs(ws, 4009, 'cartesia_no_voice');
    }
  }

  // R3-C3 / R4-S8 — SERIAL open: Gemini first (it doesn't accept user
  // audio until 'ready' is sent), then Cartesia. If Cartesia rejects we
  // close Gemini before user-WS close to prevent token-bill leaks.
  try {
    bridge = new GeminiBridge({
      apiKey: GEMINI_API_KEY,
      enableOutputTranscription: useCartesia,
      discardAudioOut: useCartesia,
    });
    console.log(`[ws ${connId}] gemini.open start (cartesia=${useCartesia})`);
    const t0 = Date.now();
    await bridge.open({ model: modelWire, sessionId });
    console.log(`[ws ${connId}] gemini.open ok in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[ws ${connId}] gemini-open FAIL:`, e?.message || e);
    captureException(e, { op: 'bridge-open', connId, modelWire, sessionId });
    await teardown('bridge_open_failed');
    return closeWs(ws, 4005, 'upstream_error');
  }

  if (useCartesia) {
    try {
      // Per-session sample rate driven by the ticket's avatar_provider
      // (audit-r2 C1). Cartesia ships output_format.sample_rate per WS
      // init; mismatched cadence to the avatar pipeline = chipmunk-pitch
      // or hard-reject at the avatar's audio_buffer_appended.
      //   simli   → 16 kHz (Trinity-1 SDK requires PCM16 LE @ 16k)
      //   tavus   → 16 kHz (echo-mode parity with Simli)
      //   heygen  → 24 kHz (LiveAvatar Lite, PHASE_0_HEYGEN.md §6)
      // Legacy admin spike-a path (no ticketSessionId, no avatar_provider
      // because the ticket was minted before this column existed OR is a
      // voice_clone) defaults to 24 kHz so existing harness fixtures
      // stay green.
      let cartesiaSampleRate;
      if (consumed.avatarProvider === 'heygen') {
        cartesiaSampleRate = 24000;
      } else if (consumed.avatarProvider === 'simli' || consumed.avatarProvider === 'tavus') {
        cartesiaSampleRate = 16000;
      } else {
        // Fallback: legacy/admin paths. Preserve prior behavior:
        //   attach path with no avatar_provider → 16k (Simli inferred).
        //   spike-a (no session_id) → 24k (harness default).
        cartesiaSampleRate = isAttachPath ? 16000 : 24000;
      }
      cartesia = new CartesiaTTSBridge({
        apiKey: CARTESIA_API_KEY,
        voiceId: creatorVoiceId,
        sampleRate: cartesiaSampleRate,
      });
      const t0 = Date.now();
      await cartesia.open();
      console.log(`[ws ${connId}] cartesia.open ok in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error(`[ws ${connId}] cartesia-open FAIL:`, e?.message || e);
      captureException(e, { op: 'cartesia-open', connId, sessionId });
      // R3-C3 — close Gemini before user WS so it doesn't accept audio
      // for a session that can't synthesize.
      try { await bridge?.close(); } catch {}
      bridge = null;
      await teardown('cartesia_open_failed');
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

  ws.send(JSON.stringify({ type: 'ready', sessionId, build: BUILD, useCartesia }));

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

  // ── Gemini events ─────────────────────────────────────────────────────
  bridge.on((e) => {
    if (closed) return;
    if (e.kind === 'audio_out') {
      // R3-S3 — when α' is on the bridge already discards audio_out at
      // emit time (discardAudioOut:true). This branch is the rollback
      // path: Gemini's audio goes straight to the user.
      if (!useCartesia) sendBinaryWithBackpressure(e.chunk.bytes);
    } else if (e.kind === 'output_transcription_chunk') {
      // R3-C4 — pipe transcript text into Cartesia. Cartesia's
      // _turnDead flag drops the chunk if a barge-in already fired
      // synchronously. sendText is a no-op when bridge isn't open or
      // turn isn't started.
      if (useCartesia && cartesia) {
        try { cartesia.sendText(e.text); } catch (err) {
          captureException(err, { op: 'cartesia.sendText', sessionId });
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
    } else if (e.kind === 'turn_complete') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'turn_complete', at: e.at }));
    } else if (e.kind === 'interrupted') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'interrupted', at: e.at }));
    } else if (e.kind === 'error') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', at: e.at, message: e.message }));
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
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'upstream_closed', at: e.at, code: e.code, reason: e.reason }));
      teardown('upstream_closed').catch(() => {});
      closeWs(ws, 1011, 'upstream_closed');
    }
  });

  // ── Cartesia events ───────────────────────────────────────────────────
  if (useCartesia && cartesia) {
    cartesia.on((e) => {
      if (closed) return;
      if (e.kind === 'audio_out') {
        // R3-M1 / R4-S1 — relay-loop gate, in addition to the bridge's
        // own _turnDead check. Belt-and-suspenders against late chunks
        // from the WS receive buffer at cancel time.
        if (cartesiaTurnDead) return;
        sendBinaryWithBackpressure(e.chunk.bytes);
      } else if (e.kind === 'reconnected') {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts_reconnected', at: e.at }));
      } else if (e.kind === 'error') {
        // Diagnostic 2026-05-04 — surface Cartesia error details to Fly logs
        // (Sentry is no-op until SENTRY_DSN is wired). Without this we only
        // see `tts_failed` at the harness with no upstream cause.
        // Phase 0.5 (2026-05-07): include textSample so we can see what
        // Cartesia rejected.
        console.error(
          `[cartesia.error] code=${e.code} message=${e.message} fatal=${e.fatal} sample=${JSON.stringify((e.textSample || '').slice(0, 200))}`,
        );
        if (e.fatal) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', code: 'tts_failed', at: e.at, detail: e.code }));
          }
          captureException(new Error(`cartesia.${e.code}`), {
            op: 'cartesia.error',
            sessionId,
            cartesiaCode: e.code,
            detail: e.message,
            textSample: e.textSample,
          });
          teardown('tts_failed').catch(() => {});
          closeWs(ws, 1011, 'tts_failed');
        } else {
          // Phase 0.5 (2026-05-07). Recoverable per-turn rejection
          // ("Invalid transcript" et al). Bridge already killed the turn
          // locally (_turnDead=true, contextId nulled). Kill the relay-loop
          // gate so any in-flight Cartesia chunks for this dead turn are
          // dropped, send a silent warning to the client (no UI surface —
          // just telemetry), and continue. Next turn_start mints a fresh
          // context. Session stays alive; HeyGen WS stays open; user sees
          // no "avatar TTL expired" misleading message.
          cartesiaTurnDead = true;
          if (ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'warning', code: 'tts_chunk_rejected', at: e.at, detail: e.code }));
            } catch {}
          }
          captureException(new Error(`cartesia.${e.code}_recoverable`), {
            level: 'warning',
            op: 'cartesia.error_recoverable',
            sessionId,
            cartesiaCode: e.code,
            detail: e.message,
            textSample: e.textSample,
          });
        }
      } else if (e.kind === 'closed') {
        // Idle-window close handled by the bridge's auto-reconnect
        // (R3-M2 / R4-M2). No action required here.
      }
    });
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
      try { bridge.sendAudio({ bytes: data, mimeType: 'audio/pcm;rate=16000' }); }
      catch (e) {
        // Send-audio failures are usually a closed-mid-frame race (1000-close
        // workaround handles via lazy reopen on next turn_start). Keep the
        // error log: a sustained burst here means bridge_not_open in steady
        // state, which is a real bug.
        console.error(`[ws ${connId}] [send-audio] FAIL:`, e?.message || e);
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
        cartesiaTurnDead = false;
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
            console.log(`[ws ${connId}] gemini.reopen ok`);
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
        // R4-M2 / U-C5 — cartesia.turnStart can throw `tts_reconnecting`
        // synchronously when the bridge is in the auto-reconnect window.
        // Bridge auto-reconnect typically lands in 200–700ms; wait up to
        // 1500ms for `reconnected` before giving up so a single
        // unfortunately-timed tap doesn't kill the session.
        // Audit R3-C1 (logic) flagged a listener-attach race here;
        // verified false-positive. JS is single-threaded and
        // `cartesia.on(handler)` runs synchronously inside the Promise
        // constructor body BEFORE the await yields. The bridge needs
        // at least one `await` cycle (setTimeout 200ms) to reach
        // `emit('reconnected')`, which is well after the listener is
        // attached. No race in this execution model.
        if (useCartesia && cartesia) {
          let attempt = 0;
          while (attempt < 2) {
            try {
              cartesia.turnStart(`${sessionId}:${turnNumber}`);
              break; // success
            } catch (e) {
              if (e?.code === 'tts_reconnecting' && attempt === 0) {
                attempt += 1;
                // Wait for the bridge's `reconnected` event — single
                // listener with a 1500ms ceiling.
                const waited = await new Promise((resolve) => {
                  const to = setTimeout(() => { off(); resolve(false); }, 1500);
                  const off = cartesia.on((ev) => {
                    if (ev.kind === 'reconnected') { clearTimeout(to); off(); resolve(true); }
                    else if (ev.kind === 'error' && ev.fatal) { clearTimeout(to); off(); resolve(false); }
                  });
                });
                if (!waited) {
                  ws.send(JSON.stringify({ type: 'error', code: 'tts_reconnecting', op: 'turn_start' }));
                  await teardown('tts_reconnecting');
                  return closeWs(ws, 4011, 'tts_reconnecting');
                }
                continue; // retry turnStart now that we're reconnected
              }
              if (e?.code === 'tts_reconnecting') {
                // Second attempt also hit the window — give up.
                ws.send(JSON.stringify({ type: 'error', code: 'tts_reconnecting', op: 'turn_start' }));
                await teardown('tts_reconnecting');
                return closeWs(ws, 4011, 'tts_reconnecting');
              }
              // Anything else: tear down as upstream error.
              captureException(e, { op: 'cartesia.turnStart', sessionId });
              await teardown('cartesia_turn_start_failed');
              return closeWs(ws, 4005, 'upstream_error');
            }
          }
        }
      } else if (msg.type === 'turn_end') {
        const metrics = await bridge.turnEnd({ timeoutMs: msg.timeoutMs || 30_000 });
        let cartesiaMetrics = null;
        if (useCartesia && cartesia) {
          // R3-C1 / R4-C1 — always await; bridge resolves with partial:true
          // on timeout/error so logTurnCogs (and the Gemini legs) always
          // land. NEVER throw out of this path.
          // 10s default: Phase 0 measured cold-connect `done` ack at ~6s,
          // so 5s would flag partial:true on the steady state and break
          // dashboard gating on cartesia_partial.
          cartesiaMetrics = await cartesia.turnEnd({ timeoutMs: 10_000 });
        }
        // U-M6 — surface a user-facing warning when Cartesia returned
        // partial. Proxy already records cartesia_partial in metadata for
        // dashboard reconciliation; this lets the client UI show "(this
        // response was cut off — ask again)" instead of failing silent.
        if (cartesiaMetrics?.partial) {
          try {
            ws.send(JSON.stringify({
              type: 'warning',
              code: 'response_truncated',
              at: Date.now(),
              characters: cartesiaMetrics.characters,
            }));
          } catch {}
        }
        ws.send(JSON.stringify({ type: 'turn_end_ack', metrics, cartesia: cartesiaMetrics }));
        logTurnCogs({
          userId, sessionId, turnNumber,
          inputSeconds: metrics.inputSeconds,
          outputSeconds: metrics.outputSeconds,
          usageMetadata: metrics.usageMetadata,
          cartesia: cartesiaMetrics,
        }).catch((e) => {
          // R4-S3 fail-closed: getCartesiaPricing() throws if env is
          // missing/zero. The validator runs at module-load (proxy boot)
          // so this catch is dead in steady state — but a Fly secret
          // rotation that briefly clears the env between restarts would
          // surface here. L-M5: kept intentionally; not dead in practice.
          captureException(e, { op: 'logTurnCogs', sessionId, fatal: true });
          ws.send(JSON.stringify({ type: 'error', code: 'cogs_misconfig', op: 'turn_end' }));
          teardown('cogs_misconfig').catch(() => {});
          closeWs(ws, 1011, 'cogs_misconfig');
        });
        // R4-C1 — quota math: when α' is on, sum mic seconds + REAL
        // Cartesia audio seconds. L-C2 fix: when Cartesia returns
        // `partial:true` (hang/timeout/error mid-turn), fall back to
        // Gemini's `outputSeconds` so the kill-switch still sees real
        // assistant-talk seconds. Without this fallback a runaway turn
        // that hung Cartesia would bill ZERO assistant seconds and
        // never trip the latch — the user could burn the daily char
        // cap while seconds_used ticks at 1× mic only.
        let quotaSeconds;
        if (useCartesia) {
          if (cartesiaMetrics?.partial) {
            // Trust Gemini's audio-out length as the assistant-talk
            // proxy. Slightly over-bills (Cartesia would have been
            // shorter or longer) but never under-bills.
            quotaSeconds = (metrics.inputSeconds || 0) + (metrics.outputSeconds || 0);
          } else {
            quotaSeconds = (metrics.inputSeconds || 0) + ((cartesiaMetrics?.audioSeconds) || 0);
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
        // 20260428000002 §"WHY seconds as the currency"). When useCartesia,
        // cartesiaMetrics.audioSeconds is the truth — even on partial:true
        // it reports delivered audio bytes / sample rate, so it accurately
        // captures the partial-delivered seconds. We DO NOT fall back to
        // Gemini's outputSeconds on Cartesia partial (audit C1): outputSeconds
        // is the DISCARDED Gemini audio in Pipeline α' — billing the user
        // for audio they never heard would create support tickets. System
        // A's quotaSeconds above intentionally over-bills on partial as a
        // kill-switch safety; System B is the user-facing cap contract
        // and must under-bill on uncertainty.
        //
        // Without this write, voice_usage_ticket_check at /api/sessions/open
        // reads counters always at 0 → returns full remaining → 5min/15min
        // cap never enforces.
        //
        // M1: dropped the `> 0` guard so zero-second turns still write the
        // idempotency row. voice_usage_turns is the per-turn audit ledger;
        // a missing row would mean a duplicate turn-end retry could re-claim.
        //
        // M2 follow-up: on R4-C1 WS-eviction the new WS reuses sessionId
        // but starts turnNumber=0 → PK collision with the evicted WS's
        // entries silently drops counter increments via ON CONFLICT DO
        // NOTHING. Rare in practice (user opens second tab during own
        // session). Tracked as Phase C punch-list item; fix is a
        // MAX(turn_number)+1 lookup on connection setup.
        let assistantSeconds;
        if (useCartesia) {
          assistantSeconds = cartesiaMetrics?.audioSeconds || 0;
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
        // R3-M1 / R4-S1 — set the relay-loop flag SYNCHRONOUSLY before
        // any await, then ws-send cancel to Cartesia. Bridge.cancel
        // also sets its own flag synchronously.
        cartesiaTurnDead = true;
        bridge.cancel();
        if (useCartesia && cartesia) cartesia.cancel();
      }
    } catch (e) {
      console.error('[control]', msg?.type, e);
      ws.send(JSON.stringify({ type: 'error', message: e.message, op: msg?.type }));
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`voice-proxy listening on :${PORT} (build=${BUILD})`);
  // Reaper: 20s cadence + 60s threshold (RPC default). Fires once at boot for
  // proxy-crash recovery, then every 20s. See plan §1B.
  reaperHandle = installReaper({ supabase }).handle;
  // R4-M3 — voice-delete worker (Cartesia DELETE /voices deferred queue).
  // Only when α' is enabled; otherwise no rows are ever enqueued.
  if (VOICE_CARTESIA_ENABLED && CARTESIA_API_KEY) {
    voiceDeleteHandle = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: CARTESIA_API_KEY })
      .install().handle;
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
});

// Graceful shutdown — stop the reaper interval so node exits cleanly when the
// http server's connections drain. SIGTERM is what Fly sends on deploy.
function shutdown(signal) {
  console.log(`[shutdown] ${signal} — clearing reaper + delete workers`);
  if (reaperHandle) clearInterval(reaperHandle);
  if (voiceDeleteHandle) clearInterval(voiceDeleteHandle);
  if (simliFaceDeleteHandle) clearInterval(simliFaceDeleteHandle);
  if (faceUploadReaperHandle) clearInterval(faceUploadReaperHandle);
  server.close(() => process.exit(0));
  // Hard-exit after 5s if connections won't drain.
  setTimeout(() => process.exit(0), 5000).unref();
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
