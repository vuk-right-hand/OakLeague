# Hume Octave 2 — TTS Bridge Addition (Pipeline α' Provider-Agnostic Swap)

> ⚠️ **Line-number references in this doc may have drifted** (unit-wide audit
> M7 fix 2026-05-13). The plan is a working spec — file paths are the stable
> anchor, `:NN-NN` line refs reflect the snapshot when each section was
> drafted and haven't been re-snapped after every fix. When investigating
> a specific behavior, grep the file path for the symbol/string mentioned
> rather than jumping straight to a line number. Plan re-snaps line numbers
> only at major-version cuts.

**Status:** draft v0.8 — §4 HumeTTSBridge built (480 lines, 47 tests). §4-alone audit fixed (5C/7M/8S applied). Unit-wide audit fixed for in-scope findings; 4 cross-section findings explicitly deferred to §5/§6 with concrete owners. All test suites green: 93 bridge + sentry tests, 28 migration smoke tests, 5 migrations apply cleanly.

**v0.8 deltas (2026-05-13):**
- **§4 HumeTTSBridge** in `server/voice-proxy/hume-bridge.js`: mirrors CartesiaTTSBridge interface exactly (`open` / `turnStart` / `sendText` / `turnEnd` / `cancel` / `close`). Phase-0 verified behavior: api_key query param + scrubUrl discipline, sample_rate query param honored, filter-by-generation_id cancel (Hume can't stop within 200ms per spike), silent-WS-close-1000 as bad_voice_id signal (1.5s threshold + zero-audio-bytes guard), is_last_chunk:true as turn_done, HUME_CHARS_PER_TURN_HARD_CAP=100000 coupled to RPC v2 cap. Constructor requires `pricing: {usdPerChar, quotedAt}` arg — fail-closed enforcement at bridge layer, not just proxy boot.
- **§4-alone audit fixes applied:**
  - C1 + C2: `_ws` assigned only after open resolves; orphan `ws.once('error')` listener removed after open (prevents MaxListenersExceededWarning on long-lived bridges).
  - C3: Bridge constructor requires validated pricing object (HUME_PRICING_NOT_VALIDATED throw on missing/bad shape).
  - C4: Hume payload_parse error.message echo of our outbound payload is sanitized to literal `'hume_payload_parse'` — closes a leak channel.
  - C5: `textsample` / `text_sample` added to Sentry TRANSCRIPT_KEYS — closes pre-existing Cartesia leak too.
  - M1: `_cancelledGenerationIds` Set capped at 64 with FIFO eviction.
  - M3: Cancel set cleared on reconnect success; `_unknownTypeWarned` flag also reset.
  - M4 + audit M4 refined: Hume error envelopes differentiate fatal vs per-turn-recoverable; unknown codes default to `fatal:true` (conservative, matches Cartesia posture).
  - M5: Char-cap exceeded emits one-shot `protocol_violation` event instead of silent truncate.
  - M6: turnEnd handler registers BEFORE `{flush:true}` send — fast-arrival `is_last_chunk:true` no longer races.
  - M7: `_buildUrl` uses array+filter+join — resilient to param reorder.
  - Small: bad_voice_id event fires BEFORE `closed` event so turnEnd resolve-handler sees the error first; `_unknownTypeWarned` resets on reconnect.
- **Unit-wide audit fixes applied (in-scope):**
  - **C3 (unit) → migration 0005:** `voice_tickets` extended with `hume_tts_speed`, `hume_trailing_silence`, `hume_voice_description`, `hume_model_version`. Mint code (§6) snapshots the env-resolved `creators.hume_*_<env>` values onto the ticket so `consumeTicket()` is the single DB read per session. Bridge constructor gets all four dials from the ticket.
  - **M1 (unit):** `voice_tickets.tts_provider` now `NOT NULL DEFAULT 'cartesia'` atomically — concurrent INSERTs during migration window can no longer hit the SET-NOT-NULL race. The DEFAULT gets dropped in 20260521000000 follow-up after §6 mint code is patched.
  - **M2 (unit):** `NOTIFY pgrst, 'reload schema'` now appended to migrations 0002 + 0003 + 0004 + 0005. PostgREST OpenAPI cache invalidates immediately on every signature/column change.
  - **M3 (unit):** Migration 0003 dependency guard refactored to use `pg_enum` catalog lookup instead of literal enum cast — works in the same transaction as ALTER TYPE ADD VALUE (PG12+ same-tx restriction).
  - **M4 (unit):** Hume error map carries per-code `{code, fatal}` entries; default unknown to `fatal:true`. E0101/payload_parse is the only known `fatal:false`. Matches Cartesia's per-turn-vs-connection-level distinction.
  - **M5 (unit):** `humemessage` / `hume_message` added to Sentry TRANSCRIPT_KEYS — defense-in-depth for any future Hume error code that echoes client input.
  - **S3 (unit):** `_charCapEmittedThisTurn` declared in HumeTTSBridge constructor for grep-safety.
- **Unit-wide findings explicitly deferred to §5/§6** (each carries a §-tag in the todo tracker):
  - **C1 (unit) — §5.2 owner:** `voice_clone_finalize_locked_v2` writes prod `creators.hume_voice_id` ignoring env scope. The §5.2 paste-flow route must hard-gate production-only (mirroring `route.ts:96-104` Cartesia precedent) with a 503 `hume_clone_only_in_production` on preview/dev deploys. Verified in the §5 plan stub before §5.2 lands.
  - **C2 (unit) — §6 owner:** Per-turn `hume_per_turn_cap_exceeded` proxy behavior. On the bridge's `protocol_violation` event, the proxy MUST call `cogs_insert_turn_voice_v2` with capped TTS values + `metadata.tts_cap_exceeded=true` BEFORE WS-closing 4006 `quota_state_inconsistent`. R3-C1 quota-correctness rule: every paid Gemini call must write its cogs legs even when the TTS leg is capped. Documented in §6 spec.
  - **C4 (unit) — §6 owner:** `validateHumePricingOrExit` must run at proxy boot for BOTH providers if any creator has a per-creator override pointing to the non-env provider. Detection: query `SELECT 1 FROM creators WHERE tts_provider IS NOT NULL AND tts_provider <> $VOICE_TTS_PROVIDER LIMIT 1` at boot. If hit, validate the other provider's pricing too. Documented in §6 spec.
  - **M6 (unit) — §5.4 owner:** `voice_delete_queue_purge_dead` cron RPC to GC rows where `attempts >= 10 AND updated_at < now() - interval '30 days'`. Prevents queue rot. Documented in §5.4 spec.

Earlier status note (kept for history): draft v0.7 — pre-§4 fix batch applied.

Earlier status note (kept for history): draft v0.6 — Round-3 audit (5C/7M/11S) + Secret-key OAuth probe applied.

**v0.7 deltas (2026-05-13):**
- **`hume_tts_speed` CHECK widened from `[0.85, 1.10]` to `[0.5, 2.0]`** — matches Hume's own dashboard range and the Python SDK contract. Founder tested speed=1.5 on Octave 2 and verified dramatic improvement; the earlier R3-C5 narrowing rejected the founder's own measured config. The cadence anomaly at 1.15 is a calibration concern, not a range issue.
- **Three new env-scoped column groups added to `creators`** (Phase-0 re-probe 2026-05-13 mapped the full Hume per-utterance param surface):
  - `hume_trailing_silence` / `_preview` / `_dev` — numeric DEFAULT 0.3, CHECK [0, 5]. Matches Hume UI default; founder tested 0.25.
  - `hume_voice_description` / `_preview` / `_dev` — text ≤1000 chars. Octave 2's acting-instructions knob. **Currently inert on Octave 2** — Hume docs say "coming soon"; we persist now so the bridge is ready the moment they ship it.
  - `hume_model_version` / `_preview` / `_dev` — text DEFAULT `'2'`, CHECK IN ('1','2','default'). Pins Octave version per-creator. v0.7 default is Octave 2 per founder call.
- **Audit fixes applied this round:**
  - C1: `voice-clone/route.ts` upserts on `voice_delete_queue` now use composite key `tts_provider,voice_id` and include explicit `tts_provider:'cartesia'` payload.
  - C2: Cartesia rate-limit count now filters `tts_provider='cartesia'` so Hume rows don't burn the cap.
  - C4: Sentry scrub now also walks `event.request.query_string`, breadcrumb `data.to`/`data.from`, and runs a tree-walking `scrubSecretsDeep` defense-in-depth pass.
  - C5: `voice_tickets` DELETE in migration 0002 now expiry-gated — live in-flight tickets (`expires_at >= now()`) get backfilled to `'cartesia'` instead of wiped. Migration window can no longer kill a session whose mic was tapped at deploy time.
  - C6: Migration 0003 has a top-of-file `DO $$ PERFORM 'hume'::cogs_service; PERFORM 'cartesia'::tts_provider; ... $$` dependency guard.
  - M1: SQLSTATE 42501 → 22023 on data-mismatch errors in `voice_clone_finalize_locked_v2` (admin / creator / tts_provider mismatch). Route layer no longer surfaces "admin not active" on data mismatches.
  - M2: `cogs_insert_turn_voice_v2` now cross-checks `sessions.tts_provider_at_session` and rejects mismatches before reaching the ON CONFLICT footgun.
  - M3: `voice_delete_queue` CHECK enforces `tts_provider='hume' → voice_name NOT NULL` at DB level (was app-layer-only).
  - M7: `NOTIFY pgrst, 'reload schema'` at end of migration 0002 — PostgREST OpenAPI cache invalidates immediately on apply.
- **Hume Teams correction:** Earlier draft floated Hume Teams as the realistic fallback if Hume doesn't ship programmatic upload. Re-probe 2026-05-13 shows Scale ($200/mo)=3 seats, Business ($500/mo)=5 seats, no RBAC scoping, no OAuth/magic-link/iframe — **not viable at scale**. Realistic ladder if Hume rejects programmatic upload: (1) Vuk uploads manually for first ~50 creators, (2) enterprise contract for programmatic upload OR delegation flow, (3) stay on Cartesia.

Earlier status note (kept for history): draft v0.6 — Round-3 audit (5C/7M/11S) + Secret-key OAuth probe applied.

**Secret-key OAuth result (2026-05-13):** Vuk's Hume Personal settings show both API key + Secret key. OAuth client_credentials flow at `POST /oauth2-cc/token` works and mints a 30-min Bearer token — but the token is scoped for **EVI** (Hume's chat product), not for TTS voices CRUD. With Bearer auth, `GET /v0/tts/voices` returns 403 "Credentials were invalid for this resource." The audio-clone REST endpoint genuinely does not exist for either auth scheme. **Scenario B (admin paste) remains the v1 path; Scenario A swap is a future 1-day UI patch when Hume ships the endpoint.**

**Phase-0 verdict** (full report: `docs/_planning/HUME_PHASE_0.md`):
- ✅ TTFA p50 = 686ms (matches Cartesia baseline)
- ✅ Sample-rate query param works for both 16k and 24k — no downsampler needed
- ✅ Sequential 20-turn load p50 = 594ms steady-state
- ✅ DELETE endpoint EXISTS at `DELETE /v0/tts/voices?name=<name>` (Phase-0 missed it; verified 2026-05-13)
- ⚠️ Programmatic audio-clone REST does NOT exist — **Scenario B** (admin pastes name+id from Hume UI) is the only path
- ⚠️ Cancellation doesn't stop chunks within 200ms (all 3 strategies tested) — bridge uses filter-by-generation_id strategy
- ⚠️ Bad voice id → silent WS close 1000 (no error envelope) — bridge detects via "closed-before-first-chunk"
- ⚠️ Speed=1.15 produced 4× longer audio than expected — Hume non-standard semantics or bug; admin UI calibrates by ear
- ✅ Concurrent cap on free tier was ~10; **Vuk upgraded to Creator tier with commercial license** 2026-05-13; ceiling re-test scheduled for §8.6 burn-in

**Parallel-work advisory:** RAG Phase 2 plan reserves `20260516000001–002`. Hume now on `20260520*`. Only real coordination is migration naming — see §13.
**Owner:** Vuk
**Why now:** Hume Octave 2 is quoted at **~$7.60/1M chars** (~5–7× cheaper than Cartesia at the current pinned rate, pending final reconcile in §10). Octave 2 also has an emotion-aware LLM TTS architecture that *may* fit mentorship conversations better than Cartesia's neutral pipe. CLAUDE.md already mandates provider-agnostic bridges — this is the swap moment that architecture was built for.

