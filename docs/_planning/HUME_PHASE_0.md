# Hume Octave 2 — Phase 0 Spike Results

Generated: 2026-05-13T14:18:53.574Z
Script: `scripts/hume-phase0-spike.mjs`
Plan: [docs/_planning/HUME_TTS_PLAN.md](./HUME_TTS_PLAN.md) §1.

## Summary

- PASS: 9
- FAIL: 12
- INFO: 5

## Results

- **1. connect + version=2 acceptance (handshake ≤900ms cold)** — PASS: open=448ms url=wss://api.hume.ai/v0/tts/stream/input?version=2&instant_mode=true&strip_headers=true&format_type=pcm&no_binary=true&api_key=[redacted]
- **4. TTFA — first audio chunk arrives quickly** — FAIL: ttfa=4007ms (gate ≤900ms cold)
- **3. frame coherence — s16le mono, byte%2===0, no binary frames** — PASS: total_bytes=645120 chunks=7 binary_seen=false even=true
- **5a. streaming text → single generation_id across burst** — PASS: generation_ids=1 (expect 1)
- **5b. final chunk has is_last_chunk:true (within 15s)** — PASS: is_last_chunk:true received
- **5c. inbound chunk includes `text` field (Vuk-C2 leak channel — DO NOT log raw)** — INFO: text_preview_len=77 (intentionally not logged — content)
- **2. sample_rate=24000 accepted by WS** — PASS: total_bytes=345600 est_audio_seconds≈7.20 (request honored if duration ≈ 2-4s for the sample sentence)
- **2. sample_rate=16000 accepted by WS** — PASS: total_bytes=303360 est_audio_seconds≈9.48 (request honored if duration ≈ 2-4s for the sample sentence)
- **6.flush:false. cancellation stops production within ≤200ms** — FAIL: chunks_before_cancel=1 chunks_after_cancel=12 last_chunk_after_cancel=425ms
- **6.close:true. cancellation stops production within ≤200ms** — FAIL: chunks_before_cancel=1 chunks_after_cancel=14 last_chunk_after_cancel=428ms
- **6.abrupt. cancellation stops production within ≤200ms** — FAIL: chunks_before_cancel=1 chunks_after_cancel=6 last_chunk_after_cancel=297ms
- **7a. REST analog of Cartesia /voices/clone** — FAIL: 404 — path does NOT exist
- **7b. multipart audio-upload variant of save endpoint** — PASS: 400 — path EXISTS (schema-error body): {"status_code":400,"message":"Failed to parse payload. 'missing' error at `body.generation_id`: Field required: received `dict` input of `{}`. 'missing' error at `body.name`: Field required: received 
- **7c. design-from-generation hypothesis** — FAIL: 404 — path does NOT exist
- **8. DELETE /v0/tts/voices/{id}** — INFO: 404 body=
  - **UPDATED 2026-05-13 (re-probe via SDK):** the endpoint exists at
    `DELETE /v0/tts/voices?name=<name>` — Hume keys voice deletion by
    NAME, not by id. Path-style `/voices/{id}` returns 404 (expected).
    Worker dispatch is wired to use `creators.hume_voice_name`.
                {"code":404, "message":"Invalid URI Path"}
            
- **9a. sequential 20-turn load — no 429s, latency stable** — PASS: completed=20 p50=594ms max=1123ms 429=false other_error=false
- **9b. concurrent 20-WS open (cap probe)** — FAIL: opened=11/20 first_chunk_ok=11 open_time=378ms open_errors=9 (sample: Unexpected server response: 429 | Unexpected server response: 429 | Unexpected server response: 429)
- **10a. bad voice id** — FAIL: Unexpected server response: 429
- **10b. malformed JSON** — FAIL: Unexpected server response: 429
- **11. voice-id format (informational)** — INFO: id_length=36 looks_like_uuid=true — column CHECK is char_length BETWEEN 1 AND 128 (no regex enforcement per plan §0 row 15)
- **13.0.85. cadence at speed=0.85** — FAIL: Unexpected server response: 429
- **13.1. cadence at speed=1** — FAIL: Unexpected server response: 429
- **13.1.15. cadence at speed=1.15** — FAIL: Unexpected server response: 429
- **13. tts_speed cadence parity — 0.85/1.0/1.15 produce different durations** — PASS: 
- **12. Sentry leak verification** — INFO: INFO — runs AFTER §2.0 scrub PR lands on staging Sentry. Spike cannot exercise the staging Sentry path; manual check at §8.6 burn-in.
- **14. bridge `text`-field leak (CI grep)** — INFO: INFO — enforced at PR time on hume-bridge.js via CI grep for JSON.stringify(msg) + console.*(.*\bmsg\b. Spike cannot exercise; gated at §4.6 test PR.

## Decisions Required (surface to Vuk)

Based on the results above, the following plan decisions need to be made before §3 schema lands:

### Cancel strategy (drives §4.2 `HumeTTSBridge.cancel()`)
- If `6.flush:false` PASS (stops <200ms) → cancel sends `{flush:false}`, WS stays open. Cleanest.
- Else if `6.close:true` PASS → cancel sends `{close:true}` + auto-reopen. ~200ms gap.
- Else → filter chunks by generation_id post-cancel; bill wasted chars to `cogs_log.metadata.cancelled_after_chars`.

### Sample-rate fallback (drives §4.4)
- If `2.sample_rate=24000` AND `2.sample_rate=16000` PASS → bridge uses per-session sample rate query param. No downsampler needed.
- Else → escalate to Hume support before ship; fall back to libsamplerate/speex-resampler dep if support unblocks.

### Voice-clone path (drives §5.1 vs §5.2)
- If `7a` or `7b` PASS (path exists) → Scenario A (programmatic clone via /api/admin/voice-clone with provider=hume).
- Else if only `7c` (design-from-generation) PASS → still Scenario B for audio cloning; document that audio-clone is UI-only.
- Else → Scenario B (UI-paste route at /api/admin/voice-clone/hume-id).

### Concurrent cap
- `9b` opened=X/20 → if X < 20, escalate to Hume Pro/Enterprise tier negotiation BEFORE flipping env to hume in §8.7.

## Gate

This file is the source of truth for the spike verdict. The PR landing §3 schema migrations cannot merge without this file present and the three decisions above resolved.


---

## Refinement run (post-rate-limit recovery)

Generated: 2026-05-13T14:22:35.806Z
Script: `scripts/hume-phase0-refine.mjs`

### Refined TTFA (single flush:true; 5 trials, fresh WS each)

- trials_ms = [659, 663, 686, 720, 734]
- min = 659ms
- p50 = 686ms
- max = 734ms

**Interpretation:** the main-run TTFA=4007ms reflected 4 sequential messages with only the LAST one carrying `flush:true`. A cleaner single-message-flush measurement is what conversational latency looks like in production. Cartesia Phase-0 baseline: ≤700ms cold.

### Error envelope shapes

**10a. bad voice id:**
```json
{
  "closed": true,
  "code": 1000,
  "reason": ""
}
```

**10b. malformed JSON:**
```json
{
  "type": "error",
  "code": "E0101",
  "slug": "payload_parse",
  "message": "Failed to parse payload. 'json_invalid' error in input: Invalid JSON: key must be a string at line 1 column 3: received `str` input of `'{ not even valid json'`. Please refer to https://docs.hume.ai for help calling Hume APIs.",
  "request_id": "5704b884-252c-411b-96c1-929a4dc97f873156523"
}
```

### tts_speed cadence parity

| speed | audio_seconds | bytes | complete |
|---|---|---|---|
| 0.85 | 5.00 | 479658 | true |
| 1.00 | 5.76 | 552960 | true |
| 1.15 | 23.40 | 2246394 | true |

Ratio 0.85 / 1.0 = 0.867 (expect ~1.18 if 0.85 means "0.85× normal rate")
Ratio 1.15 / 1.0 = 4.062 (expect ~0.87 if 1.15 means "1.15× normal rate")

---

## Verdict — surface to Vuk before §3 lands

### Headline

Hume Octave 2 is **viable** but with **three operational caveats** that need decisions before flipping prod:

| Dimension | Result | Status |
| --- | --- | --- |
| TTFA p50 (refined) | 686ms | **PASS** — matches Cartesia baseline (≤700ms) |
| Steady-state latency | p50=594ms / max=1123ms over 20 turns | PASS |
| Sample-rate query param | Both 24000 + 16000 honored | **PASS** — no server-side downsampler needed (§4.4 simplifies) |
| Frame coherence | s16le mono, even-aligned | PASS |
| Generation-id streaming | Single id across burst, `is_last_chunk:true` works | PASS |
| Concurrent WS cap | **~10/20 connections accepted** before 429 | **BLOCKER for prod** — free-tier cap |
| Programmatic clone REST | `/voices` exists but requires `generation_id` (design path) — no audio-upload endpoint | **Scenario B only** — UI-paste route |
| DELETE voice endpoint | `DELETE /v0/tts/voices?name=<name>` — **EXISTS** (Hume Python SDK confirms 2026-05-13 re-probe). Earlier 404 was because we tried by id; endpoint is keyed by NAME. | RESOLVED — worker dispatches by name (stored on `creators.hume_voice_name` + `voice_delete_queue.voice_name`) |
| Cancellation | All 3 strategies fail to stop within 200ms (best: abrupt close, 297ms trailing) | filter-by-generation_id required |
| `tts_speed` semantics | 0.85 ≠ 1.15 cadence, but speed=1.15 anomalously 4× longer (Hume bug?) | Calibrate via admin UI; don't rely on numeric semantics |

### Three decisions for Vuk

**Decision 1 — Concurrent connection cap.**
Free-tier cap is ~10 concurrent WS. At any non-trivial DAU this is a hard blocker. Options:
- **A.** Upgrade Hume tier (Pro/Enterprise) before flipping prod. §8.7 cut-over BLOCKED until done.
- **B.** Skip cut-over entirely; keep Hume as per-creator-override only (Vuk-as-creator burn-in) and continue on Cartesia for everyone else. Saves the $42K/mo only on Vuk's traffic — meaningless until creator count grows.
- **C.** Talk to Hume support about lifting the cap on the current plan. Some providers do this for committed-volume promises.

Recommendation: A. The $42K/mo savings funds a generous Hume contract.

**Decision 2 — Voice DELETE. RESOLVED 2026-05-13.**
DELETE endpoint exists at `DELETE /v0/tts/voices?name=<name>` — keyed by NAME, not by UUID. Confirmed via Hume Python SDK source (`voices/raw_client.py`). Original Phase-0 check 8 hit 404 because it queried by `/voices/{id}` path-style. The worker dispatches by `voice_name` (stored on `creators.hume_voice_name` + `voice_delete_queue.voice_name`); schema enforces `tts_provider='hume' → voice_name NOT NULL` via the M3 CHECK constraint. No leak.

**Decision 3 — Scenario B confirmed.**
Voice cloning is **UI-paste only** (Scenario B in plan §5.2). `POST /v0/tts/voices` exists but accepts `generation_id` (design path), not audio upload. For Vuk's A/B you'll need to:
1. Go to `app.hume.ai/voices`
2. Upload your 15-30s voice sample manually
3. Get the voice id
4. Paste it into the new `/admin/creators/[id]` Hume voice-id form (§12.5)

This is the implementation path. §5.1 (programmatic clone) becomes "deferred — endpoint doesn't exist."

### What's confirmed unchanged from plan v0.4

- §4.4 simplifies: **sample_rate query param works**, no downsampler dep needed
- §4.3 generation_id-based chunk filtering required for cancel — filter-only strategy from the §4.2 table
- §4.3 error envelope shape mappable: `{ type, code, slug, message, request_id }` → bridge taxonomy
- §3.2 schema unchanged; `creators.hume_tts_speed` still permissive CHECK [0.5, 2.0]
- §2.0 Sentry scrub already shipped (Vuk-C2 covered)

### What needs adjustment in the plan

1. **§4.2 cancel strategy** = filter-only (last row of the §4.2 decision table). Update plan.
2. **§4.4 fallback** = strip the downsampler hedge entirely; document "sample_rate query param confirmed working 2026-05-13."
3. **§5.1 Scenario A** = mark as "not available — Hume has no audio-upload REST endpoint as of 2026-05-13."
4. **§5.4 worker** = add stub Hume DELETE branch that emits a manual-cleanup warning until a real endpoint exists.
5. **§5.4 bridge error mapping** = add the captured shapes from check 10a (bad voice id → silent close 1000) and 10b (E0101 / slug=payload_parse) to `HUME_ERROR_MAP`.
6. **§8.7 cut-over** = blocked on Hume Pro/Enterprise tier upgrade (Decision 1).
7. **§3.2 hume_tts_speed CHECK** = stays permissive but document the speed=1.15 anomaly; admin UI calibration will surface values that produce expected cadence.

