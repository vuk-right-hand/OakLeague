# Fish Audio Phase 1 — TTS Bridge in Coexist Mode

**Status:** draft v4 (rounds 1+2+3 applied — APPROVED FOR EXECUTION) · **Created:** 2026-05-28 · **Owner:** Vuk + Claude

---

## 1. Context & Decisions (locked)

**Phase 0 verdict (2026-05-28):** Quality A/B passed "exactly him" bar on all 8 single-shot HTTP samples. Vuk: *"BANANAS."* **Multi-turn voice consistency UNTESTED — added as Phase 0.5 #7 (round 3 C3).**

**Cost lever:** Fish $15/M UTF-8 bytes vs Cartesia Pro ~$50/M chars → ~56% total session COGS reduction → ~$18M/yr at 1M DAU.

**BATNA:** [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) SOTA open-source. Credible self-host fallback.

**Scope decisions (Vuk 2026-05-28):**
1. **Coexist.** Fish joins Cartesia + Hume behind `creators.tts_provider` enum.
2. **Fish default for new creators** after end-to-end validation; UI dropdown removed eventually.
3. **No migration concern** — Vuk is only prod creator.
4. **NEW (round 3 C4):** **Per-turn auto-fallback to Cartesia on Fish errors IS IN SCOPE for Phase 1**, not deferred. Cartesia stays warm in coexist mode for exactly this safety-net use.

---

## 2. Verified Wire Protocol