**Outcome we want:** Run A/B of Cartesia-clone-of-Vuk vs. Hume-clone-of-Vuk on 20 identical prompts. Pick the winner. Flip an env var (or per-creator override) to swap the live TTS leg with **zero refactor** elsewhere.

**Outcome we don't want:** Cartesia ripped out before Hume is proven; mid-session TTS swap (forbidden by CLAUDE.md); silent fallback to Hume during a Cartesia outage; **API keys in Sentry/Fly logs/error messages** (Hume's WS auth lives in the URL query string — this is the C1 risk that the auditor flagged); or a single-creator A/B that breaks the v1 voice-clone rate caps.

---

## 0. Reference material — what we know about Hume from web verification

Verified 2026-05-13 via `dev.hume.ai` docs + reference. Unverified items are flagged **[SPIKE-0]** and gated by §1.

| # | Item | Verified value | Source |
| - | --- | --- | --- |
| 1 | WS endpoint | `wss://api.hume.ai/v0/tts/stream/input` | dev.hume.ai/docs/text-to-speech-tts/overview |
| 2 | WS auth | `api_key=<key>` **query param** (no header path; Hume gives no other choice) — **C1 hard secrets-handling risk; see §2.0** | dev.hume.ai/docs/introduction/api-key |
| 3 | REST auth | `X-Hume-Api-Key: <key>` header | dev.hume.ai/docs/introduction/api-key |
| 4 | Octave 2 selector | `version=2` **query param** (default `1`) | reference/text-to-speech-tts/stream-input |
| 5 | Low-latency flags | `instant_mode=true`, `strip_headers=true`, `format_type=pcm`, `no_binary=true` | reference + python quickstart |
| 6 | Output sample rate | **48000 Hz default**. WS `sample_rate` query support **[SPIKE-0]** — pipecat hints yes; reference doesn't list it. | pipecat hume.tts page |
| 7 | Output bit depth | 16-bit PCM (s16le) implied by pipecat; **[SPIKE-0]** confirm | inference |
| 8 | Outbound message | `{ text, voice:{id, provider:'CUSTOM_VOICE'}, speed?, trailing_silence?, flush?, close? }` | reference InputMessage |
| 9 | Inbound chunk | `{ type:'audio', audio:'<base64>', audio_format:'pcm', chunk_index, generation_id, snippet_id, text, is_last_chunk, request_id }` | reference SnippetAudioChunk |
| 10 | End-of-utterance | `is_last_chunk: true` on the final chunk for that generation | reference |
| 11 | Buffering | WS buffers text until `flush:true` OR implicit heuristic. `close:true` drains then terminates. | overview |
| 12 | Cancellation | **[SPIKE-0]** — no explicit cancel frame documented. Spike tests three: `{flush:false}` mid-stream, `{close:true}`, abrupt WS close. | inference |
| 13 | Voice cloning REST | UI flow at `app.hume.ai/voices` documented; programmatic path **[SPIKE-0]** — Phase-0 §1 check 7 enumerates 3 hypotheses. | docs/voice/voice-cloning |
| 14 | Delete voice | **[SPIKE-0]** — `DELETE /v0/tts/voices/{id_or_name}` by pattern parity; confirm. | inference |
| 15 | Voice id format | **[SPIKE-0]** — not documented; assume opaque string ≤128 chars (matches our existing `char_length BETWEEN 1 AND 128` CHECK). Don't enforce UUID format. | inference |
| 16 | Pricing | $7.60 / 1M chars; "<1¢/min" with dedicated deployments | hume.ai/blog/octave-2-launch |
| 17 | TTFA | <200ms (40% faster than Octave 1) — marketing claim; **[SPIKE-0]** measure on Fly→Hume route, our network, our payload sizes | hume.ai blog |
| 18 | Concurrent connections cap | **[SPIKE-0]** — public docs silent. Phase-0 check 9b opens N=20 in parallel. | unknown |
| 19 | Rate limits | **[SPIKE-0]** — public docs silent | unknown |
| 20 | Error envelope shape | **[SPIKE-0]** — Phase-0 check 10 forces two error paths to capture real shape | unknown |

Every **[SPIKE-0]** item must resolve to PASS or to a documented workaround in `docs/_planning/HUME_PHASE_0.md` before §3 lands. Cartesia precedent: `scripts/cartesia-phase0-rerun.mjs` → `docs/_planning/CARTESIA_PHASE_0_RERUN.md`.

---

## 1. Phase 0 — Hume reality-check spike (gate; ~3–5 hours)

New script: `scripts/hume-phase0-spike.mjs`. Mirrors `scripts/cartesia-phase0-rerun.mjs`. Writes `docs/_planning/HUME_PHASE_0.md`. Required local env (NEVER committed): `HUME_API_KEY`, `HUME_TEST_VOICE_ID` (cloned in Hume UI for the spike).

**Checks:**

1. **Connect + Octave 2 acceptance** — open `wss://api.hume.ai/v0/tts/stream/input?api_key=…&version=2&instant_mode=true&strip_headers=true&format_type=pcm&no_binary=true`. PASS = handshake ≤400ms warm, ≤900ms cold.
2. **`sample_rate` query param** — retry with `&sample_rate=24000` and `&sample_rate=16000`. PASS = (a) accepted, (b) decoded chunks measure ±1% of the requested rate against a 440Hz reference tone. If FAIL on both → §4.4 server-side downsample path.
3. **Bit depth / channel** — decode first 1024 bytes; verify byte-length parity, mono distribution. PASS = s16le mono confirmed.
4. **TTFA** — `{ text:"Hello, world.", voice:{ id:VOICE, provider:"CUSTOM_VOICE" }, flush:true }`. Time first `type:'audio'` frame. PASS = ≤500ms warm, ≤900ms cold (parity with Cartesia Phase-0 baseline, NOT the 200ms marketing claim).
5. **Streaming text shape** — send 3 chunks without `flush`, then 1 with `flush:true`. PASS = single `generation_id` across the burst; final chunk has `is_last_chunk:true`.
6. **Cancellation (3 sub-checks, drives §4.2)** —
   - 6a. mid-stream `{ flush:false }`: does Hume stop production within 200ms? Records ms-to-last-chunk.
   - 6b. mid-stream `{ close:true }`: same measurement.
   - 6c. abrupt `ws.close()`: post-close chunk count (server can keep sending until socket teardown).
   - **Output:** decision matrix → bridge cancel strategy + a per-cancel waste-chars metric (M2).
7. **Voice cloning REST** — try each in order until one accepts a multipart audio upload:
   - 7a. `POST /v0/tts/voices/clone` (REST analog of Cartesia `/voices/clone`)
   - 7b. `POST /v0/tts/voices` with multipart `audio` + `name` (audio-upload variant of the documented save-from-generation endpoint)
   - 7c. `POST /v0/tts/voices` with JSON `{ generation_id, name }` (voice-DESIGN path; if only this works, audio-clone is UI-only)
   - Record which path Hume accepts. Output drives §5.1 (Scenario A) vs §5.2 (Scenario B).
8. **DELETE a voice** — `DELETE /v0/tts/voices/<id>` against a throwaway. PASS = 200/204/404. Also test `DELETE /v0/tts/voices/<name>` since some Hume endpoints accept name-or-id.
9. **Load checks (two dimensions)** —
   - 9a. **Sequential**: 20 turns in a tight loop on one WS. Record any 429s / errors / latency drift.
   - 9b. **Concurrent**: open 20 parallel WS connections; send one turn on each simultaneously. Records the cap dimension that actually matters at scale.
10. **Error envelope shape** — induce: (a) bad voice id (`voice.id="not-a-voice"`), (b) malformed JSON (`{ not even valid`). Capture raw envelopes. Used to populate `HUME_ERROR_MAP` in §4.3 — until this runs, the bridge maps EVERY Hume error to `other` with `fatal:true` (defensive).
11. **Voice-id format** — note the literal id Hume returns from check 7 (UUID? slug? something else?). Don't pattern-enforce in admin route until known.

Plan does not advance to §3 until every check is PASS or has an explicit documented workaround. §2 (the no-behavior-change interface refactor) MAY land before Phase-0 finishes because it's a pure rename.

---

## 2. Pre-Hume prep — secrets, refactor, interface

### 2.0 Secret-handling pre-work (must land BEFORE any Hume bridge code) — addresses C1

The single biggest production trap: Hume forces auth into the WS URL. Without scrubbing, the production API key lands in:
- Sentry events (`event.request.url`, `event.transaction`, captured Error.message strings)
- Fly Grafana Loki via `console.error` on WS handshake failures
- `ws` library's own `error.message` (it stringifies the URL on `ECONNRESET`)

**Pre-merge tasks (separate PR; lands FIRST):**

1. **Extend `server/voice-proxy/sentry.js:67-69 scrubUrl`** — currently redacts only `ticket=`. Add `api_key`, `access_token` to the regex. Same module, single-line diff. **Add a unit test** (`server/voice-proxy/sentry.test.js`) that round-trips `wss://api.hume.ai/v0/tts/stream/input?api_key=secret&version=2` and asserts the output contains `api_key=[redacted]`.
2. **Add exception-value scrub on the proxy `beforeSend`** (Round-2 M1). Today's proxy `beforeSend` does not run `scrubUrl` over `event.exception.values[i].value`. Hume `ws` errors stringify the URL into the exception message, bypassing every URL-keyed scrub. Add a pass mirroring `sentry.server.config.ts:36-37`:
   ```js
   if (event.exception?.values) for (const v of event.exception.values) {
     if (typeof v.value === 'string') v.value = scrubUrl(v.value);
   }
   ```
   Also scrub `event.exception.values[i].stacktrace.frames[*].context_line` — node versions can put the failing URL into the stack frame snippet on `ECONNREFUSED`. Phase-0 check 12 (added below) grep-asserts no `api_key=` in captured events.
3. **Next-side scrub** (Round-2 M1 — corrects plan v0.2 mis-naming): the function in `sentry.server.config.ts` is `redactSensitive`, not `cleanseUrl`. `redactSensitive` already passes through `redactSpikeB`, which **already** scrubs `api_key=`/`access_token=` query-string forms AND `"api_key":"..."` JSON forms (`sentry.server.config.ts:75-81`). **No change required Next-side.** Confirm via grep before merging; if the file has drifted, restore parity.
4. **`HumeTTSBridge.buildUrl` returns two strings** — `urlWithKey` (used to open the WS) and `urlScrubbed` (logged/stored). EVERY `console.*` / `captureException` / `captureMessage` call inside `hume-bridge.js` MUST use `urlScrubbed`. Internal invariant test: grep the bridge file for `urlWithKey` after merge and assert it appears only in the `new WebSocket(urlWithKey, ...)` line.
5. **`ws` library error wrapper** — attach a synchronous handler in the SAME constructor block as `new WebSocket(...)` (no `await` between instantiation and listener attach) that rewrites `e.message` AND inspects/clears `e.stack` if it contains `api_key=`. Round-2 M1 flagged that mutating `message` doesn't update `stack`. Test fixture: synthesize a `ws` error with raw URL embedded in BOTH `message` and `stack`, run through the wrapper + Sentry beforeSend, assert no leak.
6. **Bridge-boundary log policy comment** — add a top-of-file comment to `hume-bridge.js` documenting "secrets only ever appear in `urlWithKey`; this variable is constructor-local and never leaves the open() promise body."

This step blocks all Hume code. CI must run the new scrub tests on every PR after this lands.

**Phase-0 check 12** (added): after the scrub pre-work merges to staging, force a Hume WS connection failure (bad URL, killed network) and inspect the Sentry event JSON for `api_key=`. PASS only if absent from `request.url`, `transaction`, `message`, `exception.values[*].value`, `exception.values[*].stacktrace.frames[*].context_line`, and every breadcrumb.

### 2.0.1 Content-leak via Hume `SnippetAudioChunk.text` — Vuk-C2 fix

Hume's inbound audio envelope carries a `text` field on EVERY chunk containing the **avatar-spoken transcript fragment** (the actual words the user is about to hear). That's the same class of PII as Gemini's `outputTranscription` — but the proxy's `TRANSCRIPT_KEYS` denylist at `server/voice-proxy/sentry.js:77-105` does NOT include a generic `text` key (correctly broad, but Hume-blind) NOR Hume-specific aliases.

