Spike A v2 Build Audit — Summary
The auditor found real holes. The spike measurement is valid, but production posture is weaker than the docs suggest. Here's the triage:

Critical (ship blockers) — 5
C1. Kill-switch is dead in the proxy path.
server/voice-proxy/index.js:145-165 writes cogs_log but never increments daily_quotas.seconds_used or inserts session_turns. The 150% latch trigger cannot fire. src/lib/voice/kill-switch.ts assertWithinQuota() exists but has zero callers. Violates CLAUDE.md hard rule. A runaway client burns the Gemini budget with impunity.

C2. cogs_insert_turn RPC takes caller-supplied p_user_id as SECURITY DEFINER.
supabase/migrations/20260421000001_voice_spike_cogs_fields.sql. Defended today by REVOKE EXECUTE FROM PUBLIC, but one future migration that does GRANT EXECUTE ON ALL FUNCTIONS opens a cross-user write primitive — any user could DoS another by pushing them past the kill-switch. Fix: add IF p_user_id <> auth.uid() THEN RAISE guard inside the function.

C3. Hardcoded-founder pattern in proxy.
server/voice-proxy/index.js:97-108 pickSpikeCreatorId() = "first creator by created_at". Comment literally says "Vuk is Creator #1." CLAUDE.md bans this. When creator #2 onboards, every WS session still routes to Vuk. Fix: pass creator_id at ticket-mint time, store on voice_tickets row.

C4. Three live code paths use the dead model ID gemini-live-2.5-flash-native-audio.
src/app/api/voice/ephemeral-token/route.ts:11, src/app/api/voice/spike-a/record/route.ts:11, src/app/admin/spike-a/spike-client.tsx:6. .claude_learnings.md:55 declared this string dead. Your "keep 2.5 as emergency fallback" escape hatch is broken on the direct path — it only works via the proxy. Replace with gemini-2.5-flash-native-audio-preview-12-2025.

C5. Proxy has zero Sentry instrumentation.
server/voice-proxy/index.js — grep Sentry → 0 hits. Plan mandated it in Phase 1 + §Architecture + §Security. When the proxy crashes during the YC demo, you have Fly console logs (ephemeral, flushed on auto-stop) and nothing else. Also means the ticket-scrub regex isn't applied on the proxy side — logged errors could leak tickets.

Medium (should-fix before broader use) — 10
M1. record + ephemeral-token routes don't honor x-forwarded-host in same-origin check. ngrok path already bit us once (.claude_learnings.md:98). Ticket route was fixed; these two weren't.
M2. Direct-path record route:79-94 never sets environment='spike_a'. Spike rows pollute production dashboards.
M3. ticket/route.ts:58-64 returns generic 500 ticket_mint_failed — no distinguishing DB pool exhaustion from service-role revocation at 2am.
M4. mic-processor.js decimation has a sample-dropping bug: this._carry logic drops sample 0 every block when input=128, causing slow phase drift. May explain some of Voicer's reported regression.
M5. The AudioWorklet is dead code for the spike — both harnesses send 1-second chunks, not 40ms. Phase 2-4 TTFA numbers were measured on 1s chunks, not the 40ms real-time path production will use. Either wire the worklet now or document the caveat.
M6. voice_tickets grows unbounded — no cleanup of consumed/expired rows. Also no rate limit on ticket mint.
M7. Two different operation strings for the same event (voice_audio_input_seconds vs spike_a_live_audio_input_seconds). COGS dashboards break.
M8. gemini-bridge.js:136-139 PRICE_USD_PER_SEC is folklore-derived (~50 tokens/sec audio — not documented by Google). At 10k MAU that's a 2-10x COGS misreport risk. Use usageMetadata from Live responses.
M9. Proxy never calls assertWithinQuota(userId) at turn_start. Related to C1.
M10. Heartbeat writes to sessions on every 20s pong — 50 writes/sec at 1k concurrent. Fine for spike, flag for Day 8.
Small — 13 nits
Dead stale comments, fly.toml auto_stop + min_machines_running=1 contradiction, .env.example missing NEXT_PUBLIC_VOICE_PROXY_URL wss-vs-https note, Dockerfile COPY will miss the next file added, duplicate systemInstruction between mint + client, kill-switch UTC vs user-local tz comment drift, etc.

Auditor's top-line verdict
"The demo will work; a second admin, a deleted user, a quota-breach, or a Sentry incident will not."

My recommendation on priority
Before YC demo (must-fix):

C4 (dead model ID) — 10 minutes, three string replacements. Without this your "2.5 fallback" doesn't actually work on the direct path.
C5 (Sentry on proxy) — 30-45 minutes. If anything breaks during demo you need observability.
M1 (x-forwarded-host on record + ephemeral-token routes) — 5 minutes each, same pattern as ticket route.
Before broader/external use (Day 5-8):

C1 + M9 (wire kill-switch writes + assertWithinQuota calls) — the structural fix, ~1-2 hours
C2 (RPC guard) — 10 minutes
C3 (creator_id on ticket, not hardcoded pick) — ~1 hour; also unblocks testing any creator
M2, M7 (COGS environment + operation consistency) — 15 minutes
M8 (real pricing from usageMetadata) — ~1 hour
Day 5+ (production voice path work anyway):

M4, M5 (worklet FIR + wire it to real path) — the 40ms streaming path is production work per CLAUDE.md
Day 8+ (prod hardening):

M6, M10, smalls
Want me to do the pre-demo fixes (C4, C5, M1) now?


