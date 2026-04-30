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
//   4005 upstream_error          — GeminiBridge open failed
//   4006 quota_state_inconsistent — P0002 from voice_check_quota (turn_start) or
//                                    voice_accumulate_seconds (turn_end) — missing daily_quotas row
//   1008 quota_exceeded          — kill-switch or degraded-and-unknown at turn_start
//   1011 internal_error          — unhandled
//   1000 normal_closure          — client initiated

// Sentry must init before any other import can throw to be useful; side-effect only.
import './sentry.js';
import { captureException } from './sentry.js';

import http from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { GeminiBridge } from './gemini-bridge.js';
import { decideQuotaGate } from './quota-gate.js';
import { makeLogTurnCogs, installReaper } from './proxy-handlers.js';

const PORT = Number(process.env.PORT || 8080);
const BUILD = process.env.FLY_MACHINE_ID || 'local';

const SUPABASE_URL          = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY  = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_API_KEY        = requireEnv('GEMINI_API_KEY');

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
  res.writeHead(404);
  res.end();
});

// ── Ticket consume + session insert ─────────────────────────────────────

async function consumeTicket(ticketId, uaHash) {
  // Atomic single-use consume — see plan §Ticket-based WS auth. service-role
  // bypasses RLS so the RETURNING clause reflects only the row this UPDATE
  // won (Postgres UPDATE is atomic per-row).
  const { data, error } = await supabase
    .from('voice_tickets')
    .update({ consumed_at: new Date().toISOString() })
    .eq('ticket_id', ticketId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .eq('bound_ua_hash', uaHash)
    .select('user_id, creator_id')
    .maybeSingle();
  if (error || !data) return null;
  // creator_id is NOT NULL by CHECK on new rows (migration 0041). A null here
  // means a pre-migration ticket leaked in — refuse rather than guess.
  if (!data.creator_id) return null;
  return { userId: data.user_id, creatorId: data.creator_id };
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
  const { userId, creatorId } = consumed;
  console.log(`[ws ${connId}] ticket ok user=${userId.slice(0,8)} creator=${creatorId.slice(0,8)}`);

  const sess = await openSession({ userId, creatorId, modelWire });
  if (sess.err) { console.log(`[ws ${connId}] session err=${sess.err}`); }
  if (sess.err === 'session_already_active') return closeWs(ws, 4002, 'session_already_active');
  if (sess.err === 'kill_switch_fired')      return closeWs(ws, 4003, 'kill_switch_fired');
  if (sess.err === 'upstream_error')         return closeWs(ws, 4005, 'upstream_error');
  const sessionId = sess.sessionId;
  console.log(`[ws ${connId}] session ok id=${sessionId.slice(0,8)}`);
  sessionToWs.set(sessionId, ws);

  let bridge = null;
  let closed = false;
  let lastHeartbeatAt = Date.now();
  let heartbeatInterval = null;
  // Per-session monotonic turn counter for cogs_insert_turn_voice idempotency
  // key (session_id, turn_number, service, operation). Increments on each
  // turn_start; the same value is passed to logTurnCogs at the matching
  // turn_end.
  let turnNumber = 0;

  const teardown = async (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatInterval);
    quotaCache.delete(sessionId);
    sessionToWs.delete(sessionId);
    dropCogsSession(sessionId);
    try { await bridge?.close(); } catch {}
    await endSession(sessionId, reason);
  };

  try {
    bridge = new GeminiBridge({ apiKey: GEMINI_API_KEY });
    console.log(`[ws ${connId}] bridge.open start`);
    const bridgeT0 = Date.now();
    await bridge.open({ model: modelWire, sessionId });
    console.log(`[ws ${connId}] bridge.open ok in ${Date.now() - bridgeT0}ms`);
  } catch (e) {
    console.error(`[ws ${connId}] bridge-open FAIL:`, e?.message || e);
    captureException(e, { op: 'bridge-open', connId, modelWire, sessionId });
    await teardown('bridge_open_failed');
    return closeWs(ws, 4005, 'upstream_error');
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

  ws.send(JSON.stringify({ type: 'ready', sessionId, build: BUILD }));

  // Bridge → client audio + turn events
  bridge.on((e) => {
    if (closed) return;
    if (e.kind === 'audio_out') {
      if (ws.readyState === ws.OPEN) ws.send(e.chunk.bytes, { binary: true });
    } else if (e.kind === 'turn_complete') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'turn_complete', at: e.at }));
    } else if (e.kind === 'interrupted') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'interrupted', at: e.at }));
    } else if (e.kind === 'error') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', at: e.at, message: e.message }));
    } else if (e.kind === 'closed') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'upstream_closed', at: e.at, code: e.code, reason: e.reason }));
      teardown('upstream_closed').catch(() => {});
      closeWs(ws, 1011, 'upstream_closed');
    }
  });

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
      catch (e) { console.error('[send-audio]', e); }
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
          // B1: fatal at turn_start uses the same distinct close code as
          // fatal at turn_end so the client can distinguish "you're over
          // quota" (1008) from "your quota row is gone" (4006).
          const closeCode = gate.fatal ? 4006 : 1008;
          return closeWs(ws, closeCode, gate.reason);
        }
        turnNumber += 1;
        bridge.turnStart();
      } else if (msg.type === 'turn_end') {
        const metrics = await bridge.turnEnd({ timeoutMs: msg.timeoutMs || 30_000 });
        ws.send(JSON.stringify({ type: 'turn_end_ack', metrics }));
        logTurnCogs({
          userId, sessionId, turnNumber,
          inputSeconds: metrics.inputSeconds,
          outputSeconds: metrics.outputSeconds,
          usageMetadata: metrics.usageMetadata,
        }).catch(() => {});
        // Quota accumulate: normally fire-and-forget (latch trigger handles
        // 150% crossing), but a fatal P0002 means daily_quotas row is gone
        // and we must tear down with a distinct WS code (4006) so the
        // client can surface a real error instead of a silent free-turn leak.
        accumulateSeconds(sessionId, (metrics.inputSeconds || 0) + (metrics.outputSeconds || 0))
          .then(async (res) => {
            if (res?.fatal) {
              ws.send(JSON.stringify({ type: 'error', code: res.reason, op: 'turn_end' }));
              await teardown(res.reason);
              closeWs(ws, 4006, res.reason);
            }
          })
          .catch(() => {});
      } else if (msg.type === 'cancel') {
        bridge.cancel();
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`voice-proxy listening on :${PORT} (build=${BUILD})`);
  // Reaper: 20s cadence + 60s threshold (RPC default). Fires once at boot for
  // proxy-crash recovery, then every 20s. See plan §1B.
  reaperHandle = installReaper({ supabase }).handle;
});

// Graceful shutdown — stop the reaper interval so node exits cleanly when the
// http server's connections drain. SIGTERM is what Fly sends on deploy.
function shutdown(signal) {
  console.log(`[shutdown] ${signal} — clearing reaper`);
  if (reaperHandle) clearInterval(reaperHandle);
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