Two-part fix shipped in the §2.0 pre-merge PR:

1. **Extend `TRANSCRIPT_KEYS`** with Hume-specific aliases:
   ```js
   'hume_chunk_text', 'humechunktext',
   'snippet_text',    'snippettext',
   'snippetaudiochunk_text',
   ```
   The denylist is keyed on lowercased full key name — these are tight matches, not substring greps, so they won't false-positive on unrelated `text` fields. The bridge code MUST use one of these key names when logging chunk-derived data; never spread the raw msg.

2. **Bridge logging discipline** (`hume-bridge.js`): the §4.3 "unknown envelope type → warned-once" path MUST NOT log the raw `msg` object. Allowed log shape:
   ```js
   { type: String(msg.type).slice(0, 40), generation_id: msg.generation_id }
   ```
   That's it. NO `msg.text`, NO `msg.audio` (base64 PCM in a Sentry payload is both noisy and a privacy hazard), NO `JSON.stringify(msg)`. Add a CI grep test: `hume-bridge.js` must not contain `JSON.stringify(msg)` or `console.*\(.*\bmsg\b` (whole-word match).

3. **Same discipline on the `audio_out` emit path**: the bridge emits an `audio_out` event with `chunk: { bytes, mimeType }`. The `text` field on the inbound chunk is dropped at the bridge boundary — never lifted onto the emitted event. The proxy never sees it. Codify in §4.3 with a comment.

**Phase-0 check 14** (added): force a Hume error mid-stream that triggers the bridge's warn path; assert no chunk `text` appears in the captured Sentry event.

### 2.1 Bridge interface — `server/voice-proxy/tts-bridge.js`

JSDoc-only contract (proxy is plain ESM). The de-facto interface CartesiaTTSBridge already implements; this commit just writes it down:

```
class TTSBridge extends EventEmitter {
  async open();
  turnStart(contextId): void;          // throws { code:'tts_reconnecting'|'bridge_not_open' }
  sendText(text): void;
  async turnEnd({ timeoutMs }): { characters, audioBytes, audioSeconds, partial };
  cancel(): void;
  async close();
  // events: audio_out | turn_done | error | closed | reconnected | setup_complete
}
```

No behavioral change. CartesiaTTSBridge test suite unmodified.

### 2.2 Shared error taxonomy — `server/voice-proxy/tts-error-codes.js`

Lift the existing const-union into a shared module. Both bridges import; `CARTESIA_ERROR_MAP` becomes provider-specific translation only.

### 2.3 Shared text normalizer — `server/voice-proxy/tts-text-normalize.js`

Lift the smart-quote / em-dash / NBSP normalization from `cartesia-bridge.js:210-215`. Both bridges call it. Used by §7 A/B harness too — pins normalization parity across providers (addresses M7).

### 2.4 Provider env + dispatch — `server/voice-proxy/proxy-handlers.js`