Sources: [Fish WS spec](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live.md) · [AsyncAPI](https://docs.fish.audio/api-reference/asyncapi.yml) · [TS SDK source](https://github.com/fishaudio/fish-audio-typescript/blob/main/src/client/websocket/connection.ts).

**Connection:** `wss://api.fish.audio/v1/tts/live` · Headers: `Authorization: Bearer <FISH_API_KEY>` + `model: s2-pro` · **`perMessageDeflate: false`** (DEFLATE corrupts msgpack).

**Encoding:** `@msgpack/msgpack` v3 BOTH directions. Decode via byteOffset-aware `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)`.

**Client → Server events:** `start` · `text` · `flush` (no-op in v4 — see §3 #4) · `stop`.

**Server → Client events:** `audio` · `finish` (`reason: stop|error`).

**Cancel/interrupt:** NO protocol-level cancel. Only `ws.close()`.

**Reconnect:** None. Per-turn WS.

**Cartesia-context-coupling problem (round 1 C3):** Cutoff fix (`e5cf446`) is Cartesia-context-coupled. v4: `fish_bridge.flush()` is a NO-OP CONSTANT (no env gate, round 2 C4). Orchestrator branches on provider; Fish path lets `stop`-event drain naturally. Finalize timeout for Fish is **TBD post-Phase-0.5 #6 measurement** (round 3 C1) — was 5s in v3 plan, that's wrong without data.

---

## 3. Phase 0.5 — Empirical Wire Spike (RESULTS LANDED 2026-06-05)

**Spike ran 2026-06-05 · ~$0.03 actual spend · all 7 automated claims passed/failed cleanly. Claim 8 deferred to manual.**

### Measured results

| Claim | Result | Decision |
|---|---|---|
| **1. PCM 16kHz works** | ✅ WORKS. 4 chunks, 108KB, ~3.39s audio for 47 chars. | **No resampler. -1d effort.** |
| **2a. TTFA cold** | p50 **1086ms**, p99 **1233ms** (20 trials) | Significantly slower than Cartesia (~90ms). Speculative pre-open MANDATORY. |
| **2b. TTFA close-reopen** | p50 1114ms, p99 1229ms | Reopen ≈ cold (no extra cost). Pre-open at user-turn-start (parallel with brain) is the lever. |
| **2c. TTFA barge-reopen** | p50 1117ms, p99 1257ms | Barge mid-synth + reopen ≈ cold reopen. |
| **3. Audio chunk cadence** | **3.33× realtime fire-hose** (6 chunks, 10.22s of audio in 3.07s) | Same as Cartesia. Inherit Simli queue depth. No new work. |
| **4. Post-flush continuation** | ✅ **WORKS**. Audio bytes BEFORE flush = 0 (flush is what triggers synth), AFTER flush = 598KB; second text batch produced more audio on same WS. | Flush is a real primitive on Fish. v4 ships it as no-op for safety; future PR can enable. |
| **5. Concurrent dispatch** | 2 concurrent: ✅ both OK. 6 concurrent: 5 succeed, 6th returns **HTTP 429** cleanly. | Starter tier = 5 concurrent confirmed. Prepay $100 → Elevated 15 before prod scaling. |
| **6. Long-answer drain (767 chars input, 45.48s audio output)** | `stop` → last_audio = **16,824ms**; `stop` → `finish` = **16,824ms** (same — `finish` arrives immediately after last audio). | **`ttsFinalizeTimeoutMs = 34000`** (script-recommended p99 × 2). v4's "floor 30s" rule honored. |
| **7. Multi-turn voice consistency** | 6 WAV files in `tmp/fish-multi-turn/turn-01..06.wav`. Vuk-ear judgment pending. | **BLOCKING on Vuk's listen.** If drift audible, lower `temperature` 0.7 → 0.4-0.5 + investigate `seed` param. |
| **8. DELETE idempotency** | Deferred — requires throwaway voice ID; manual curl steps documented in results file. | Verify during Phase 1 implementation of voice-delete-worker. |

### Headline UX implications

1. **Fish adds ~1 second of TTFA per turn-start vs Cartesia.** Brain time (~500ms-2s) + Fish TTFA (~1s) = 1.5-3s tap-to-voice vs Cartesia's 0.5-2s. **~30-50% perceptible delay**. Mitigated by speculative pre-open (overlap WS+start with brain processing) — bringing it down to ~700-900ms residual.
2. **Long-answer drain is real and CONFIRMS v3 plan's 5s timeout was wrong** (would have re-introduced the cutoff bug). 34s timeout shipped.
3. **No resampler needed** — kills the +1-2d concern.
4. **Post-flush works** — flush is no-op in Phase 1 for safety, but enable-flush is a real future optimization.

### Spike script
[`scripts/fish-audio-ws-spike.mjs`](../../scripts/fish-audio-ws-spike.mjs) — kept in tree. Full numbers in `tmp/fish-phase-0.5-results.md`.

### Listening test for claim 7
Multi-turn samples served via [`scripts/serve-fish-spike.mjs`](../../scripts/serve-fish-spike.mjs) at `http://localhost:8765/multi` (extended to serve both Phase 0 single-shot + Phase 0.5 multi-turn samples for A/B against memory of Vuk's voice).

---

## 3a. Original 8 claims (for reference)

(Compressed — see commit history for full original. All claims have measured results above.)

| # | Claim | Method | Decision impact |
|---|---|---|---|
| 1 | **PCM 16kHz output works** | `start` with `format:"pcm", sample_rate:16000, latency:"low"`; validate first chunk: 32000 bytes/sec PCM16-LE. Also measure proxy CPU steady-state at concurrent dispatch. | FAILS → resampler required. WASM (`@alexanderolsen/libsamplerate-js`) vs hand-rolled FIR; benchmark both; budget: ≤30ms p99 per chunk on `shared-cpu-1x`. Layer: in-bridge per-chunk (preferred) vs user-WS relay. **Ship-gate (round 3 M4):** total first-audio-to-user latency ≤ 250ms; if resampler push us over, block flip and either fly-cpu upgrade or FIR-polyphase. |
| 2 | **TTFA: WS open → first audio (20 trials each, round 3 S1)** | Three sub-trials, 20 each: (a) cold (fresh WS); (b) close-then-reopen immediately (round 3 C2 — barge case); (c) barge mid-synth at T=2s, reopen, measure. `latency:"low"`. Report p50/p99 for each. | Target cold p50 ≤300ms. If reopen p99 > 600ms: **speculative pre-open is REQUIRED (not optional)** — open WS at user-turn-start, hold idle, send `start` when brain has first chunk. |
| 3 | **Audio chunk cadence** | Log timestamps + sizes over 60-char text; rate vs realtime. | Informational; informs Simli queue expectation. |
| 4 | **Post-flush continuation** | After `start` + text + `flush`, send MORE `text`. Does second synth happen on same WS, or does flush implicitly finalize? | **v4 default: flush stays no-op forever.** If verified safe, SEPARATE followup PR enables (no env gate). |
| 5 | **Concurrent dispatch under Starter tier** | Open 2 simultaneous WS in test; verify 5-concurrent limit; check rate-limit error shape. | Confirms $5 prepay supports integration tests without 429s. |
| 6 | **Long-answer drain time (round 3 C1)** | Synthesize 1500-char input (~3 paragraphs Vuk-style), send `stop`, measure p50/p99 of: `stop` sent → last `audio` event → `finish` event. | **Sets `ttsFinalizeTimeoutMs`. Use p99 × 2, floor 30s.** Critical — without this Fish re-introduces the cutoff bug under a new wrapper. |
| 7 | **Multi-turn voice consistency (round 3 C3)** | Open 6 sequential WS (each = independent "turn"), synth a varied set of sentences using Vuk's clone. Save to `tmp/fish-multi-turn/` with the existing serve-fish-spike.mjs A/B server pattern for back-to-back listening. | If audible drift between turns (pitch / energy / cadence): lower `temperature` 0.7 → 0.4-0.5; check if Fish supports a `seed` parameter (verify in spec). If still drifts: **stop and re-evaluate** — voice consistency is the moat. |
| 8 | **DELETE idempotency for GDPR (round 3 M6)** | Clone a throwaway voice via dashboard, take `reference_id`. Call `DELETE /model/{id}` → expect 200/204. Call again → expect 404 (not 401/403). Document exact status-code shapes. | Verifies the voice-delete-worker's "200 or 404 = success" assumption in §4 M4. |

**Spike script:** `scripts/fish-audio-ws-spike.mjs` (kept in tree). Results landed into this §3.

**Serve script preserved (round 2 S4 + round 3 S4):** `scripts/serve-fish-spike.mjs` extended to also serve multi-turn samples for claim #7's A/B listening, AND repurposed for soft-launch comparison (round 3 M2).

---

## 4. Schema (Migrations — Strict Order)

**M1 — Widen `public.tts_provider` enum** · `20260608100001_tts_provider_enum_add_fish.sql`
```sql
ALTER TYPE public.tts_provider ADD VALUE IF NOT EXISTS 'fish';
NOTIFY pgrst, 'reload schema';
```

**M2 — Widen `public.cogs_service` enum** · `20260608100002_cogs_service_enum_add_fish.sql`
Same shape, own tx, ends with `NOTIFY pgrst, 'reload schema'`.

**M3 — `cogs_insert_turn_voice_v3` + v2-shim forwards to v3 + v1 rewrite** · `20260608100003_cogs_insert_turn_voice_v3.sql`

Schema audit round 1 + 2 fixes baked in:
1. **Pre-flight DO block (round 1 M6).** Asserts no active sessions have NULL `tts_provider_at_session`. If any do, M3 fails fast with an operator-readable backfill instruction.
2. **`CREATE OR REPLACE FUNCTION` for v3 (round 1 C1)** so a partial M3 apply (e.g. v3 created, v2-shim CREATE OR REPLACE hit a transient lock) can be re-run idempotently.
3. **v3 body widens gate to `('cartesia','hume','fish')`** and adds `coalesce(p_metadata, '{}'::jsonb)` (round 1 C2 — closes NULL-metadata bug v2 silently inherited).
4. **v3 body RAISES on NULL `tts_provider_at_session` (round 1 M6).** Closes the v2 "= cartesia by construction" escape that no longer holds post-Hume/post-Fish.
5. **Explicit `GRANT EXECUTE ... TO service_role` after REVOKE (round 1 M7).**
6. **v2 body becomes `PERFORM v3(...)`** (CREATE OR REPLACE — catalog-update-on-commit so in-flight v2 calls execute against the OLD body before the new body becomes visible. No mid-call splice).
7. **v1 body REWRITTEN (round 1 C3 + round 2 M3).** Reads `sessions.tts_provider_at_session` for `p_session_id`, RAISES if NULL, defensive `pg_enum` lookup before casting via text into `cogs_service`. Preserves byte-identical signature so legacy SQL callers (`scripts/hume-migrations-smoke.sql:348`) keep working — provided their session fixture sets the snapshot column (smoke script patched in this PR).
8. Ends with `NOTIFY pgrst, 'reload schema'`.

**Round 2 M2 runbook step (operational, not schema):** Apply M3 inside a brief proxy maintenance window (or with `VOICE_PROXY_NEW_SESSIONS_DISABLED=1`) so no new sessions open during the apply. The pre-flight DO block in step 1 above counts NULL-snapshot active sessions in a SHARE lock; a session race opening between the COUNT and the `CREATE OR REPLACE FUNCTION` could slip past the gate and trip v3's 22023 on its first turn (silent cogs drop). The maintenance window collapses that race to zero.

**M4 — `voice_delete_queue` for Fish: defensive assertions + comment refresh** · `20260608100004_voice_delete_queue_fish.sql`
- No schema change. Composite PK `(tts_provider, voice_id)`, `voice_delete_queue_hume_needs_name` CHECK, and `voice_delete_queue_claim_v2`/`complete_v2`/`record_failure_v2` already accept fish rows transparently once M1 widens the enum.
- DO-block assertion (round 1 M5 + round 2 M3): PK shape, hume-needs-name CHECK presence, and `fish` enum value all verified at apply time. PK-order-aware via `ORDER BY k.ord` (round 1 M3).
- `ALTER TABLE ... VALIDATE CONSTRAINT` line REMOVED (round 1 M2 — takes SHARE UPDATE EXCLUSIVE lock even on already-valid constraints).
- Column comment refresh stamping Fish's DELETE shape (`DELETE https://api.fish.audio/model/{voice_id}`, Bearer auth, 200/204/404 idempotent — pending Phase 0.5 #8 manual verification stamp).
- Header documents the application-side prerequisites (round 1 C4) that MUST land on prod main before this migration: Zod validators widen to accept `'fish'`; coercion-widening across the 10+ sites in §6; `voice-delete-worker.js` implements `dispatchFish()`.
- Code change in `voice-delete-worker.js`: `dispatchFish(row)` → `DELETE https://api.fish.audio/model/{voice_id}` with `Authorization: Bearer FISH_API_KEY`. Success = 200/204 OR 404 (idempotent per Phase 0.5 #8). Other status → retry per existing worker semantics.
- End with `NOTIFY pgrst, 'reload schema'`.

**Migration version collision (operational note 2026-06-08):** `20260608000001_deep_brain_creator_rpcs.sql` was added on `feat/creator-journey-spine` after the Phase 1 plan was drafted, colliding with the Phase 1 batch's original `20260608000001-000004` numbering. Renumbered Phase 1 to `20260608100001-100004` (1xxxxx band) to leave space for further same-day adds on Vuk's branch and to make the Phase 1 batch visually distinct.

---

## 5. Code — New Files

### `server/voice-proxy/fish-bridge.js`

Mirror of `cartesia-bridge.js` public interface (`openBridge`, `turnStart`, `sendText`, `turnEnd`, `cancel`, `flush`, `getLastChunkAt`).

**Implementation specifics:**

1. **Per-turn WS lifecycle.** `turnStart` opens fresh WS; `cancel` and `turnEnd` close.
2. **MessagePack decode** with byteOffset-aware `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)` (round 1 M2).
3. **`perMessageDeflate: false`** in `ws` constructor.
4. **`flush()` is NO-OP CONSTANT** (round 2 C4). Phase 0.5 #4 informs a separate followup PR if useful.
5. **Pricing fail-closed via singleton-prime** (round 2 Small) — `_fishPricingPrimeForBoot()` lazy + `probeFailed` warn-not-exit pattern (round 1 C4). Conditional: prime only if `VOICE_TTS_PROVIDER==='fish'` OR a creator has `tts_provider='fish'` (round 2 Small + round 3 S6).
6. **Close codes** reuse `4014 tts_no_voice_<provider>`.
7. **In-flight chunk drop guards** mirror Cartesia.
8. **NEW (round 3 C4): inline Cartesia auto-fallback.** If WS fails to open OR errors before first `audio` chunk arrives for the current turn, fish-bridge emits a `fallback_required` event with the original text payload. The orchestrator catches it and re-dispatches to cartesia-bridge for the same turn. Once first audio has played, no fallback (would create voice-mid-turn-switch — worse UX than the silence). Fallback ONLY for pre-first-audio errors.
9. **Speculative pre-open (conditional on Phase 0.5 #2 reopen p99 > 600ms):** if needed, expose `prewarmTurn()` method that opens WS at user-turn-start, holds idle, sends `start` on first `sendText` call.

### `server/voice-proxy/fish-bridge.test.js`

~32 tests (28 baseline + 4 for auto-fallback). Coverage parity with `cartesia-bridge.test.js`:
- Lifecycle, per-turn WS, cancel, msgpack roundtrip, perMessageDeflate, pricing singleton, audio chunks, error mapping, WS abnormal close, turnEnd timeout, empty text skip, flush is no-op
- **NEW:** auto-fallback emission tests:
  - WS open failure → `fallback_required` event with payload
  - WS errors pre-first-audio → `fallback_required` event
  - WS errors post-first-audio → NO fallback, normal `error` event
  - Orchestrator integration test: receives `fallback_required`, dispatches to mock cartesia-bridge with same text

### `scripts/fish-audio-ws-spike.mjs` (KEPT IN TREE)

Phase 0.5 probe covering all 8 claims. Output: results document at `tmp/fish-phase-0.5-results.md` (gitignored); copy into §3 of this plan after run.

---

## 6. Code — Modifications

### Coercion-widening surface (rounds 1+2 — complete)

| File | Line(s) | Required |
|---|---|---|
| `server/voice-proxy/index.js` | 511, 670, 686, 2294 | Widen `'cartesia' \| 'hume'` switches to include `'fish'`; default `'cartesia'` |
| `src/app/api/sessions/open/route.ts` | 200, 322, 538, 614 | Widen union to `'cartesia' \| 'hume' \| 'fish'` |
| `src/lib/voice/mint-voice-ticket.ts` | 84, 134-135, 80-134 doc, 194-197 | Widen + update doc; Fish has no prosody columns (out-of-scope) |
| `src/lib/admin/cogs-aggregations.ts` | 25, 32, 37-38, 49-55, 62, 82, 155, 176 | Widen union; KEEP 2-way `'mixed'` semantics; add `cost_usd_fish` bucket |
| `src/app/admin/creators/[id]/tts-provider-panel.tsx` | 25, 130-131 | Add `'fish'` to type + dropdown options |
| `src/app/api/voice/spike-a/ticket/route.ts` | 136 | Annotate "spike-a is admin-dev only — never routes to Fish; keep hardcoded" |
| Aggregation views/dashboards | grep | Verify no hardcoded `WHERE service IN ('cartesia','hume')` |

**Grep gate:** extend [`scripts/check-tts-provider-writes.sh`](../../scripts/check-tts-provider-writes.sh) to flag narrow unions.

### `server/voice-proxy/index.js`

- `'fish'` branch in TTS provider switch.
- `_fishPricingPrimeForBoot()` conditional + lazy fallback.
- `cogs_insert_turn_voice_v3` invocation (v2 transitively forwards — both work; new code calls v3 directly).
- `onDeepAnswerDone` provider branch: Fish path = no flush; orchestrator awaits natural `stop`.
- `turnEnd` finalize timeout: for Fish, **TBD post-Phase-0.5 #6** (round 3 C1). DO NOT ship at 5s without measurement.
- **NEW (round 3 C4): `fallback_required` event handler.** When fish-bridge emits, dispatch SAME turn to cartesia-bridge inline. Single retry per turn (no infinite loop if Cartesia also fails). Increments a cogs_log entry `tts_fallback_invoked` for monitoring.
- Backpressure unchanged (USER WS, not fish-bridge WS).
- **NEW (round 3 S2): verify `awaitTurnSpoken` in [decoupled-orchestrator.js:794](../../server/voice-proxy/decoupled-orchestrator.js) fires `onDeepAnswerDone` regardless of provider.** Add assertion test.

### `server/voice-proxy/voice-delete-worker.js`

`dispatchFish(row)` per §4 M4. GDPR right-to-delete parity in Phase 1.

### `server/voice-proxy/package.json`

Add `"@msgpack/msgpack": "^3.0.0"`.

### `src/app/s/[id]/` (mobile/desktop client)

**NEW (round 3 M3): Mobile network blip UI spec.** When the client receives a `tts_disconnected` or `tts_unavailable` error from proxy:
- Avatar resets to **neutral idle pose** (not freeze mid-mouth-open).
- Toast at top: *"Connection hiccup — tap mic to retry."*
- Mic indicator stays armed.
- No auto-reconnect attempt for THIS turn (the auto-fallback already tried Cartesia).
- Sentry event captured with `session_id` + `turn_number`.

Component file: `src/app/s/[id]/error-toast.tsx` (new). Wire into existing session error handler.

### `supabase/tests/`

- `cogs_insert_turn_voice_v3.test.sql` — v3 accepts `'fish'`, rejects invalid
- `cogs_insert_turn_voice_v2_forwards_to_v3.test.sql` — v2 transitive forward
- `creators_tts_provider_fish.test.sql` — enum widened, RPC accepts
- `voice_delete_queue_fish.test.sql` — enqueue + claim_v2 with fish

---

## 7. Environment / Secrets

**Local `.env.local` (set):** FISH_API_KEY · FISH_TTS_MODEL=s2-pro · FISH_USD_PER_CHAR=0.000015 · FISH_QUOTED_AT=2026-05-28 ✓

**Fly:** same four via `flyctl secrets set --stage` + `flyctl deploy`. Pre-deploy: `flyctl auth whoami`.

**Vercel:** none.

**Round 3 S7 — model versioning:** `s2-pro` is Fish's headline model. Verify whether it's a versioned alias (e.g., `s2-pro-2026-04`) or a moving target. If moving, pin `FISH_QUOTED_AT` semantics carefully — CLAUDE.md bans `-latest` patterns. Phase 0.5 verifies by checking Fish's API response headers for any model-version metadata.

---

## 8. Hard Constraints (CLAUDE.md)

Unchanged: tier routing at session-open · cloned voice on every tier · cogs_log on every paid call · no silent voice exceptions · avatar pipe warm · kill-switch at 150% · camera off default · audit before push.

---

## 9. Tests (TDD)

- Unit: ~32 tests in `fish-bridge.test.js` (28 baseline + 4 fallback)
- Integration: provider-switch route tests; **auto-fallback integration** (Fish errors → Cartesia takes over same turn)
- pgTAP: M1-M4 covered
- **Real-API gated** (`RUN_FISH_REAL_API=1`, separate from `RUN_REAL_API_TESTS`): text ≤20 chars; daily ceiling $5; pre-flight spend tally check
- Full `npm run build` + `npm run db:test` green

---

## 10. Edge Cases

| Case | Behavior |
|---|---|
| WS close during turn (transient network), pre-first-audio | **Auto-fallback to Cartesia** for same turn (round 3 C4) |
| WS close post-first-audio | NO fallback (voice-mid-switch worse than silence). `tts_disconnected` taxonomy. Client shows error toast (round 3 M3) + avatar resets to neutral |
| `finish.reason=error` w/ no message | `tts_synthesis_error` generic |
| Empty text chunk | Skip — no event, no cost |
| Per-turn WS overhead | Phase 0.5 #2 measures; if reopen p99 > 600ms, speculative pre-open mandatory |
| User-WS backpressure | Unchanged (>2MB outbound to client) |
| Voice clone deletion (GDPR) | `voice_delete_queue` worker dispatches Fish DELETE; idempotent per Phase 0.5 #8 |
| Per-creator override mid-deployment | `voice_tickets.tts_provider` snapshot wins |
| Fish API outage mid-turn | Auto-fallback to Cartesia pre-first-audio; client error toast post-first-audio |
| Long-answer drain | `ttsFinalizeTimeoutMs` set post-Phase-0.5 #6 (round 3 C1); floor 30s |
| Multi-turn voice drift | Phase 0.5 #7 verifies before flip; lower temperature + seed pin if needed |

---

## 11. Rollout Order (Strict)

### Pre-deploy
1. **Phase 0.5 spike** — 8 claims (§3), ~$0.05 spend, ~3-4h. Results update §3 with measured numbers.
2. **Local Docker DB:** M1→M2→M3→M4 sequential; `npm run db:test` green.
3. **Code:** fish-bridge.js + tests + auto-fallback + coercion-widening + cogs caller + voice-delete-worker dispatchFish + error-toast.tsx.
4. **Full proxy `node --test`** green (~411 + ~30 new).
5. **Full `npm run build`** green.
6. **Auditor on implementation PR** (separate from this planning audit).

### Deploy (strict order)
7. **Apply migrations to prod** via `supabase db push`. M1+M2 widen enums with `NOTIFY pgrst` for immediate cache reload (round 2 M7).
8. **Set Fly secrets** + `flyctl deploy`.
9. **Verify boot logs:** fish pricing prime succeeded (or warned, not crashed).
10. **Push main** → Vercel deploys widened coercion sites.

### Cutover (Vuk's creator)
11. **Flip via RPC:** `SELECT public.creator_set_tts_provider('<vuk-creator-id>', 'fish')`.
12. **Soft launch** — 3-5 sessions. **A/B apparatus preserved (round 3 M2):** `scripts/serve-fish-spike.mjs` continues to host the original Phase 0 Cartesia samples + new Fish samples for back-to-back comparison; sample new turn audio under a `DEBUG_SAVE_TURNS=1` flag during dogfooding.
13. **Watch for** no cutoff, no stutter, no quality regression, voice consistency across turns.

### Rollback (BREAK-GLASS — service-role only)

Updated with round 3 M7 step 4:
```sql
BEGIN;

-- 1. Flip creator's provider back, bypassing RPC's active-session lock.
UPDATE public.creators
   SET tts_provider = 'cartesia'  -- or NULL
 WHERE id = '<vuk-creator-id>';

-- 2. Wipe unconsumed voice_tickets (round 2 C3).
UPDATE public.voice_tickets
   SET tts_provider = 'cartesia'
 WHERE creator_id = '<vuk-creator-id>'
   AND consumed_at IS NULL;

-- 3. In-flight sessions: their tts_provider_at_session snapshot keeps Fish
--    until session ends naturally. cogs_insert_turn_voice_v3 still allows
--    fish writes (post-M3) so no mid-session 22023 hangup.

-- 4. (Round 3 M7) For SEVERE Fish outages where in-flight sessions need
--    immediate cutover: gracefully kill them. Their auto-fallback already
--    tried; if it failed there's nothing to wait for.
UPDATE public.sessions
   SET ended_at = NOW(),
       end_reason = 'admin_break_glass_rollback'
 WHERE creator_id = '<vuk-creator-id>'
   AND ended_at IS NULL
   AND tts_provider_at_session = 'fish';
-- Client picks up session-ended via existing session-state polling;
-- shows graceful "your session has ended" with a "start a new session" CTA.

COMMIT;
```
Document in `docs/_planning/PROD_DEPLOY_GATE.md`.

### Post-launch
14. **1+ week stable:** declare success; plan UI removal; mark Fish as preferred default.
15. **Separate PR:** remove Cartesia code + `VOICE_CARTESIA_ENABLED` legacy env.

**Revised effort estimate:** **10-14 focused days** (round 3 scope additions: auto-fallback +1-2d; mobile UI +0.5d; expanded spike +0.5d; break-glass step 4 +0.5d). Plus 1-2 days soft-launch validation. **Total ~12-16 calendar days end-to-end.**

---

## 12. Risks + Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Voice quality regression (multi-turn drift) | Medium (round 3 C3 — UNTESTED) | High | Phase 0.5 #7; lower temperature + seed pin if drift |
| Long-answer cutoff re-introduced under Fish | High if shipped at 5s | High | Phase 0.5 #6 sets timeout floor 30s (round 3 C1) |
| Barge feels sluggish | Medium (round 3 C2) | High UX | Phase 0.5 #2 sub-trials; speculative pre-open if p99>600ms |
| Demo-day silence on Fish hiccup | Medium (round 3 C4) | Critical | Per-turn auto-fallback to Cartesia in scope; client error toast |
| 16kHz PCM unsupported | Medium | Medium | Phase 0.5 #1; resampler with ≤250ms ship-gate budget |
| Mobile error UX undefined | Was undefined | High | Spec'd: avatar neutral + toast + retry CTA (round 3 M3) |
| Rollback leaves in-flight Fish sessions hanging | Medium | High | Break-glass step 4 graceful session-end (round 3 M7) |
| No A/B apparatus during soft-launch | Was missing | Medium | Preserve serve-fish-spike.mjs + DEBUG_SAVE_TURNS flag (round 3 M2) |
| Rollback leaves stale voice_tickets | Medium | High | Companion UPDATE in break-glass (round 2 C3) |
| PostgREST cache stale | Medium | High | `NOTIFY pgrst` on M1+M2 (round 2 M7) |
| Probe-fail crash-loops Fly | Low | High | Lazy `probeFailed` warn-not-exit (round 1 C4) |
| Real-API test burns $ | Low (gated tightly) | Low | $5/day cap + 20-char text + spend tally |
| msgpack byteOffset corruption | Low | Medium | byteOffset-aware decode + `perMessageDeflate: false` (round 1 M2) |
| Cogs drift | Low | Low | 14d Fish-dashboard cross-ref |

---

## 13. Out of Scope (future PRs)

- Programmatic voice clone API (`POST /v1/references/add`)
- Multi-speaker (s2-pro dialogue)
- Volume tier upgrade ($1000+ → 50 concurrent)
- Self-host fish-speech on rented GPU
- Removing Cartesia code (separate PR after 1+ week stable)
- v2 cleanup once v3 fully stable
- Enabling `fish_bridge.flush()` if Phase 0.5 #4 verifies safe (followup PR)
- Fish prosody column writes in mint-voice-ticket.ts

**NO LONGER OUT OF SCOPE (round 3 C4):**
- ~~Multi-provider live fallback (Fish → Cartesia on outage)~~ — NOW IN scope per-turn pre-first-audio.

---

## 14. CLAUDE.md + Memory Doc Edits

Cartesia named in 7+ CLAUDE.md hard rules. Once Phase 1 ships:

**`CLAUDE.md`:** Lines 7-22 stack list · α' TTS layer flag para · WS close-code table · R3-M5 break-glass · Migration 20260505000001 runbook.

**Memory:** `project_voice_model.md` · `feedback_cloned_voice_everywhere.md` · `project_fish_audio_tts_swap.md` (update existing).

---

## 15. Approval Gate

**Status: Vuk approved option [1] on 2026-05-28 — apply all C/M/S findings → v4 → execute.**

**Next concrete step:** Write Phase 0.5 spike script `scripts/fish-audio-ws-spike.mjs` covering all 8 claims, then Vuk runs it (~3-4h, ~$0.05 spend), then results land in §3, then implementation begins.