Blockers (must fix before running SQL against Supabase)
authenticated and anon still have EXECUTE on the new RPCs — REVOKE FROM public doesn't strip the role-specific grants Supabase auto-adds. Any logged-in user can call voice_accumulate_seconds against another user's session and kill their quota. Fix: REVOKE FROM public, anon, authenticated on all three RPCs (check + accumulate + reap_stale_sessions, and also cogs_insert_turn). This is the same pattern already used in migrations 0035-0037.

The cogs_insert_turn edit will never reach production — migration 0040 was already applied, and re-running a CREATE FUNCTION fails. The auth.uid() guard sits in the repo while production runs the unguarded version. Fix: move that change into a new migration 20260421000004_cogs_insert_turn_caller_guard.sql with CREATE OR REPLACE FUNCTION.

usageMetadata double-counting in gemini-bridge — promptTokenCount is cumulative conversation history, not per-message delta. Summing across streamed chunks inflates by 5–10×. Not an SQL issue, but it's the token source that Day-8 COGS will key off. Fix: take the last value (or capture only on turnComplete), not the sum.

checkQuotaOk fails open on Supabase error — a kill-switched user keeps spending during any Supabase brownout because the check allows-by-default and accumulate silently swallows. Fix: fail-closed after first successful check, or keep a per-session cache of last-known state.

accumulateSeconds P0002 comment lies — says "loud so we notice" but the proxy catches and swallows. Either make the RPC upsert, or promote the error to Sentry fatal + WS close.

Material but deferrable (M-tier)
ON DELETE CASCADE on voice_tickets.creator_id and sessions.creator_id — admin deleting a creator nukes live sessions mid-flight. Should be RESTRICT.
CEIL(p_seconds) turns 0.1s into 1s — 10× inflation for barge-in-heavy sessions.
Heartbeat UPDATE every 20s will hit row-lock contention at YC-demo scale.
Recommended order
Fix the 5 Critical items in code (3 SQL edits + 2 proxy edits).
Re-audit just the deltas (quick — scoped to the 5 fixes).
Then apply migrations (0040 stays as-is, apply 0041, 0042, new 0043) + redeploy proxy.
Want me to apply the 5 Critical fixes now?


Auditor says HOLD — 5 Blockers and a handful of Should-Fixes. Summary of what can actually bite us:

BLOCKERS (must fix before db push):

B1 — voice_check_quota kill-switch bypass on first turn. NOT FOUND branch returns {0, 0, null, false} which the gate reads as "safe" → first turn runs, gets billed, then voice_accumulate_seconds raises P0002. Also poisons quotaCache.healthy so subsequent degraded-RPC calls trust a fake "safe" snapshot. Fix: NOT FOUND must raise P0002 too, and checkQuotaOk must treat it as fatal → close 4006 at turn_start (symmetric with turn_end path).

B2 — cogs_insert_turn accepts self-attributed writes. Guard only blocks cross-user forgery, but p_input_cost / p_output_cost are client-supplied. If EXECUTE ever leaks to authenticated, user can spray arbitrary fake cost rows into cogs_log (append-only → permanent). Fix: non-service-role → unconditional deny. REVOKE + unconditional deny = true defense-in-depth.

B3 — voice_accumulate_seconds has zero caller guard. Asymmetric with cogs_insert_turn. If EXECUTE leaks, anyone logged in can call voice_accumulate_seconds(<victim_session_id>, 3600) and instantly latch their kill-switch. Fix: same service-role gate as cogs_insert_turn, applied to both voice RPCs.

B4 — Smoke-test the JWT path before push. Not a code bug, a gate: confirm supabase-js service-role client actually satisfies request.jwt.claims->>'role' = 'service_role' against the new guard. If not, proxy can't log any COGS.

B5 — endSession swallows errors silently, no Sentry. If that UPDATE fails, session sits ended_at=NULL for up to 90s → user hits 4002 session_already_active on reconnect. Fix: captureException + .select('id').single() so "0 rows affected" surfaces.

Plus worth-folding-in Should-Fixes:

M4 — harness turn_complete timeout (23s) < proxy bridge timeout (30s) → mislabels slow-but-valid Gemini turns as TIMEOUT. Bump harness to 35s.
M6 — status='active' UPDATE has no error handling; if it fails, row is stuck in 'starting'. Add try/capture.
Proposed fix plan
New migration 0005_voice_rpc_caller_guards.sql:

CREATE OR REPLACE voice_check_quota — raise P0002 on NOT FOUND + add service-role-only caller guard
CREATE OR REPLACE voice_accumulate_seconds — add service-role-only caller guard
CREATE OR REPLACE cogs_insert_turn — switch non-service-role path to unconditional deny
Proxy changes (index.js):

checkQuotaOk — detect P0002 / quota_row_missing → return { ok: false, fatal: true, reason: 'quota_state_inconsistent' }
turn_start callsite — if gate.fatal, close 4006 (same code as turn_end P0002 path)
endSession — capture to Sentry, use .select('id').single() so 0-rows surfaces
line 327 status='active' UPDATE — try/capture + Sentry on failure
Harness (proxy-client.tsx):

TURN_COMPLETE_TIMEOUT_MS: 8000 → 20000 (so total = 35s > proxy's 30s)
Quota-gate pure function (quota-gate.js):

Propagate the new fatal flag through gate so callers can distinguish "deny" from "deny and teardown with 4006"
Tests:

Add 2 quota-gate tests: RPC raises P0002 → gate.fatal=true; RPC raises P0002 then later recovers → cache recovers healthy.
B4 smoke test: I'll add a 10-line script scripts/spike-a-verify-guard.mjs that calls cogs_insert_turn via the service-role client against staging before you db push 0005 to prod — catches JWT-path regressions.

Want me to execute the whole plan, or carve out pieces?