- Add `VOICE_TTS_PROVIDER` env. Allowed: `cartesia | hume`. Default `cartesia`.
- Keep `VOICE_CARTESIA_ENABLED` as a back-compat alias for one cycle: when set to `1` AND `VOICE_TTS_PROVIDER` unset → cartesia. Retire after cut-over.
- Rename `getCartesiaPricing()` → `getTtsPricing()` returning `{ provider, usdPerChar, quotedAt }`. Hume reads `HUME_USD_PER_CHAR` + `HUME_QUOTED_AT`. **Fail-closed at module load** — same pattern. Missing or non-finite-positive → hard exit.
- `getTtsApiKey()` returns the right key (validates the SELECTED provider's key only).

### 2.5 `/voice-config` and the session-open snapshot — addresses C3, C4

The auditor caught a real bug latent today: `/api/sessions/rollover/route.ts:132` re-reads `/voice-config` mid-session. Today that's fine because only `useCartesia` toggles between cold deploys; with Hume in the mix, the rollover could read a different provider than the active session was opened against.

**Architectural rule:** `tts_provider` is **snapshotted at session-open into `sessions.tts_provider_at_session`** (DB column added in §3). Rollover NEVER reads `/voice-config` for provider — it reads the session row.

- `/api/sessions/open/route.ts` writes `tts_provider_at_session` from the same `/voice-config` read that determines `useCartesia`. One source of truth.
- `/api/sessions/rollover/route.ts` reads provider FROM `sessions.tts_provider_at_session`. Falls back to `cartesia` if NULL (pre-migration row).
- `/voice-config` continues to expose the LIVE env state, used only at session-open + admin UI. NOT a mid-session source of truth.
- Add integration test: open session under cartesia, flip `VOICE_TTS_PROVIDER` to hume on Fly, hit rollover endpoint, assert ticket carries `tts_provider='cartesia'`.

### 2.6 Per-creator provider override

`creators.tts_provider` (added in §3) overrides the env at session-open. Locked into `sessions.tts_provider_at_session` immediately. Never read again mid-session.

### 2.7 `index.js` renames

`cartesia` → `ttsBridge`; `cartesiaTurnDead` → `ttsBridgeTurnDead`; `useCartesia` snapshot → `ttsProvider` snapshot + `useTts` boolean (`ttsProvider !== 'none'`). Pure rename pass; cartesia test suite green throughout.

---

## 3. Schema — split into 3 migrations to dodge ALTER TYPE ADD VALUE in-tx limit

Migration filenames moved to **`20260520*` baseline** to avoid collision with both pre-existing (`20260514*`–`20260515000005`) AND the parallel-shipping RAG Phase 2 (which owns `20260516000001` and `20260516000002` per `docs/_planning/RAG_SOTA_PLAN.md` §10). The 4-day gap (`20260516*`–`20260519*`) is a deliberate buffer for RAG Phase 2 + any follow-ups it spawns. §13 below covers the merge sequencing.

Verified against `ls supabase/migrations/2026051*.sql` (last existing slot at v0.4 write time: `20260515000005`) and against the RAG plan's reserved range.

### 3.1 Migration: `20260520000001_cogs_service_add_hume.sql`

Standalone. `ALTER TYPE … ADD VALUE` historically requires its own transaction; some PG/supabase-cli combos error if it's in the same tx as DDL that USES the new value. Split out:

```sql
ALTER TYPE public.cogs_service ADD VALUE IF NOT EXISTS 'hume';
```

That's the entire file. Tested-via-CI assertion: SELECT enum_range(NULL::cogs_service) includes 'hume'.

### 3.2 Migration: `20260520000002_hume_voice_provider.sql`

```sql
-- 1. tts_provider enum (small + type-safe; 'cogs_service' is too broad to reuse)
DO $$ BEGIN
  CREATE TYPE public.tts_provider AS ENUM ('cartesia', 'hume');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. creators: per-creator override + env-scoped Hume voice ids + voice NAMES
--    Hume keys SYNTHESIS by id (UUID) but DELETE by name (Phase-0 verified
--    2026-05-13 at DELETE /v0/tts/voices?name=<name>). Both must be stored.
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS tts_provider public.tts_provider, -- NULL = inherit env
  ADD COLUMN IF NOT EXISTS hume_voice_id            text CHECK (hume_voice_id            IS NULL OR char_length(hume_voice_id)            BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_id_preview    text CHECK (hume_voice_id_preview    IS NULL OR char_length(hume_voice_id_preview)    BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_id_dev        text CHECK (hume_voice_id_dev        IS NULL OR char_length(hume_voice_id_dev)        BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name          text CHECK (hume_voice_name          IS NULL OR char_length(hume_voice_name)          BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name_preview  text CHECK (hume_voice_name_preview  IS NULL OR char_length(hume_voice_name_preview)  BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name_dev      text CHECK (hume_voice_name_dev      IS NULL OR char_length(hume_voice_name_dev)      BETWEEN 1 AND 128),
  -- Paired-presence guard: when hume_voice_id_* is set, hume_voice_name_*
  -- MUST also be set (deletes would have nothing to dispatch on otherwise).
  ADD CONSTRAINT creators_hume_voice_paired_chk CHECK (
    (hume_voice_id         IS NULL) = (hume_voice_name         IS NULL) AND
    (hume_voice_id_preview IS NULL) = (hume_voice_name_preview IS NULL) AND
    (hume_voice_id_dev     IS NULL) = (hume_voice_name_dev     IS NULL)
  ),
  -- Vuk-M6 fix: permissive speed knob; admin UI calibrates by ear.
  -- Phase-0 check 13 found Hume speed semantics non-linear (1.15 produced
  -- 4× longer audio than 1.0); column accepts a wide range but admin UI
  -- pre-populates with safe defaults.
  ADD COLUMN IF NOT EXISTS hume_tts_speed numeric CHECK (hume_tts_speed IS NULL OR (hume_tts_speed >= 0.5 AND hume_tts_speed <= 2.0));

-- 3. sessions: snapshot the provider at session-open. NOT NULL would
--    break inserts on the upgrade window — leave nullable, backfill below.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS tts_provider_at_session public.tts_provider;

-- 4. R1-C4 fix: backfill historical rows to 'cartesia' (only provider before this migration).
--    R2-Small filter: WHERE ended_at IS NOT NULL to dodge lock contention with live rows.
UPDATE public.sessions
  SET tts_provider_at_session = 'cartesia'
  WHERE tts_provider_at_session IS NULL AND ended_at IS NOT NULL;
-- Live rows will be re-snapshotted by /api/sessions/open after the route lands.

-- 5. R2-C1 fix: voice_tickets carries the provider so the proxy reads it once at
--    consume time (no extra DB round-trip in the hot WS-open path). DELETE
--    pre-migration in-flight tickets — they're <2h-lived per voice_tickets
--    expiry; the existing voice_tickets_purge_consumed cron also reaps them.
ALTER TABLE public.voice_tickets
  ADD COLUMN IF NOT EXISTS tts_provider public.tts_provider;
DELETE FROM public.voice_tickets
  WHERE tts_provider IS NULL AND consumed_at IS NULL;
UPDATE public.voice_tickets
  SET tts_provider = 'cartesia'
  WHERE tts_provider IS NULL;  -- consumed rows; historical
ALTER TABLE public.voice_tickets ALTER COLUMN tts_provider SET NOT NULL;

-- 6. R1-C5 fix: NOT NULL for delete-queue, but TEMPORARY DEFAULT for the
--    deploy window (R2-C3). Default is dropped in 20260521000000 AFTER
--    every writer site lands. Two-step keeps the route's existing
--    INSERTs/upserts from 23502'ing in the gap between this migration
--    and §5 route deploy.
ALTER TABLE public.voice_clone_uploads
  ADD COLUMN IF NOT EXISTS tts_provider public.tts_provider NOT NULL DEFAULT 'cartesia',
  -- Scenario B audit ledger: when admin pastes a Hume voice id+name, both go here.
  ADD COLUMN IF NOT EXISTS hume_voice_id   text CHECK (hume_voice_id   IS NULL OR char_length(hume_voice_id)   BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name text CHECK (hume_voice_name IS NULL OR char_length(hume_voice_name) BETWEEN 1 AND 128);

ALTER TABLE public.voice_delete_queue
  ADD COLUMN IF NOT EXISTS tts_provider public.tts_provider NOT NULL DEFAULT 'cartesia',
  -- Hume DELETE keys by name (Phase-0 verified). Cartesia DELETE keys by
  -- voice_id (existing). Worker dispatches per row's tts_provider.
  -- voice_name is nullable because Cartesia rows have voice_id only.
  -- Application-level invariant: tts_provider='hume' → voice_name NOT NULL
  -- (enforced by route at insert time; CHECK constraint omitted because
  -- pre-migration Cartesia rows would fail it).
  ADD COLUMN IF NOT EXISTS voice_name text CHECK (voice_name IS NULL OR char_length(voice_name) BETWEEN 1 AND 128);
```

**Two-step DEFAULT removal (R2-C3 fix):** the original v0.2 plan dropped DEFAULT in the same migration as ADD COLUMN. That bricked the live `/api/admin/voice-clone` route until §5 landed. Revised approach: this migration keeps `DEFAULT 'cartesia'` so existing INSERT sites keep working. A follow-up migration `20260521000000_voice_clone_drop_default_tts_provider.sql` runs AFTER §5 has shipped + verified that every writer sets `tts_provider` explicitly. The follow-up migration:

```sql
-- After §5 lands and CI grep (see §5.5) is enforced
ALTER TABLE public.voice_clone_uploads ALTER COLUMN tts_provider DROP DEFAULT;
ALTER TABLE public.voice_delete_queue   ALTER COLUMN tts_provider DROP DEFAULT;
```

This pattern is deliberately not symmetric to `sessions.tts_provider_at_session` (which stays nullable forever) — clone/delete-queue rows want NOT NULL eventually, sessions doesn't (historical preservation).

### 3.3 Migration: `20260520000003_cogs_insert_turn_voice_v2.sql`

New RPC `cogs_insert_turn_voice_v2`:
- adds `p_tts_service cogs_service` (drives legs 3+4 `service` column)
- renames internal `p_cartesia_*` params to `p_tts_*` (semantics identical; provider-neutral)
- **`p_tts_characters` upper bound unified at 100,000 for BOTH providers** (R1-M6 + Vuk-M3 fix). Original v0.2/v0.3 plan set Hume to 100k while leaving Cartesia at 200k → asymmetric guard. Tighter unified cap is cleaner. `OUTPUT_TRANSCRIPT_MAX_CHARS=4000` per Gemini turn means 100k is still 25× headroom for accidental chunk concatenation. The bridge's runtime invariant (§4.2) is the first line of defense; the RPC is the second. v1→v2 forwarding shim (§6.6) preserves Cartesia's old 200k range only for in-flight calls during the deploy window; v2 caps both at 100k.
- writes `tts_provider` into `p_metadata` so the dashboard can group by provider on EVERY leg (C4 fix).
- range guard for `p_tts_cost`: keep ≤$10/turn cap.

v1 RPC stays callable as a forwarding shim (see §6.6). **The caller is the Fly proxy** (`server/voice-proxy/cogs-rpc.js`), not Vercel — the proxy switches to v2 in the same PR as the migration. Vercel does not call this RPC directly; correcting Vuk-M1's flagged wording.

### 3.4 Migration: `20260520000004_voice_clone_finalize_locked_v2.sql` — Round-3 C1 fix

The §3.2 paired-CHECK `(hume_voice_id IS NULL) = (hume_voice_name IS NULL)` requires the RPC to write BOTH columns atomically. v1 RPC signature must extend accordingly:

```sql
CREATE OR REPLACE FUNCTION public.voice_clone_finalize_locked_v2(
  p_admin_user_id uuid,
  p_upload_id     bigint,
  p_creator_id    uuid,
  p_tts_provider  public.tts_provider,
  p_voice_id      text,
  p_voice_name    text,        -- NEW: required when p_tts_provider='hume', NULL allowed for cartesia
  p_force         boolean
) RETURNS TABLE(
  prior_voice_id   text,
  prior_voice_name text,        -- NEW: returned so the overwrite-enqueue path can pass voice_name to voice_delete_queue
  active_sessions  bigint
) ...
```

**RPC body invariants:**
- `p_tts_provider='hume' AND p_voice_name IS NULL` → RAISE EXCEPTION '22023 hume_voice_name_required'.
- `p_tts_provider='cartesia' AND p_voice_name IS NOT NULL` → ignored (Cartesia keys deletes by id; name not used).
- Cartesia branch unchanged: updates `creators.voice_id` AND writes `voice_clone_uploads.cartesia_voice_id`.
- Hume branch: updates `creators.hume_voice_id` AND `creators.hume_voice_name` in the same statement so paired-CHECK never sees an intermediate violation.
- Returns OLD values from both columns BEFORE the UPDATE so the route can enqueue them.

v1 RPC (`voice_clone_finalize_locked`) stays as a forwarding shim: calls v2 with `p_tts_provider := 'cartesia'`, `p_voice_name := NULL`.

**`voice_clone_uploads_block_update` trigger** (existing migration `20260427000003`): §3.2 extends it to enumerate `hume_voice_id`, `hume_voice_name`, `tts_provider` — same append-only contract as `cartesia_voice_id`. `hume_voice_id` and `hume_voice_name` allowed NULL→non-NULL once, MUST transition together; `tts_provider` is IMMUTABLE after insert. (R3 M3 fix.)

### 3.5 Migration: `20260520000005_cogs_aggregator_provider_aware.sql` — schema-side dashboard fix

Not strictly a schema change — but the cogs aggregator (`src/lib/admin/cogs-aggregations.ts`) currently keys on `operation` only, ignoring `service` (auditor C4). The migration adds a CHECK / index reminder; the actual TS rewrite is in §6.5.

---

## 4. `HumeTTSBridge` — `server/voice-proxy/hume-bridge.js`

Mirrors `cartesia-bridge.js` in interface; differs only in wire format and the cancellation strategy (Phase-0 check 6 drives the final choice).

### 4.1 Connection (with scrubbed-URL discipline from §2.0)

```js
const HUME_WSS = 'wss://api.hume.ai/v0/tts/stream/input';

function buildUrl({ apiKey, sampleRate }) {
  const qs = new URLSearchParams({
    version:       '2',
    instant_mode:  'true',
    strip_headers: 'true',
    format_type:   'pcm',
    no_binary:     'true',
  });
  // Phase-0 check 2 result gates this. If FAIL, omit the param and run server-side downsample (§4.4).
  if (sampleRate && sampleRate !== 48000) qs.set('sample_rate', String(sampleRate));
  const base = `${HUME_WSS}?${qs.toString()}`;
  const urlScrubbed = base;                            // safe to log
  const urlWithKey  = `${base}&api_key=${apiKey}`;     // constructor-local only
  return { urlWithKey, urlScrubbed };
}
```

EVERY log line in `hume-bridge.js` uses `urlScrubbed`. `urlWithKey` is used only at `new WebSocket(urlWithKey, ...)` and never stored on `this`. Unit test grep-asserts this.

### 4.2 Turn lifecycle

`turnStart(contextId)` — synchronous, mirrors Cartesia: record `_currentContextId`, reset `_charsThisTurn=0`, `_audioBytesThisTurn=0`, `_currentGenerationId=null`, `_sentFirstChunkOfTurn=false`. Throws same error codes.

`sendText(text)`:
- normalize via `tts-text-normalize.js`
- emit `{ text, voice:{ id: voiceId, provider:'CUSTOM_VOICE' }, ...(speedKnob != null ? { speed: speedKnob } : {}) }`
- DO NOT send `flush:true` per chunk — let Hume buffer. End-of-turn flush is in `turnEnd`.
- `_charsThisTurn += text.length`; assert `_charsThisTurn < HUME_CHARS_PER_TURN_HARD_CAP` (default 100,000, env-tunable). On breach → emit `error{code:'protocol_violation', fatal:true}`. M6 defense-in-depth.

`turnEnd({ timeoutMs = 10_000 })`:
- if nothing sent → resolve zero-non-partial (Cartesia parity).
- send `{ flush:true }`.
- await: (a) inbound chunk with `is_last_chunk:true` whose `generation_id === _currentGenerationId`, OR (b) deadline.
- **Pre-first-chunk timeout (Small): if no chunk arrives before deadline, `_currentGenerationId` is null → match logic returns partial unconditionally.** Explicit Promise: race `(generation-id-matched done) vs (deadline) vs (error event) vs (closed event)`. Return `partial:true` for the latter three.

`cancel()` — **strategy pinned by Phase-0 (2026-05-13): filter-by-generation_id**.

Phase-0 check 6 measured all three strategies; **none** stopped chunks within 200ms:
- `{flush:false}` mid-stream → 12 trailing chunks over 425ms
- `{close:true}` mid-stream → 14 trailing chunks over 428ms
- abrupt `ws.close()` → 6 trailing chunks over 297ms

Bridge implementation:
1. `cancel()` sets `_turnDead = true` synchronously and nulls `_currentContextId`.
2. NO on-wire cancel signal sent. WS stays open for the next turn.
3. `_onMessage` checks `_turnDead` AND `msg.generation_id !== _currentGenerationId` and drops chunks.
4. Hume's billing is per-character submitted, NOT per-audio-produced (verified via Hume docs). So unlike Cartesia, the dropped chunks were ALREADY paid for at the moment we sent the text — there's no per-cancel cost savings to chase. The `cancelled_after_chars` metric becomes informational only (track how often barge-in happens, not for cost-recovery).

Plan no longer gates on Phase-0 check 6 outcome — the table is filled.

`close()` — sends `{close:true}` then `ws.close(1000)`. Idempotent.

### 4.3 Inbound — `_onMessage`

```js
// Strict JSON only (Cartesia parity). Binary frame → protocol_violation fatal.
// Unknown `type` → warned-once non-fatal (Cartesia parity at lines 421-434 — Hume may add new envelope types post-launch; don't tear down sessions on first sighting).
```

On `type:'audio'`:
- if `_turnDead` → drop
- on first chunk of turn, lock `_currentGenerationId = msg.generation_id`. Drop chunks whose `generation_id !== _currentGenerationId`. This is the post-cancel race guard AND the cross-turn isolation.
- decode base64; `_audioBytesThisTurn += bytes.length`; emit `audio_out`.
- if `is_last_chunk:true` → emit `turn_done { contextId: _currentContextId }`.

On `type:'error'` — map via `HUME_ERROR_MAP`. Phase-0 check 10 captured TWO distinct shapes:
- **WS error envelope** (e.g. malformed JSON): `{ type:'error', code:'E0101', slug:'payload_parse', message:'…', request_id:'…' }` → map `slug` → bridge taxonomy.
- **REST error envelope** (DELETE/GET 4xx): `{ timestamp, status, error, message, path }` → only seen on REST, not WS.

On **silent WS close 1000 before any audio chunk arrives** (Phase-0 check 10a — bad voice id): bridge interprets this as `bad_voice_id` fatal error. Detection: track `_chunksReceivedThisTurn` per turn; if WS closes with `code===1000` AND `_chunksReceivedThisTurn === 0` AND `_sentFirstChunkOfTurn === true`, emit `error{code:'bad_voice_id', fatal:true}` regardless of whether Hume sent an explicit error envelope first. Phase-0 verified Hume sends nothing — just closes.

Initial `HUME_ERROR_MAP`:
```js
{
  payload_parse:     'protocol_violation',
  voice_not_found:   'bad_voice_id',  // hypothetical — Hume never returned this; silent close fires it
  rate_limited:      'rate_limited',
  // unknown slugs → 'other'
}
```

### 4.4 Sample-rate handling — RESOLVED via Phase-0

**Phase-0 verified 2026-05-13:** Hume's WS accepts `sample_rate=16000` AND `sample_rate=24000` as query params. Both rates produce decoded chunks at the requested rate.

**Implementation:** bridge constructor takes `sampleRate`; `buildUrl()` appends `&sample_rate=<rate>` when not 48000. Per-session value comes from `consumed.avatarProvider`:
- simli/tavus → 16000
- heygen → 24000
- legacy/fallback → 24000

**No downsampler dep needed.** The v0.3/v0.4 plan's polyphase-resampler hedge is dropped entirely. Saves ~2ms per chunk of CPU and one external dep.

### 4.5 Per-session sample rate (Small fix)

Bridge constructor takes `sampleRate` like Cartesia. `index.js` passes per-session value derived from `consumed.avatarProvider`:
- simli/tavus → 16000
- heygen → 24000
- legacy spike-a → 24000

Same `cartesia.open()` site at `index.js:851-862`, just behind the `if (ttsProvider === 'hume')` branch.

### 4.6 Tests — `server/voice-proxy/hume-bridge.test.js`

Mirror Cartesia's test file. Plus:
- secret-scrub test (Sentry harness; assert `api_key` redacted in captured event)
- generation-id-mismatched chunk dropped post-cancel
- pre-first-chunk timeout returns partial cleanly
- unknown envelope type emits warned-once non-fatal (NOT fatal)
- sample-rate fallback downsamples 48→24 within tolerance

---

## 5. Voice cloning — Scenario B only (Phase-0 verified 2026-05-13)

**Phase-0 result:** Hume has no programmatic audio-upload REST endpoint. `POST /v0/tts/voices` exists but requires `generation_id` (voice-design from prompt path, not audio clone). Scenario A (one-step in our admin UI) is not buildable today.

### 5.1 Scenario A — DEFERRED (Hume API gap)

Marked not-available pending Hume publishing an audio-upload REST endpoint. The existing Cartesia path at `/api/admin/voice-clone` keeps its current shape; only the route's `provider=hume` branch returns `503 hume_audio_upload_not_available` if anyone hits it.

Post-YC follow-up: monitor `dev.hume.ai/changelog` for an audio-clone endpoint announcement. When it ships, build the Scenario A branch as a 1-day PR.

### 5.2 Scenario B — UI-paste flow (the v1 path)

New route `POST /api/admin/voice-clone/hume-id`:
- Inputs: `creatorId`, `humeVoiceId` (UUID from Hume UI), `humeVoiceName` (string from Hume UI — REQUIRED for the DELETE flow).
- Validates id is non-empty ≤128 chars. Phase-0 check 11 confirmed Hume voice ids are UUIDs (36 chars) but plan does NOT enforce regex — column CHECK is the bound (defensive against Hume changing format).
- Validates name is non-empty ≤128 chars, ASCII-printable (Hume UI allows spaces and most punctuation; sanitize the same way Cartesia clone name does at `route.ts:130-134`).
- Sanity-checks both via `GET /v0/tts/voices?name=<name>&provider=CUSTOM_VOICE` (REST, `X-Hume-Api-Key`). Phase-0 verified this endpoint exists. Must return a row whose id matches the pasted id (paste-mistake guard).
- Writes via `voice_clone_finalize_locked_v2` with `metadata.source='hume_ui_paste'`, nulls for sha256/mime/duration on the audit row, populates `hume_voice_id` AND `hume_voice_name` on `voice_clone_uploads`.
- On overwrite (creator already has a Hume voice), enqueues the OLD voice into `voice_delete_queue` with `tts_provider='hume'`, `voice_name=<old name>`, `due_at=now()+60s`. Same 60s defer pattern as Cartesia (`voice-clone/route.ts:362-372`).
- Sentry breadcrumb tagged `hume_ui_paste`.

### 5.3 Rate caps — restructured for the A/B (M3)

Today: 3 successful clones/24h per admin (any provider), 20 attempts/24h. For the A/B period, an admin legitimately needs both Cartesia AND Hume clones of the same creator, plus retries. Today's cap pushes that to a 24h cooldown.

**New cap structure (as implemented after §5 audit M6 review 2026-05-13):**
- 3 successful clones/24h per admin **per provider** (so 6 total during A/B if running both).
- 20 attempts/24h **per provider** (so 40 total during A/B). The original plan said "total across providers" but the per-provider scope mirrors the success cap and lets an admin diagnose a Cartesia-side outage without burning the Hume cap (and vice versa). Each provider's failure budget is independent.
- Bypass list (`CREATOR_CLONE_RATE_LIMIT_BYPASS`) bypasses BOTH caps per existing semantics.

Implementation: change the route's rate-limit count query to a per-provider COUNT. The audit-table column `tts_provider` (added in §3.2) is the discriminator.

**R3-C2 fix — rate-cap query uses real columns, not non-existent `metadata`.** Scenario A is deferred (Phase-0 confirmed no audio-upload REST). For Scenario B, the audit row sets `tts_provider='hume'` + `hume_voice_id` + `hume_voice_name` (columns added in §3.2). The 24h cap query:

```sql
-- Cartesia path
SELECT COUNT(*) FROM voice_clone_uploads
 WHERE admin_user_id = :admin
   AND tts_provider = 'cartesia'
   AND created_at > now() - interval '24 hours'
   AND cartesia_voice_id IS NOT NULL;

-- Hume path (when Scenario A lands later, this same query covers both paths
-- since both set hume_voice_id on success — no metadata->>'source' distinction needed)
SELECT COUNT(*) FROM voice_clone_uploads
 WHERE admin_user_id = :admin
   AND tts_provider = 'hume'
   AND created_at > now() - interval '24 hours'
   AND hume_voice_id IS NOT NULL;
```

`voice_clone_uploads` has NO `metadata jsonb` column. The original v0.5 plan was wrong. Drop that clause; the `hume_voice_id IS NOT NULL` filter alone is sufficient because both Scenario A (when it ships) and Scenario B (today) set it on success. Explicit acceptance test: an admin who runs 3 UI-paste clones in 24h hits 3 — the next attempt 429s.

### 5.4 Voice-delete-worker — multi-provider dispatch (Phase-0 corrected 2026-05-13)

`server/voice-proxy/voice-delete-worker.js`:
- Constructor takes `{ supabase, apiKeys: { cartesia?, hume? } }`. NO required key at construction (R1-M1).
- Per-claimed row, reads `tts_provider`:
  - `cartesia` + has `cartesiaApiKey` → existing path: `DELETE https://api.cartesia.ai/voices/{voice_id}` with `Authorization: Bearer`
  - **`hume` + has `humeApiKey`** → `DELETE https://api.hume.ai/v0/tts/voices?name=${encodeURIComponent(row.voice_name)}` with `X-Hume-Api-Key` header. **Verified 2026-05-13.** 200/204 = success. 404 with body `{status:404, error:"Not Found", message:"Octave Custom Voice (NAME: ...) does not exist"}` = treat as success (already gone, dequeue). Any other 4xx/5xx = record failure, retry.
  - missing the key for the row's provider OR `tts_provider='hume'` AND `voice_name IS NULL` → leave row, log once, retry on next tick (does NOT bump `attempts`). R2-M3 amendment: after 24h of being unable to dispatch, bump attempts once per tick so the 10-attempt cutoff catches the orphan.
- Boot in `index.js` UNCONDITIONALLY (R1-M1). The "install only if cartesia enabled AND key present" gate at `index.js:1528` is removed.
- Add unit test for both paths.

**Same 30s tick cadence + 10-attempt cutoff + Sentry warnings at attempts=5 and 10 (existing pattern). The dedup `seenAlertedAttempts` Set keys on `${voice_id || voice_name}:5` / `:10` so Hume rows don't collide with Cartesia rows on shared voice-id-space.**

### 5.5 Writer discipline — `tts_provider` on EVERY clone-route write (R3-C3 fix)

The §3.2 follow-up `20260521000000_voice_clone_drop_default_tts_provider.sql` drops the DEFAULT on both `voice_clone_uploads.tts_provider` AND `voice_delete_queue.tts_provider`. Without explicit `tts_provider` in every INSERT/UPSERT, the next ?force=1 Cartesia overwrite would hit `23502 NOT NULL violation` and return 500 to the admin.

**Two file changes that MUST land BEFORE the DEFAULT-drop follow-up migration:**

1. **`src/app/api/admin/voice-clone/route.ts`** lines 228–244 (audit-row insert) — add `tts_provider: 'cartesia'` (or computed provider for the multi-provider variant).
2. **`src/app/api/admin/voice-clone/route.ts`** lines 317–321 (orphan-cleanup upsert on finalize failure) AND lines 362–372 (overwrite-path upsert) — both pass `tts_provider: 'cartesia'`. Hume orphan/overwrite paths in `src/app/api/admin/voice-clone/hume-id/route.ts` pass `tts_provider: 'hume'` PLUS `voice_name: oldName`.

**CI grep (`scripts/check-tts-provider-writes.sh` — new):**
- Must match every `\.(insert|upsert)\(` call site on `voice_clone_uploads` AND `voice_delete_queue`.
- Match must contain `tts_provider` as a literal key. Fail the build otherwise.
- The grep specifically covers both `.insert(` AND `.upsert(` (R2-Small extended pattern).
- Runs in pre-commit hook + CI workflow `.github/workflows/check-tts-provider.yml`.

**Order of operations (CRITICAL — out-of-order ships 500 errors to admins):**
1. §3.2 migration lands with `DEFAULT 'cartesia'` — existing routes keep working.
2. §5.5 route patches land in the SAME PR or earlier — every writer now passes `tts_provider` explicitly.
3. CI grep starts enforcing on the §5.5 PR.
4. ONLY after §5.5 ships to prod: §3.2 follow-up `20260521000000` drops the DEFAULT. By then no writer can be missing the column.

Plan §8 step sequence reflects this ordering.

---

## 6. Proxy `index.js` and admin dashboard wiring

After §2 renames, the diff is small. Concrete changes:

### 6.1 Provider snapshot — addresses R2-C1, R2-C4

The provider lives in `voice_tickets.tts_provider` (added in §3.2). `consumeTicket()` SELECTs it alongside the other ticket fields. NO fallback to env at consume time — env was read at mint time (`/api/sessions/open`) and burned into the ticket. The proxy never re-derives the provider.

```js
// In consumeTicket(), extend the SELECT list:
.select('user_id, creator_id, session_id, expected_tier, purpose, avatar_provider, system_prompt, prefix_turns, tts_speed, brain_mode, tts_provider')
// In the return object:
ttsProvider: data.tts_provider,  // NOT NULL by §3.2 constraint
```

Then in `index.js` (replacing `const useCartesia = VOICE_CARTESIA_ENABLED;` at line 673):

```js
const ttsProvider = consumed.ttsProvider;  // NOT NULL invariant from §3.2
const useTts = true;  // 'none' is not a value in the enum; future-extend if needed
```

**Why no env fallback in the consume path** (R2-C4): a stale ticket minted under env=`cartesia` must always run under cartesia, even if `VOICE_TTS_PROVIDER` flipped on Fly between mint and consume. The ticket is the contract. Env is only read at mint. Same architectural rule as `tier_at_session` (CLAUDE.md "Tier routing at session-open only").

### 6.2 Voice-id resolution + pre-WS gate — addresses R1-M4, R1-M5, R2-C5

`/voice-config` is extended to return the LIVE env state of the proxy:

```ts
type ProxyVoiceConfig = {
  useCartesia: boolean;          // back-compat
  ttsProvider: 'cartesia' | 'hume';  // the active env on Fly
  build: string;
  ts: number;
};
```

The 60s cache is unchanged. Vercel uses this only at session-open / clone-route entry, never mid-session.

`/api/sessions/open` derives the *session's* provider in this order, in code:

```ts
// Vuk-M5 fix: call getProxyVoiceConfig ONCE at top of handler, freeze, never re-read.
// Without the freeze a 60s-cache refresh OR a parallel Fly env flip between read and ticket-mint
// can race: creator.tts_provider is NULL → first read picks 'cartesia' → mint reads again → picks 'hume'.
const proxyCfg = await getProxyVoiceConfig();             // frozen for handler lifetime
const creator  = await fetchCreator(creatorId);
const sessionProvider: 'cartesia' | 'hume' =
    creator.tts_provider                                  // per-creator override wins
 ?? proxyCfg.ttsProvider;                                 // else inherit frozen proxy env
// sessionProvider is now non-null. Every downstream lookup (voice column resolution,
// ticket mint, sessions row insert) uses THIS local — never re-reads proxyCfg.
```

That value is the SINGLE source of truth from this point on. It is:
- written into `sessions.tts_provider_at_session` on session insert
- written into the freshly-minted `voice_tickets.tts_provider`
- read by `resolveVoiceId(creator, sessionProvider)` to pick the right voice column
- never re-read from env mid-session

`src/lib/voice/env-scoped-voice-id.ts` gets the new signature:
```ts
export function resolveVoiceId(creator, provider: 'cartesia'|'hume'): string | null;
export function voiceIdColumn(env, provider: 'cartesia'|'hume'): string;
```

All call sites updated in the same PR:
- `/api/admin/voice-clone/route.ts`
- `/api/sessions/open/route.ts`
- `/api/sessions/rollover/route.ts`
- `src/lib/voice/mint-voice-ticket.ts`

**Rollover route** (R1-C3 reinforcement): the route at `src/app/api/sessions/rollover/route.ts:131-135` today calls `getProxyVoiceConfig()` for `useCartesia`. The revision drops that call entirely and reads `sessions.tts_provider_at_session` from the session row instead. If the value is NULL (pre-migration session), fall back to `'cartesia'` (the only provider that existed). The same swap removes the 60s-cache mid-session-flip race.

**Pre-WS 409 gate** (R1-M5, R2-C5 resolved): the gate now reads the SESSION's provider (computed above) and checks the right voice column. Same gate fires for both providers — `409 creator_voice_not_trained` with detail `{ provider: sessionProvider }`. Silent cross-provider fallback is impossible because there is no env-fallback step in the consume path.

### 6.3 Provider-aware close codes

`4009 cartesia_no_voice` is kept for back-compat with the harness; a new `4014 tts_no_voice_<provider>` is emitted (detail field carries provider). Dashboards filter on the detail.

Allowlist gate (today: `CARTESIA_COMPATIBLE_MODELS`) renames to `TTS_COMPATIBLE_MODELS_BY_PROVIDER`:
```
{ cartesia: ['gemini-3.1-flash-live-preview'], hume: ['gemini-3.1-flash-live-preview'] }
```

### 6.4 Bridge instantiation

```js
if (useTts) {
  if (ttsProvider === 'cartesia') {
    ttsBridge = new CartesiaTTSBridge({ apiKey: CARTESIA_API_KEY, voiceId, sampleRate, ttsSpeed });
  } else if (ttsProvider === 'hume') {
    ttsBridge = new HumeTTSBridge({ apiKey: HUME_API_KEY, voiceId, sampleRate, ttsSpeed: consumed.ttsSpeed });
  }
  await ttsBridge.open();
}
```

The text-relay handler (`output_transcription_chunk` → `ttsBridge.sendText`) is provider-neutral after the rename.

### 6.5 Cogs aggregator — provider-aware (C4)

`src/lib/admin/cogs-aggregations.ts`:
- `LiveSessionAgg` gains `tts_provider: 'cartesia' | 'hume' | 'mixed' | null` + per-provider cost sub-totals.
- The grouping key for legs 3+4 becomes `(service, operation)`, not just `operation`.
- The `cartesia_pending_rows` counter stays (back-compat) but is gated on `service === 'cartesia'`.
- Add a "TTS provider breakdown" widget on `/admin/cogs` that reads `cogs_log.metadata.tts_provider` (written by RPC v2) AND joins on `sessions.tts_provider_at_session` for older rows.
- Add a regression test that mixes pre-migration cartesia rows + post-migration cartesia rows + Hume rows and asserts a clean per-provider time series.

### 6.6 v1 → v2 RPC overlap monitoring (R2-C2 + Vuk-C3 fix)

The original 7-day calendar countdown was wrong because:
1. The RPC caller is the Fly **proxy** (`server/voice-proxy/cogs-rpc.js`), not Vercel — see also M1 below.
2. Rolling Fly deploys = old VMs run for the lifetime of every in-flight WS session.
3. Sessions can sit open for 15 min (Gemini 3.1 audio cap), reopened across cap boundaries — a single user session can live for hours of wall-time.

**Decision (Vuk-C3): commit to the forwarding-shim approach indefinitely; no aggressive symbol drop.** Rationale: a no-op shim costs nothing operationally. `pg_stat_statements` is unreliable as a destructive-migration gate (Supabase has reset it during maintenance windows historically). Building a parallel `cogs_rpc_audit_log` table adds two more write paths to the per-turn hot path for one-time benefit. Neither cost is worth the risk of dropping a symbol that an old VM may still call.

**Concrete revised gate:**

1. v1 RPCs (`cogs_insert_turn_voice`, `voice_clone_finalize_locked`) become **forwarding shims** in the same PR that ships v2:
   - `cogs_insert_turn_voice` body = `SELECT cogs_insert_turn_voice_v2(<args>, p_tts_service := 'cartesia');`
   - `voice_clone_finalize_locked` body = `SELECT voice_clone_finalize_locked_v2(<args>, p_tts_provider := 'cartesia');`
   - Old proxy VMs calling v1 keep writing correct rows; only the entrypoint stays.
2. Shims stay **for at least 30 days** after the §8.7 cut-over (env flip to `hume`). A `DROP FUNCTION` migration is permissible after the gate below — but is not on the critical path.
3. If we ever drop the shim, the gate is calendar-only, not stat-based: ≥30 days since v2 deploy AND zero pre-v2-deploy-ts sessions still open. No `pg_stat_statements` dependency.
4. There is NO `cogs_rpc_audit_log` table. Don't add one for this purpose — it'd touch the per-turn hot path for a benefit you can buy with patience.

**Operational consequence:** the plan retires `VOICE_CARTESIA_ENABLED` env and drops DEFAULT clauses in §8.7 step 8, but does NOT drop the v1 RPC symbols. That's a Phase 2 task with its own micro-PR (one-line migration each) any time after the 30-day window.

---

## 7. A/B harness — `scripts/hume-vs-cartesia-ab.mjs`

20 canned questions × 2 providers using Vuk's cloned voice. Important M7 decision:

**Normalization policy (locked):** the A/B harness feeds **already-normalized** text (post `tts-text-normalize.js`) to BOTH bridges. Rationale: production input arrives from Gemini's `outputTranscription` and is run through the shared normalizer at the bridge boundary regardless of provider. A/B-testing on pre-normalized input would over-credit whichever provider handles curly quotes natively while under-crediting whichever lives behind the normalizer. The harness pins parity by normalizing upstream.

A *second* harness variant (`hume-vs-cartesia-ab-raw.mjs`) sends RAW Gemini-style text (curly quotes, em-dashes, NBSP) to both bridges with the normalizer disabled. Used to document "what would happen if we removed the normalizer." Not the decision input — informational only.

Outputs:
- `tmp/ab/q{NN}_{provider}.wav`
- `tmp/ab/ab-results.csv` with `q, cartesia_chars, hume_chars, cartesia_audio_seconds, hume_audio_seconds, cartesia_ttfa_ms, hume_ttfa_ms, cartesia_cost_usd, hume_cost_usd, cartesia_cancelled_after_chars (M2), hume_cancelled_after_chars`
- `docs/_planning/HUME_VS_CARTESIA_AB.md` with scoring placeholders.

Decision gate: Hume wins iff (a) sounds-like-Vuk ≥ Cartesia, AND (b) emotional fit ≥ Cartesia, AND (c) zero recurring artifacts, AND (d) p50 TTFA ≤ 1.5× Cartesia. Cost is tiebreaker.

---

## 8. Cut-over sequence (Hume wins case)

1. **§2.0 secret-scrub pre-work** lands first as standalone PR. CI scrub tests pass. Production unchanged.
2. **§2.1–2.7 interface refactor** (no behavior change). Cartesia test suite green. One real smoke session.
3. **§3.1–3.5 schema** lands. All columns nullable / safely backfilled. RLS test suite green.
4. **§4 Hume bridge + tests** + **§5 clone route + worker dispatch** + **§6 proxy wiring + dashboard**. `VOICE_TTS_PROVIDER` stays `cartesia` in prod env. Hume code merged but inactive.
5. **§7 A/B harness** runs against the real bridges. Score, decide.
6. **Single-creator live burn-in (M2/M5/Small Gemini-reopen)** — set `creators.tts_provider='hume'` on Vuk-as-creator-#1 only, clone Vuk on Hume, paste voice id. Run 48h of real sessions including at least one session that crosses the Gemini 3.1 15-min cap so the bridge-reopen path is exercised under Hume (parity with Cartesia behavior at `index.js:1291`).
7. Flip `VOICE_TTS_PROVIDER=hume` on Fly. 7-day production observation. Watch the new per-provider cost lines.
8. Retire `VOICE_CARTESIA_ENABLED` env (separate PR). Drop `cogs_insert_turn_voice` v1 RPC + `voice_clone_finalize_locked` v1 (migration `20260521000001_*`). Drop `valid 'cartesia'`-as-default behavior wherever it lingers.

**Roll-back at any step:** flip `VOICE_TTS_PROVIDER` back to `cartesia` on Fly OR NULL the creator's `tts_provider` override. Both take effect at next session-open. Mid-session swap remains forbidden (the bridge instance is fixed at open time).

## 9. What this plan explicitly does NOT do

- Ship Hume as the default provider before A/B verdict.
- Build a "fallback to Hume during Cartesia outage" path. Silent cross-provider fallback creates unauthorized cost-bucket migrations and breaks the cloned-voice contract on the user's end. On Cartesia outage today, sessions fail with `tts_failed`; that stays true.
- Per-session TTS hot-swap. CLAUDE.md forbids it.
- Touch the Gemini brain leg. User audio → Gemini 3.1 outputAudioTranscription → text remains the brain path on both providers.
- Reuse Cartesia voice ids on Hume (separate ID namespaces; separate columns).

## 10. Cost math — confirmed rates (2026-05-13)


**Cartesia (live Fly secret, confirmed by Vuk 2026-05-13):** `CARTESIA_USD_PER_CHAR=0.00005` → $50/1M chars.
**Hume Octave 2 (public, verified hume.ai/blog/octave-2-launch):** $7.60/1M chars → `HUME_USD_PER_CHAR=0.0000076`, `HUME_QUOTED_AT=2026-05-13`.

| Volume basis | Cartesia | Hume | Monthly Δ | Annual Δ |
| --- | --- | --- | --- | --- |
| 1B chars/mo (5M turns × 200c assumption) | $50,000 | $7,600 | **$42,400** | **$508,800** |
| 500M chars/mo | $25,000 | $3,800 | $21,200 | $254,400 |
| 100M chars/mo | $5,000 | $760 | $4,240 | $50,880 |

**Ceiling case** (committed-volume / dedicated deployment per launch blog "<1¢/min", ~$3.50/1M chars): at 1B chars/mo, ~$3,500/mo Hume cost — **~14× cheaper** than Cartesia. Negotiate at the bridge layer (CLAUDE.md §Core Architecture Principle rule 6), not in product code.

**TODO at implementation start:** replace the 200-chars/turn assumption with real p50/p95/mean from the `cogs_log` query. The delta scales linearly with chars/turn — the YC one-liner moves with the data.

## 11. Risks / open questions remaining post-Round-1

1. **Concurrent-connection cap** (Phase-0 9b) — if Hume caps Free-tier at, say, 5 concurrent, a small DAU spike bricks us. Phase-0 establishes the ceiling; we negotiate Pro/Enterprise BEFORE flipping prod.
2. **Cancellation cost waste** — Phase-0 check 6 + `cancelled_after_chars` metric in cogs metadata makes this visible. If `>5%` of cost is post-cancel, halt cut-over and revisit Hume's cancel semantics with their team.
3. **Voice clone friction** (Scenario B) — every new creator needs a manual UI paste. v1 acceptable for one creator (Vuk). At 50+ creators the paste-form becomes burden. Hold a v1.5 ticket for the Hume REST clone endpoint once it's published.
4. **Octave 2 live-conversation interleavings** — Phase-0 measures TTFA on canned single utterances. Real conversations interleave barge-in + backpressure + Gemini reopens. Step 6 of §8 is the live-traffic gate.
5. **Hume + Gemini 3.1 outputAudioTranscription combo** — same wire chain as Cartesia but never exercised end-to-end. The bridge is identical from the proxy's POV (text in → audio out); the risk is that Hume's chunk cadence + Gemini's transcription cadence interact badly. Phase-0 check 5 exercises this.

## 12. Estimated effort (updated)

| Step | Effort | Gates on |
| --- | --- | --- |
| §2.0 secret-scrub pre-work | 1–2h | nothing — lands first |
| §1 Phase-0 spike script | 3–5h | HUME_API_KEY in dev |
| §2.1–2.7 interface refactor | 3–4h | green CI on Cartesia tests |
| §3.1–3.5 schema + RPCs | 3–4h | RLS test suite green |
| §4 HumeTTSBridge + tests | 4–6h | Phase-0 complete |
| §5 voice-clone + worker + caps | 3–4h (A) or 2h (B) | Phase-0 check 7 |
| §6 proxy + dashboard | 2–3h | §2+§4 |
| §7 A/B harness | 2h | §4 live |
| §8 cut-over | low-touch, mostly observation | §7 verdict |
| **Total active dev** | **~22–32h** | — |

About three solid focused days. CLAUDE.md is right: this is the swap the architecture was built for.

---

## 12.5 Admin UI surface for the new dials — Vuk-M4 fix

CLAUDE.md's "production from line one" rule: every new column the operator touches needs a UI. v0.3 introduced two operator-facing columns (`creators.tts_provider`, `creators.hume_voice_id*`) and one operator-facing dial (`creators.hume_tts_speed`) without specifying where the admin sets them. Hand-running `UPDATE creators SET tts_provider='hume' WHERE id='…'` against prod violates the rule.

**Concrete UI work for v1 (lands in §5 PR):**

1. **`/admin/creators/[id]/page.tsx`** gains a "TTS Provider" section:
   - Read-only display of `tts_provider` (current value), `voice_id` (Cartesia, env-scoped), `hume_voice_id` (env-scoped).
   - A dropdown to set `tts_provider`: `inherit env (default)` | `cartesia` | `hume`. Wires to a new server action `setCreatorTtsProvider(creatorId, value)` that calls `assertAdminFromSession` then issues a service-role UPDATE.
   - A "Hume clone" panel:
     - If Phase-0 confirms Scenario A (REST audio-upload works): a "Clone on Hume" button that posts to `/api/admin/voice-clone` with `provider=hume`. Re-uses the existing Cartesia clip-upload widget.
     - If Phase-0 confirms Scenario B (UI-paste only): a "Paste Hume voice id" form that posts to `/api/admin/voice-clone/hume-id`. Two fields: voice id + name.
   - A "Hume speed" knob (numeric input, [0.5, 2.0], default empty/null) wires to `setCreatorHumeTtsSpeed(creatorId, value)`. Phase-0 check 13 result populates the placeholder text with calibration hints (e.g. "1.2 here ≈ 1.0 on Cartesia").

2. **Server actions** (`src/app/admin/creators/[id]/actions.ts`):
   - `setCreatorTtsProvider(creatorId, value)`
   - `setCreatorHumeTtsSpeed(creatorId, value)`
   - Both follow the existing pattern: `assertAdminFromSession` → field whitelist → mutate → `revalidatePath('/admin/creators/' + creatorId)`. No `window.location.href` redirect because we're not changing auth state.

3. **Active-session guard**: the server actions REJECT a provider flip if `creators_active_session_count(creatorId) > 0` — mirrors the voice-clone overwrite gate in `voice_clone_finalize_locked`. Otherwise a mid-session provider change would split-brain the proxy. Returns `409 creator_has_active_sessions`.

4. **COGS dashboard widget** (§6.5) gains a "TTS provider breakdown" card on `/admin/cogs`. Provider color-coded; click-through to per-creator breakdown.

This adds ~2–3 hours to the §6 estimate. Folded into the revised effort table in §12.

---

## 13. Coordination with the RAG SOTA plan — naming only

RAG SOTA Phase 1 has landed (migrations `20260514*` + `20260515000001`–`20260515000005`). RAG Phase 2 has a plan written (`docs/_planning/RAG_SOTA_PLAN.md` v4) but is not yet implemented. Single operator (Vuk); plans execute sequentially, not in parallel.

**Actual overlap surface — verified against the RAG plan's §6 file table 2026-05-13:**

| Surface | Overlap with Hume plan | Action |
| --- | --- | --- |
| Migration filenames | RAG Phase 2 reserves `20260516000001`–`20260516000002` | **Resolved** — Hume baseline at `20260520*` |
| `server/voice-proxy/index.js` | RAG adds +200 lines (retrieve-path wiring at bridge-event handlers); Hume renames `cartesia`→`ttsBridge` at instantiation + dispatch | Standard git merge. Different sites; if both plans execute, second one rebases. ~5 min conflict resolution if any. |
| `cogs_log.metadata` JSON shape | RAG adds `rerank_provider`, `rewrite_ms`, etc. — **JSON-additive only**, no RPC signature change | No conflict — Hume's metadata writes use separate keys (`tts_provider`) |

**Surfaces I previously claimed overlapped but actually do NOT** (corrected after Vuk caught my overcooked framing):
- `server/voice-proxy/cogs-rpc.js` — RAG plan does not touch this file.
- `src/lib/admin/cogs-aggregations.ts` — RAG plan does not touch this file. Aggregator stays Hume's exclusive territory.
- `cogs_insert_turn_voice` RPC signature — RAG metadata is additive through the existing RPC; no signature change needed from RAG side.

**Operational rule:** when picking new migration slots, re-`ls supabase/migrations/2026052*.sql` once before opening the §3 PR. If anything has shipped in the `20260520*` range since this plan was written, bump to the next free 4-digit suffix. That's it. No "two-PR rebase ballet" needed.

---

## Round-3 audit fixes (v0.6) — Vuk approval gate

### C4 fix — Hume name-uniqueness guard

Hume keys DELETE by name. If admin clones Vuk twice on Hume with the same name, then enqueues delete on the OLD voice, the worker hits `DELETE /v0/tts/voices?name=Vuk` 60s later — and Hume could delete BOTH copies (or the most-recent one — behavior unverified). Either way: the NEW voice that `creators.hume_voice_id` points to could vanish, breaking the session at next open.

**Three-part defense:**

1. **§5.2 paste route refuses same-name overwrite.** If new `hume_voice_name === creators.hume_voice_name` (current value), return `409 hume_name_collision`. Admin must use a unique name. No exceptions.

2. **§5.2 paste route GET-sanity-check verifies exactly-one match.** Before accepting the paste, call `GET https://api.hume.ai/v0/tts/voices?name=<name>&provider=CUSTOM_VOICE` with `X-Hume-Api-Key`. The response must contain EXACTLY ONE row matching the pasted name. If zero → `404 hume_voice_not_found`. If >1 → `409 hume_name_ambiguous`. The route also verifies the returned row's id field matches the pasted id (paste-mistake guard).

   **R3-M4 field-name resilience:** Hume's response shape uses `id` per the Phase-0 GET response (`{"voices_page":[{"id":"...","name":"...","provider":"CUSTOM_VOICE"...}]}`). Route reads `body.voices_page[0].id`. Verified empirically 2026-05-13 — not inferred from docs.

3. **§12.5 admin UI auto-suffixes voice names by default.** The "Paste Hume voice id" form pre-populates the name field with `${creatorSlug}-${YYYYMMDDHHMM}` (e.g., `vuk-202605131830`). Admin can edit but the default-suffix makes duplicates impossible by construction. Admin UI shows a warning if they remove the suffix.

### C5 fix — tighter `hume_tts_speed` CHECK

> **v0.7 REVERSAL (2026-05-13):** This narrower CHECK was reverted to `[0.5, 2.0]` after the founder's measured demo at speed=1.5 on Octave 2 verified dramatic improvement. See v0.7 deltas at the top of this doc. Section preserved below as historical context.


Phase-0 measured speed=1.15 producing 4× longer audio than speed=1.0 for the same sentence. Root cause likely interaction with the voice's baked-in speed (Vuk trained at 1.5 in Hume UI). Until calibration data refutes the anomaly, the CHECK constraint:

```sql
hume_tts_speed numeric CHECK (
  hume_tts_speed IS NULL OR
  (hume_tts_speed >= 0.85 AND hume_tts_speed <= 1.10)
)
```

Tightened from `[0.5, 2.0]` to `[0.85, 1.10]`. Reasoning: the synthesis-time speed knob is FINE-TUNING on top of the baked-in voice (which already encodes the creator's intended cadence). A 15% adjustment window is generous. An admin who needs more range goes to app.hume.ai/voices and re-trains the voice with a different baked-in speed.

**Belt-and-suspenders:** the bridge emits `error{code:'tts_cadence_anomaly', fatal:false}` (Sentry breadcrumb only) if a turn produces `audioBytes > _charsThisTurn * MAX_BYTES_PER_CHAR_AT_SPEED * 2`. Doesn't stop the bad turn but flags it for the next-deploy data-driven decision.

**Calibration path:** §8.6 burn-in step explicitly tests speed values at boundary [0.85, 0.95, 1.0, 1.05, 1.10] against a 60-second reference phrase. If any value produces an audio_seconds:chars ratio outside ±15% of the speed=1.0 baseline → widen the cadence-anomaly Sentry threshold AND/or tighten the CHECK further.

### S10 fix — drop no-op aggregator migration

§3.5 `20260520000005_cogs_aggregator_provider_aware.sql` had no DDL ("not strictly a schema change"). Removed entirely — the work is in `src/lib/admin/cogs-aggregations.ts` (§6.5), not a migration. A migration with no DDL is a footgun; future agents see it and assume DB state changed.

§6.5 stays as the implementation site. Added: comment in `cogs-aggregations.ts` referencing the §6.5 plan section.

### M1 fix — `_sentFirstChunkOfTurn` flag setting

§4.2 `sendText` body explicitly sets `_sentFirstChunkOfTurn=true` after the FIRST successful `ws.send(...)` of the current turn. Without this the §4.3 bad-voice-id detection guard never fires.

### M2 fix — bad-voice-id false-positive guard

§4.3 bad-voice-id detection adds a `_msSinceFirstSend > 1500` floor: a sub-second WS close 1000 is treated as transient (`tts_transient_close`, non-fatal, bridge auto-reconnects). Only persistent zero-chunks-for->1.5s-after-send becomes fatal `bad_voice_id`. 1500ms threshold is 2× Phase-0's measured p95 TTFA — generous margin.

### M5 fix — `voice_delete_queue` composite PK

§3.2 amendment: drop the single-column PRIMARY KEY on `voice_id`, recreate as composite `(tts_provider, voice_id)`. Both upsert sites in `voice-clone/route.ts` change to `onConflict: 'tts_provider,voice_id'`. `voice_delete_queue_complete` RPC takes both args. Prevents the (vanishingly unlikely but conceptually wrong) Cartesia ↔ Hume UUID collision.

### M6 fix — admin UI server-action paired validation

§12.5 `setCreatorHumeVoice(creatorId, {id, name})` validates BOTH non-null at the application layer before issuing UPDATE. `setCreatorHumeVoice(creatorId, {id: null, name: null})` is the only "clear" operation; either-but-not-both returns 400 `paired_required`. The paired-CHECK constraint is the last line of defense; app-layer rejection is the first.

### M7 fix — worker 404-renamed-voice safeguard

§5.4 worker before issuing DELETE: optionally call `GET /v0/tts/voices?name=<stored_name>&provider=CUSTOM_VOICE`. If returned id matches the id stored at enqueue time → proceed with DELETE. If returned id differs (voice was renamed in Hume UI) → bail, Sentry warning `hume_voice_renamed_in_ui`, leave row in queue for manual cleanup. Cost: 1 GET per delete tick (cheap). Trade-off: avoids deleting an unrelated voice that happens to share the old name.

---

## Round-2 audit fixes — additional sections applied

### Vuk-Small fixes
- §4.1 line-number drift: actual normalization is `cartesia-bridge.js:211-215`, not :210-215. Plan re-snaps line numbers at implementation time.
- §4.2 `turnEnd` race condition: race-Promise explicitly includes `WebSocket.readyState !== OPEN` as a 4th leg (resolves `partial:true`). The Cartesia bridge inherits the same legs in this PR — same fix.
- §4.6 test list adds: "WS close with abnormal code 1006 mid-stream returns partial cleanly" (Cartesia bridge has this; Hume gets parity).
- §7 A/B decision-gate: Vuk has already heard Hume on the website and called it "REALLY GOOD." The A/B is the verification ritual CLAUDE.md mandates, not a discovery. If the harness output is even close to dramatic, ship — don't slow-walk for ceremony.
- §8 step 6 burn-in: ≥2 Gemini reopens (≥30 min live session, two cap crossings) instead of "at least one." Second reopen is where state-accumulation bugs hide.
- §2.0 step 3 verification: `redactSensitive` covering `api_key`/`access_token` is confirmed correct at `sentry.server.config.ts:75` (audit verified). No change needed Next-side.

### Worker bounded-retry (R2-M3)
§5.4 worker behavior amended: if a row has been waiting on a missing key for >24h since `due_at`, the worker MAY bump `attempts` once per tick (instead of "never bump") so the existing 10-attempt cutoff catches the orphan. The `seenAlertedAttempts` Set is extended with a `:key_missing` sentinel that dedups the "key permanently missing" log per `voice_id` per process boot.

### Gemini-reopen TTS bridge reset (R2-M4)
At `index.js:1291` (Gemini reopen path), after `bridge.open()` succeeds and before any `ttsBridge.turnStart()`, the proxy explicitly calls `ttsBridge.cancel()` to clear `_currentContextId` / `_currentGenerationId` / `_charsThisTurn`. Without this, the post-reopen first turn on Hume may filter out its own chunks via the §4.3 generation-id lock. Cartesia bridge inherits the same call (no-op on idle bridge); cheap defense.

### Cancel-strategy run-time vs deploy-time (R2-M5)
The §4.2 cancel strategy is **deploy-time, not run-time**. Phase-0 check 6 fills in the HUME_PHASE_0.md table once; the bridge ships with the chosen branch hard-coded. If Hume changes the protocol later, a separate PR re-runs the spike and re-pins the strategy. No runtime dispatch.

**A/B harness asymmetry note (R2-M5)**: `cartesia_cancelled_after_chars` is added to `cartesia-bridge.js` as a parallel metric so the §7 harness compares like-for-like. Cartesia's cancel sends `{cancel:true}`; chunk-count post-cancel is measured the same way. Small additive change to the existing bridge.

### Char-cap drift coupling (R2-Small)
`HUME_CHARS_PER_TURN_HARD_CAP` (env-tunable, default 100,000) and `cogs_insert_turn_voice_v2`'s `p_tts_characters` upper bound 100,000 are load-bearing-coupled. Add a top-of-file comment in `hume-bridge.js` mirroring the `OUTPUT_TRANSCRIPT_MAX_CHARS=4000 ↔ voice_accumulate_seconds 3600s` pattern in CLAUDE.md: bumping one without re-running the chain breaks the kill-switch.

### Cogs aggregator test-fixture update (R2-M6)
§6.5 explicitly lists "update `cogs-aggregations.test.ts` to set `service:'cartesia'` on every fixture that asserts `cartesia_pending_rows`." If left implicit the implementer wastes 30 minutes; this line saves that.

### `creators.hume_tts_speed` (R2-M7 + Vuk-M6 fix)

`creators.tts_speed` was tuned against Cartesia Sonic 3 (range [0.6, 1.5]; the column has a CHECK constraint pinning to that). Hume's `speed` field semantics may differ.

**Revised decision (Vuk-M6 fix):** **always add `creators.hume_tts_speed`** in §3.2 with permissive `CHECK (hume_tts_speed IS NULL OR (hume_tts_speed >= 0.5 AND hume_tts_speed <= 2.0))`. The earlier "TBD-add-if-spike-says-so" plan created a two-edit migration drift between staging and prod. Cost of an extra always-present nullable column: zero. Cost of revising a migration mid-stream: real (the migration must be re-run against staging AFTER each edit).

§6.4 reads `consumed.humeTtsSpeed` for the Hume bridge (NULL → omit `speed` field, Hume default); `consumed.ttsSpeed` for Cartesia. Voice-tickets carries both columns (`tts_speed`, `hume_tts_speed`) — same passthrough pattern as `tts_provider`.

**Phase-0 check 13** still runs and produces the verdict: measure Hume Octave 2 cadence at speed=0.85, 1.0, 1.15 against a reference utterance. Document the range. If Hume's "1.5 speed" feels like Cartesia's "1.2 speed", that's the calibration record. The column exists either way; the spike calibrates the SET values the admin UI offers (M4 below).

### Per-creator-per-provider clone uniqueness (R2-M2)
§3.2 adds NO unique index on `(creator_id, tts_provider)` for `voice_clone_uploads` — clones are an audit ledger, multiple rows per creator/provider are expected. **But** §3.4 `voice_clone_finalize_locked_v2`'s Hume branch MUST read the prior `creators.hume_voice_id` (env-scoped) and enqueue it into `voice_delete_queue` with `tts_provider='hume'` + `due_at=now()+60s` — mirroring the Cartesia flow at `voice-clone/route.ts:362-372`. If the prior id isn't enqueued, Hume voices leak. Explicit acceptance test: clone Vuk on Hume twice, assert one row lands in `voice_delete_queue` with the first voice id and `tts_provider='hume'`.

### Stack-frame scrub (R2-Small)
§2.0 step 5 — the `ws` library error wrapper rewrites `message` AND scrubs `stack` for `api_key=` substrings. Some node versions inline the failing URL into `stacktrace.frames[*].context_line`; the §2.0 step 2 proxy beforeSend pass covers that anyway, but the wrapper is the first line of defense.

### voice-tickets row shape change (R2-C1 follow-through)
`src/lib/voice/mint-voice-ticket.ts` `MintVoiceTicketArgs` interface gets `ttsProvider: 'cartesia' | 'hume'` as a required field. `/api/sessions/open` computes the provider per §6.2 and passes it. CI grep verifies every `mintVoiceTicket(...)` call site provides the field — otherwise TS compile fails.

### CI grep — INSERT + UPSERT both (R2-Small)
§5.5 grep pattern explicitly covers `.insert(...)` AND `.upsert(...)` on `voice_clone_uploads` + `voice_delete_queue`. Today the orphan-cleanup path at `voice-clone/route.ts:317-321` uses `.upsert(...)` — a grep limited to `.insert(` would miss it.

### Filename slot re-verification (R2-Small)
§8.1 first task: re-`ls supabase/migrations/2026051*.sql` immediately before opening the §3 PR. If new migrations have landed in the 20260516* slot since this plan was written, bump to 20260517*. (The §8.7 retire-migration filename also shifts accordingly.)

### Close-code reason-string discipline (R2-Small)
Close code 4014 is one uint16 value; provider is in the REASON string: `4014 tts_no_voice:cartesia` or `4014 tts_no_voice:hume`. Existing 4009 stays with reason `cartesia_no_voice` for harness back-compat.

### v1 RPC retire — files that reference VOICE_CARTESIA_ENABLED (R2-Small)
§8.7 step 8 explicitly lists the test files that need updating when `VOICE_CARTESIA_ENABLED` env is retired: `server/voice-proxy/cogs-rpc.test.js` lines 231, 263, 298, 318, 335. Same PR as the env retire.

### Cost math p50 vs p99 (R2-Small)
§10 — change the headline math from "200 chars/turn avg" to a p50/p99 split. Pull real `cogs_log` data:
```sql
SELECT PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY units) AS p50,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY units) AS p99
FROM cogs_log
WHERE service='cartesia' AND operation='voice_tts_characters'
  AND created_at > now() - interval '14 days';
```
Substitute both into the cost projection before YC numbers go out.

---

## Round-1 audit findings — disposition

| Round | # | Severity | Item | Disposition |
| - | - | --- | --- | --- |
| R1 | C1 | Critical | API key leak via WS URL → Sentry/Loki | §2.0 pre-merge PR, scrub tests, `urlScrubbed` discipline, exception-value scrub (R2-M1 reinforcement) |
| R1 | C2 | Critical | Migration filename collision on 20260514* | §3 moved to 20260516*; §8.1 adds re-verify step before PR (R2-Small) |
| R1 | C3 | Critical | Rollover re-reads `/voice-config` mid-session | §2.5 + §6.2 — rollover reads `sessions.tts_provider_at_session` snapshot, never env |
| R1 | C4 | Critical | NULL snapshot + aggregator-by-operation double-count | §3.2 backfill + §6.5 aggregator rewrite + RPC v2 writes provider into metadata; §6.5 explicitly updates existing test fixtures (R2-M6) |
| R1 | C5 | Critical | DEFAULT 'cartesia' silently mis-tags Hume rows | §3.2 two-step: keep DEFAULT through §5 deploy, drop DEFAULT in follow-up migration after CI grep enforces explicit writes (R2-C3 fix supersedes R1 NOT NULL no-default) |
| R1 | M1–M7 | Medium | (boot symmetry, cancel metering, rate caps, resolveVoiceId, pre-WS gate, char cap, normalization) | All resolved in §§4.2/5.3/5.4/6.2/6.5/7 |
| R1 | Small ×11 | — | per-session rate, timeout race, unknown envelope, UUID, v1 alert, reopen test, concurrent cap, real $/1M, var rename, ALTER TYPE split, tri-state | All addressed in-line |
| R2 | C1 | Critical | `voice_tickets.tts_provider` column missing | §3.2 adds column NOT NULL with backfill + in-flight DELETE; §6.1 reads from ticket; mint signature updated |
| R2 | C2 | Critical | v1 RPC drop while in-flight WS sessions still calling it | §6.6 — v1 becomes a forwarding shim; drop-symbol migration gated on "zero open sessions older than v2 deploy ts" |
| R2 | C3 | Critical | NOT NULL no-DEFAULT bricks live clone route during deploy window | §3.2 two-step DEFAULT — keep through §5 deploy, drop in follow-up |
| R2 | C4 | Critical | Consume-side env fallback could route to Hume on stale ticket | §6.1 removes env fallback entirely; ticket-only source of truth |
| R2 | C5 | Critical | Vercel pre-WS gate can't know proxy provider | §6.2 — `/voice-config` returns `ttsProvider`; gate reads per-creator override OR proxy env; gate checks the right voice column |
| R2 | M1 | Medium | Sentry exception-value scrub missing on proxy | §2.0 step 2 added; correction of Next-side function name |
| R2 | M2 | Medium | Voice-clone uniqueness + Hume prior-id leak | §3.4 Hume branch enqueues prior id to delete-queue; acceptance test specified |
| R2 | M3 | Medium | Worker unbounded retry on missing key | §5.4 + Round-2 section — bumps attempts after 24h, dedup `seenAlertedAttempts` for key-missing case |
| R2 | M4 | Medium | Gemini reopen doesn't reset Hume bridge state | Round-2 section — explicit `ttsBridge.cancel()` after `bridge.open()` succeeds in the reopen path |
| R2 | M5 | Medium | Cancel strategy run-time vs deploy-time + asymmetric A/B cancel metric | Round-2 section — deploy-time pinned; Cartesia bridge adds parallel `cancelled_after_chars` so A/B is symmetric |
| R2 | M6 | Medium | Aggregator test-fixture update implicit | §6.5 Round-2 section spells out the test-file fix |
| R2 | M7 | Medium | tts_speed semantics may differ between providers | Round-2 section — adds Phase-0 check 13 + provisional `creators.hume_tts_speed` column |
| R2 | Small ×11 | — | (filename slot re-verify, backfill scope, char-cap drift comment, warned-once key, GET sanity-check Phase-0 sub-check, normalizer grep, ENV retire test list, worker constructor break, stack-frame scrub, close-code reason discipline, cost math p50/p99) | All addressed in Round-2 fixes section |
| Vuk | C1 | Critical | Migration slot collision with RAG Phase 2 (20260516*) | Hume baseline moved to **20260520\***; §13 coordination section added |
| Vuk | C2 | Critical | Hume chunk `text` field bypasses `TRANSCRIPT_KEYS` scrub → avatar transcript leaks to Sentry | §2.0.1 — `TRANSCRIPT_KEYS` extended with `hume_chunk_text`/`snippet_text`/aliases; bridge logging discipline; CI grep on `JSON.stringify(msg)`; Phase-0 check 14 |
| Vuk | C3 | Critical | v1 RPC drop gate relied on unreliable `pg_stat_statements` | §6.6 rewritten — forwarding shim stays indefinitely; calendar-only gate ≥30 days; no audit-log table |
| Vuk | M1 | Medium | §3.3 "Vercel switches to v2" wording misleading | §3.3 corrected: caller is the **Fly proxy**, not Vercel |
| Vuk | M2 | Medium | 48→16/24kHz downsampler understated effort | §4.4 — ask Hume first, ship real `libsamplerate`/`speex-resampler` second, block third; no homemade 3-tap FIR |
| Vuk | M3 | Medium | Char cap asymmetric (Hume 100k, Cartesia 200k) | §3.3 — unified at 100k for BOTH providers in v2 RPC |
| Vuk | M4 | Medium | No admin UI for `creators.tts_provider` / `hume_voice_id*` / `hume_tts_speed` | §12.5 — admin UI + server actions + active-session-flip guard |
| Vuk | M5 | Medium | Env-flip race at `/api/sessions/open` | §6.2 — `getProxyVoiceConfig()` called ONCE and frozen for handler lifetime |
| Vuk | M6 | Medium | Phase-0 check 13 stub-migration drift | Always add `creators.hume_tts_speed` with permissive CHECK; spike calibrates UI defaults, not the schema |
| Vuk | M7 | Medium | Rate-cap query may miss UI-paste Scenario B clones | §5.3 query covers both Scenario A and B; explicit acceptance test |
| Vuk | Small ×6 | — | (line-number drift, readyState OPEN leg, 1006 close test, A/B ceremony note, ≥2 reopens in burn-in, redactSensitive verified) | All addressed in "Vuk-Small fixes" section |

---

End of plan v0.4. Awaiting Vuk's approval gate (per CLAUDE.md §Planning Loop):

```
[1] Approve & auto-execute
[2] Approve & confirm each step
[3] Keep planning (run a 3rd audit round)
[4] Changes: ___
```

Note: per memory `feedback_audit_loop.md` Vuk specifically wants to decide whether to run a third audit. Two rounds delivered as requested.
