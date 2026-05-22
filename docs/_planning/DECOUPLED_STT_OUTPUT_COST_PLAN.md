# DECOUPLED STT — kill the discarded-output double-pay

Status: **DRAFT — awaiting auditor pass + Vuk approval. No code yet.**
Branch base: `b9f537b` (RAG-SOTA work committed; the dead-end systemInstruction
"neuter" is recorded in memory as DO-NOT-RETRY).
Author context: 2026-05-21. Supersedes nothing; complements
`DECOUPLED_BRAIN_PLAN.md`.

---

## 1. Problem (code-proven, not plan-claimed)

In **decoupled mode** the Gemini Live session (`gemini-3.1-flash-live-preview`)
is used ONLY as a streaming **STT + VAD + barge-in** engine. The real answer is
generated OFF the Live session by `brain-bridge.js` (`generateContent` + RAG).
The ONLY thing consumed from Gemini Live is `serverContent.inputTranscription.text`.

But the Live session is hardcoded `responseModalities: [Modality.AUDIO]`
(`gemini-bridge.js:332`). So **every turn Gemini generates a full audio answer
that is discarded** (`discardAudioOut`, `gemini-bridge.js:636-648`) **but billed.**

We pay twice: (1) the discarded Gemini audio answer, (2) the real deep answer
from the creator's brain.

### Real cost (measured against prod `cogs_log`, session ac506a3c)
| Leg | Cost/session | Note |
|---|---|---|
| `gemini_audio_out` (**discarded garbage**) | **$0.01572** | ~14% of session COGS |
| `gemini_audio_in` (the STT we actually use) | $0.00180 | — |

**~8.7× more for the answer we throw away than for the transcription we keep.**
(n=1 session; before sign-off, re-confirm the median across ≥10 sessions — R2-Small.)

### Web-verified pricing (ai.google.dev/gemini-api/docs/pricing, 2026-05-21)
`gemini-3.1-flash-live-preview`: output **audio $12.00/M** vs output **text $4.50/M**
(2.67× cheaper/token — and a text generation is far fewer tokens and ~1s vs 7–21s).

---

## 2. Root cause of the failed "OK" attempt (from session b853bee3 + code)

A prior attempt set the Live `systemInstruction` to a one-token relay ("reply with
exactly one word: ok") to shrink the discarded generation, paired with a playout
gate. It **killed the session**: `turn_complete_timeout` (`gemini-bridge.js:932`),
avatar never spoke on turn 2.

**Why (definitive):** `bridge.turnEnd()` (`gemini-bridge.js:927-944`) sends
`activityEnd` then **hard-blocks on Gemini's `turn_complete`** (or rejects with
`turn_complete_timeout` after 30s / `ws_closed_mid_turn`). The proxy `turn_end`
handler `await`s that at `index.js:2251` **before** the playout gate
(`awaitTurnSpoken`, `index.js:2266`). The "neuter" made `turn_complete` go
slow-then-absent → the upstream `await` ate the 30s timeout → session died before
the playout gate could fire.

Two decisive facts from that session:
- **"We are currently relying on Gemini being slow."** The early-trigger latency
  fix (deep answer starts at `input_transcription`, ~+200ms) accidentally depends
  on Gemini's slow garbage-gen to delay `continue:false` until after audio plays.
  Remove the slowness without a real playout gate and the mid-word cut returns.
- The deep answer itself was **fine** in the failed run (`grounded=y`,
  `deep_first 877/557ms`, transcripts 29/141 chars complete). The failure was the
  **turn lifecycle**, not transcript truncation.

**Conclusion: in decoupled mode the `turn_complete` dependency is VESTIGIAL.** The
answer doesn't come from Gemini; nothing real needs its `turn_complete`. The proxy
waits on it only to (a) send `activityEnd` and (b) harvest approximate per-turn
COGS metrics. That dependency is what makes shrinking the discarded generation
dangerous.

**DEAD END — do not retry:** shrinking generation via Live `systemInstruction`
("reply ok") while `bridge.turnEnd()` still blocks on `turn_complete`. Recorded in
memory.

---

## 3. Plan — two layers, ordered

### Layer 1 (enabler): stop BLOCKING on `turn_complete` — but keep it as a live event
**R2 reframe (C1/C2/M2):** `turn_complete` is NOT purely vestigial. It is still the
trigger for three live mechanisms, so we do not "remove" it — we stop *blocking the
user-facing turn finalization* on it, while keeping it as a fire-and-forget event:
1. **D-GoAway proactive reopen** (`gemini-bridge.js:783-785`) — fires inside the
   `turnComplete` branch; this is what keeps the session alive past the ~15-min cap.
   Severing the await must NOT stop `turn_complete` from arriving and driving this.
2. **js-genai#707 synthesized completion** (`_onSessionClose`, `:613`) gated on
   `_currentTurnReceivedContent`.
3. **Authoritative COGS harvest** — final `usageMetadata` + total `outputBytes`
   arrive *with/after* `turn_complete`.

Design:
- Decoupled mode finalizes the **user-facing** turn off signals we own end-to-end:
  `input_transcription` (+~200ms) + deep-answer stream completion + **playout**
  (`awaitTurnSpoken`). `awaitTurnSpoken` becomes the **sole user-facing
  finalization gate**.
- `bridge.turnEnd()` (decoupled) resolves on a **short bounded race**, gated
  *inside* `turnEnd()` on `this._decoupled` (NOT a caller arg legacy could trip —
  R2-Small): `turn_complete` seen, OR `_pendingInputTranscriptionThisTurn` already
  set (`:668` — the observable flag, NOT a new promise listener; M1), OR a named
  constant `DECOUPLED_TURN_END_RACE_MS` (~1.5s, boot-validated — R2-Small). It
  still sends `activityEnd` first.
- **Async metrics harvest (C2/M3 — the part that makes this NOT a COGS
  regression):** a `turn_complete`-deferred, non-blocking listener captures the
  FINAL `usageMetadata` + total output bytes when `turn_complete` eventually
  arrives, and writes the Gemini COGS leg THEN — after the user-facing turn already
  finalized. Without this, an early resolve snapshots a *partial* `outputBytes`
  (`turnStart` resets it to 0 on the next turn, `:900`) and the rest of the billed
  audio/text is **never harvested** → kill-switch under-counts while Google bills
  full. Input-audio seconds (`_currentTurnInputBytes`) is exact at `activityEnd`.
- **Supersede invariant (C3):** today's long block makes the
  `turnNumber !== endingTurn` supersede guard (`index.js:2250-2252`) reliable. With
  a ~1.5s resolve the race window shifts. `awaitTurnSpoken` reads the *global*
  `turn` (`orchestrator:521`), not `endingTurn` — re-derive and prove the supersede
  guard still prevents `ttsBridge.turnEnd()` flushing a NEWER turn's Cartesia
  context on a fast follow-up. Document `awaitTurnSpoken` as intentionally
  always-latest.
- **Legacy / non-decoupled path byte-identical** (gated on the once-bound
  `decoupled` const, per `DECOUPLED_BRAIN_PLAN.md` §13 lineage; legacy passes full
  `timeoutMs`, skips the race entirely).

**Independent value:** kills the `turn_complete_timeout` session-death class and
ends the "relying on Gemini being slow" luck.
**R2 hard constraint (C2):** Layer 1 must NOT ship to prod standalone — without the
async harvest it is a COGS-accuracy regression (Gemini bills the full discarded
generation regardless of whether we wait). Ship Layer 1 coupled to the async
harvest, and to Layer 2 for the actual saving.

### Layer 2 (cost win, only safe after Layer 1): minimize the discarded generation
- **Recommended: TEXT output mode.** Open the decoupled Live session with
  `responseModalities: [Modality.TEXT]`, `enableInputTranscription: true`,
  `enableOutputTranscription: false`. Discard the text output (never to TTS).
  - Re-test the month-old Phase 0 negative ([TEXT] rejected 2026-04-22). The
    model page now lists outputs as "Text and audio" (half-cascade, not
    native-audio — the capabilities-guide "AUDIO-only" rule is for native-audio
    models only).
- **Fallback (properly re-tested, not written off): neuter-to-"ok" in AUDIO.** The
  prior failure was the BLOCKING `turn_complete` await (now removed by Layer 1), not
  the answer — the deep answer was correct (`grounded=y`) in the failed run; the
  SESSION died. Levers are orthogonal: modality (AUDIO $12/M vs TEXT $4.50/M) ×
  length (full vs minimal "ok"). "ok" is the BIGGER cut (near-zero output tokens).
  Under Layer 1, an "ok" turn finalizes on the playout gate regardless of
  `turn_complete`. **Open risk to disprove in the spike (Path B):** the agent's
  hypothesis that "starving generation destabilizes the Live socket / makes
  `turn_complete` unreliable" — possibly confounded by the `source_type` bug in that
  session. If `turn_complete` becomes unreliable under the neuter it does NOT kill
  the user-facing turn (Layer 1), but orphans (a) D-GoAway reopen — matters only for
  >15-min sessions (paid tiers; free is 5-min capped), and (b) the async COGS harvest
  — needs a fallback harvest on next `turnStart`/on-close. Spike Path B (S10) decides.
- **NOT a fallback:** `maxOutputTokens` cap on AUDIO mode without a
  "transcript-received-before-turn-end" guard — risks the same truncation
  mechanism; net-new bridge code, deferred.

**R2 bridge changes TEXT mode requires (not just config validation):**
- **M7 — drop `outputAudioTranscription` in `open()` when modality is TEXT.** It is
  set at `gemini-bridge.js:343-349` whenever `_enableOutputTranscription` (=`useTts`,
  often true for Cartesia creators) regardless of modality. `[TEXT] +
  outputAudioTranscription:{}` is a contradiction Gemini may reject at open (2.5-native
  +Cartesia 4010 class). The skip must live in `open()`, keyed off resolved modality.
- **M2 — set `_currentTurnReceivedContent` on TEXT `modelTurn.parts[].text`.** Today
  it is set only on `audio/pcm` (`:631`) and `outputTranscription` (`:682`) — never on
  TEXT parts. The #707 synthesized-`turn_complete`-on-1000-close (`:613`) is gated on
  it, so in TEXT mode a 1000-close mid-turn would NOT synthesize completion → session
  death. Patch `_onMessage` to mark received-content on TEXT parts.
- **M5 cost caveat:** `bridge.cancel()` is a no-op (`:964`) — barge-in does NOT stop
  Gemini's in-flight discarded generation; it bills in full per barge. The TEXT-mode
  saving scales with the clean-turn ratio; barge-heavy demo sessions realize less.

### Layer 2 — COGS (product code, not a "confirm")
Today the only output rate is `GEMINI_OUTPUT_USD_PER_TOKEN = 0.000012` (the $12/M
**audio** rate, `proxy-handlers.js:23`); the seconds-fallback uses `outputSeconds`
which is computed from `audio/pcm` parts and **collapses to 0 in TEXT mode**.
Before Layer 2 ships:
- Add `GEMINI_OUTPUT_TEXT_USD_PER_TOKEN` boot-validated pricing var.
- Modality-aware branch in `logTurnCogs` (`proxy-handlers.js:227`) + distinct
  operation enum value (so the dashboard doesn't mislabel TEXT as audio).
- Update `cogs-rpc.test.js` counterpart (currently asserts
  `p_gemini_audio_out_tokens`, `cogs-rpc.test.js:80`).
- **Fail-closed flag guard (R2-M6 reframe):** key the guard off the *actual resolved*
  `enableInputTranscription` value passed to the bridge AND assert `decoupled === true`
  when `DECOUPLED_STT_TEXT_OUTPUT=1`. The original phrasing checked a phantom flag —
  `enableInputTranscription` is *derived* (`vector || decoupled || env`,
  `index.js:1208-1216`), so it is always true in the decoupled path it meant to
  protect. The real danger it must catch is TEXT-output in a NON-decoupled / legacy-α'
  context (Gemini emits text we never read AND no audio for Cartesia = total silence).
  Hard close `4010 model_not_compatible`-class on any TEXT-output state that isn't
  `decoupled === true && enableInputTranscription === true`.

---

## 4. Spike (real-API, gated `.mjs` like `scripts/brain-spike-narrow.mjs`)

Pin the model from `VOICE_MODEL`/`modelWire`, NOT a literal. Log to a throwaway
file — **never `cogs_log`**. The spike must be a **real multi-turn proxy run**
(single-shot won't surface socket instability — the failed session only died on
turn 2).

**R2-M4 precondition (confound control):** run the spike against `HEAD` of the
RAG-SOTA branch with the `source_type` retrieval bug FIXED (or in drawer/non-vector
mode where retrieval doesn't fire), NOT against `b9f537b`. The session that died on
turn 2 had BOTH the neuter AND the double-retrieval bug firing — the spike must
isolate lifecycle stability from the retrieval stall, or "proves stable" against a
confounded baseline.

Resolve:
- **S1** Does `gemini-3.1-flash-live-preview` accept `responseModalities:[TEXT]`
  TODAY? (re-test Phase 0 negative)
- **S2** With TEXT output, does `inputAudioTranscription:{}` deliver the user's
  STT **full and untruncated on a >15s utterance**? (forum 107385 truncation may
  be modality-coupled; decoupled path has NO `truncationSuspected` guard today —
  `index.js` early-returns before it)
- **S3** TEXT + manual VAD (`activityStart`/`activityEnd`) legal at connect? Does
  `turn_complete` fire? Does `interrupted` (barge-in) fire, at what rate?
- **S4 (socket stability — THE reframed #1 criterion)** Across a real multi-turn
  TEXT-mode session, does the Live socket stay healthy (no premature `code=1000`
  death, or only the known js-genai#707 handled close), and does
  `input_transcription` keep flowing every turn?
- **S5** Capture `usageMetadata.responseTokenCount` in TEXT mode (does the field
  populate? — drives the COGS leg). Measure discarded-gen token cost AUDIO vs TEXT,
  and **time-to-`input_transcription`** AUDIO vs TEXT (the real critical-path
  number, not just time-to-turn_complete).
- **S6** Ordering: capture the inter-arrival of `input_transcription` vs
  `turn_complete` (and `usageMetadata`, R2-Small) in TEXT mode — the orchestrator's
  two `onTurnComplete` callers (`index.js` early-trigger + turn_complete fallback)
  assume transcript strictly precedes turn_complete; prove it.
- **S7 (R2-C1)** Does `turn_complete` STILL fire per-turn in TEXT mode and still
  drive `_proactiveReopen` (D-GoAway)? Independent of whether `turnEnd()` waits for
  it. If TEXT mode suppresses/delays `turn_complete`, the proactive reopen stops
  arming and the session dies at the ~15-min cap with a server ABORT.
- **S8 (R2-C4)** Barged-incomplete-turn protocol legality: drive
  `activityStart → audio → activityEnd → [no turn_complete] → activityStart` (user
  barges their own utterance before completion) and confirm Gemini does NOT close
  with 1007/1011. Tests next-activity-after-incomplete-turn, which S3 (detection
  only) does not cover.
- **S9 (R2-C3)** Fast follow-up: turn N → barge → turn N+1 within
  `DECOUPLED_TURN_END_RACE_MS`, and confirm the supersede guard still prevents
  `ttsBridge.turnEnd()` flushing turn N+1's live Cartesia context (no mid-word cut).
- **S10 (Path B — AUDIO "ok" fallback)** With AUDIO mode + a minimal-output
  systemInstruction (the "ok" neuter), across a real multi-turn run: does
  `turn_complete` stay reliable per-turn (disprove/confirm the "starving destabilizes
  the socket" hypothesis), and does discarded output drop toward zero? Run ONLY after
  Layer 1 (non-blocking turn_end) is in the harness, else it just re-reproduces the
  known death. Path A (TEXT) preferred; Path B is the win if A is rejected.

If S1 fails (TEXT still rejected) → Layer 1 still ships (independent value);
Layer 2 falls back to the AUDIO neuter ONLY if S3/S4 prove it stable under
Layer 1, else cost win is deferred and current AUDIO+discard remains.

---

## 5. Code anchors (verified 2026-05-21)
- `gemini-bridge.js:29` `DEFAULT_SYSTEM`; `:332` `responseModalities:[AUDIO]`;
  `:333` systemInstruction; `:343-357` in/out transcription config;
  `:636-648` discardAudioOut byte accounting; `:650-675` inputTranscription
  (single chunk @ end-of-utterance, forum 136977; >15s truncation forum 107385);
  `:705-713` usageMetadata; `:893-910` turnStart/activityStart/_utteranceInFlight;
  `:927-962` turnEnd (sends activityEnd, blocks on turn_complete, returns metrics).
- `index.js:1196` `enableOutputTranscription: useTts`; `:1203-1212`
  `enableInputTranscription: vector || decoupled || env`; `:1218` `decoupled`;
  early-trigger of deep answer at `input_transcription` (decoupled branch,
  ~`:1786-1805`); `:2241-2280` turn_end handler (`bridge.turnEnd()` await `:2251`,
  superseded check, `awaitTurnSpoken` `:2266`, `ttsBridge.turnEnd` `:2279`).
- `decoupled-orchestrator.js` `onUserTranscript`/`onTurnComplete`/
  `awaitTurnSpoken`; `paraphraseEnabled=false` default.
- `proxy-handlers.js:23` `GEMINI_OUTPUT_USD_PER_TOKEN=0.000012`; `:208-333`
  `logTurnCogs` legs. `cogs-rpc.test.js:80` `p_gemini_audio_out_tokens`.

## 6. Constraints (CLAUDE.md)
VOICE_MODEL pinned, no `-latest`. Provider behind bridge. Every paid call writes
`cogs_log` (kill-switch at 150% of quota — minute caps are the kill, no dollar
kill). Gemini stock voice NEVER user-facing on any tier (discarded output must
never reach TTS — already gated `&& !decoupled`). Flag parse strict `=== '1'`,
boot-validated, fail-safe to legacy. North star = flawless USER UX (the
recognition moment); do not regress latency or transcript fidelity.

## 7. Out of scope (already in flight on the RAG-SOTA branch)
The `column sample_content_narrative_units.source_type does not exist`
cache-miss → double-retrieval (~2.4s ×2) and the rerank budget tightness are the
latency drivers, being handled in the narrative-chunk/splitter work. This plan
touches only the discarded-output COST.

## 8. Audit Round 1 (folded into §3–§4)
C1 modality-aware COGS leg. C2 turn_complete sourcing. C3 drop the "single word"
systemInstruction (§2 dead-end). C4 fail-closed flag guard. C5 maxOutputTokens-on-
AUDIO not a safe fallback. M1 >15s test in TEXT. M2 manual-VAD+TEXT legal. M3
outputSeconds zero in TEXT. M4 measure time-to-input_transcription. M5
responseTokenCount in TEXT. M6 barge-in suppression premise. M7 responseModalities
line shared with α'.

## 9. Audit Round 2 (folded above)
- **C1** D-GoAway reopen is gated on `turn_complete` (`:783-785`) — keep it firing +
  add S7. **C2** Layer 1 standalone is a COGS-accuracy regression → async harvest +
  "must not ship standalone" constraint (§3 Layer 1). **C3** bounded-race shrinks the
  supersede window → re-derive invariant + S9. **C4** barged-incomplete-turn protocol
  legality → S8.
- **M1** input_transcription not observable to `turnEnd()`'s promise → use the
  `_pendingInputTranscriptionThisTurn` flag (§3 Layer 1). **M2** `#707` synth gated on
  `_currentTurnReceivedContent`, never set on TEXT parts → bridge patch (§3 Layer 2).
  **M3** usageMetadata arrives after generation → async harvest (§3 Layer 1). **M4**
  spike confound → run on RAG-SOTA fix HEAD (§4). **M5** `cancel()` no-op → cost scales
  with clean-turn ratio (§3 Layer 2). **M6** fail-closed guard checked a phantom flag →
  reframed (§3 COGS). **M7** drop `outputAudioTranscription` in `open()` for TEXT —
  bridge change, not config validation (§3 Layer 2).
- **Smalls (folded):** n=1 cost cite caveat (§1); name+boot-validate
  `DECOUPLED_TURN_END_RACE_MS`; legacy `turnEnd()` race gated on `this._decoupled`;
  document `awaitTurnSpoken` as always-latest; usageMetadata inter-arrival in S6.
  **Open small:** date the "Text and audio" model-page modality claim inline (fetched
  2026-05-21, same as pricing).

## 9b. SPIKE RESULTS

- **S1 — RESOLVED RED 2026-05-21 (`scripts/decoupled-stt-text-mode-spike.mjs`).**
  `gemini-3.1-flash-live-preview` REJECTS `responseModalities:[TEXT]` at open with
  `1011 "Internal error encountered."` — control AUDIO config opened fine; all three
  TEXT variants (TEXT-only, TEXT+inputTranscription, TEXT+inputTranscription+manualVAD)
  closed 1011. Phase 0 (2026-04-22) holds; the model-page "Text and audio" output
  claim does NOT apply to the Live API on this preview. **Path A (TEXT output) is
  DEAD.** The cost win depends entirely on Path B (AUDIO "ok" under Layer 1) → S10 is
  now the make-or-break spike. (If a future preview string ships, re-run this spike.)

- **S10 — RESOLVED RED 2026-05-21 (`scripts/decoupled-stt-ok-neuter-spike.mjs`).**
  The AUDIO "ok" neuter BREAKS `turn_complete` on the Gemini side (independent of
  retrieval — the agent's hypothesis CONFIRMED, not confounded). A/B over 4 turns,
  real canned audio, manual VAD: BASELINE = 4/4 clean `turn_complete` at ~6.7s, ~5.6s
  / ~145-tok discarded output. NEUTER ("reply ok") = `turn_complete` never fires
  (25s timeout) or arrives one turn LATE (negative tc_ms). Degenerate minimization
  destabilizes the lifecycle. **Path B (instruction neuter) is DEAD** — Layer 1
  can't save it (unreliable turn_complete still orphans D-GoAway/COGS/barge-in).

- **S11 — RESOLVED GREEN 2026-05-21 (`scripts/decoupled-stt-maxtokens-spike.mjs`). THE FIX.**
  API-level `maxOutputTokens` cap (NOT an instruction) cuts output ~95% AND keeps
  `turn_complete` reliable + ~3-4× FASTER. Measured (3-4 turns each, transcript
  intact, socket healthy every run):
  | config | turn_complete | tc latency | discarded output |
  |---|---|---|---|
  | baseline (no cap) | reliable | ~6.7s | 5.6s / 145 tok |
  | top-level `maxOutputTokens=8` | **broken** | — | degenerate (too low) |
  | top-level `maxOutputTokens=16` | reliable 3/3 | ~1.8s | 0.44s / 12 tok |
  | top-level `maxOutputTokens=24` | reliable 3/3 | ~1.9s | ~0.69s / ~20 tok |
  | top-level `maxOutputTokens=32` | reliable 3/3 | ~2.0s | ~0.84s / ~26 tok |
  Top-level is the non-deprecated path and works at ≥16 (`generationConfig` also
  works at 8 but is SDK-deprecated). **Recommend top-level `maxOutputTokens=24`**
  (safe margin above the flaky-8 threshold; ~86% output cut; reliable + fast).
  Discarded output is GARBAGE in decoupled mode → truncating it is harmless; the
  INPUT transcript (what the brain reads) is intact at every cap value.

## 9c. REVISED APPROACH (post-spike) — the fix is one decoupled-gated config field
TEXT (S1) and the instruction-neuter (S10) are both dead. **S11 makes the whole
two-layer plan unnecessary:**
- **The fix:** add `maxOutputTokens` (top-level, ~24) to the Live `config` in
  `gemini-bridge.js open()`, **gated on `this._decoupled`** so it only caps the
  TRULY-discarded output. Legacy / α' (non-decoupled, where Gemini's output
  transcript IS piped to Cartesia) is byte-identical and uncapped — capping there
  would truncate the real answer.
- **Layer 1 (non-blocking turn_end) is NOT needed.** `turn_complete` stays reliable
  and fires ~3× faster (~1.9s vs ~6.7s), so the existing `bridge.turnEnd()` block
  just gets shorter — no rework, no async-harvest, no supersede re-derivation.
- **No COGS code change.** Still AUDIO output, just less of it; the existing
  `gemini_audio_out` leg (bytes/responseTokenCount) reports the lower number
  correctly. No new pricing var, no modality branch (those were TEXT-mode-only).
- **No new flag/migration strictly required** (it's a safe improvement on every
  decoupled turn) — though a kill-switch env (`DECOUPLED_MAX_OUTPUT_TOKENS`, default
  24, 0=off) is cheap insurance.
- **Residual confirms before ship:** (a) a >15s-utterance run to confirm the cap
  doesn't perturb input transcription (logically separate streams; low risk);
  (b) a barge-in turn under the cap; (c) verify the cogs_log number drops on a real
  session. These fold into the implementation TDD + one dogfood session.

## 9d. BUILD + AUDIT ROUND 3 (the shipped change)
Implemented in `gemini-bridge.js` only (+ tests): `parseDecoupledMaxOutputTokens`,
constructor opt `decoupledMaxOutputTokens` (env default), pure
`_decoupledOutputCapConfig()` (gated `_decoupled && N>0`), spread into `open()`
config. No `index.js`/migration/COGS change → legacy byte-identical.

Auditor Round 3 (on the actual code): **NO CRITICALS.** Verified against the real
SDK (`@google/genai@1.50.1`: `maxOutputTokens` is a real `LiveConnectConfig` field)
+ both reopen paths (cap survives via fresh `open()` rebuild; `_lastOpenArgs` carries
no config) + COGS leg (prices smaller output via `responseTokenCount`, kill-switch
not blinded) + #707 synth path (`_currentTurnReceivedContent` still set via
outputTranscription chunk in decoupled). Mediums/Smalls APPLIED:
- **M2** floor: small positives (1..15) clamp up to 16 (`<16` destabilized
  turn_complete in S11) + console.warn. Tested.
- **M1** CLOSED: spike re-run with ~18s utterance + cap on → input transcript intact
  (len 69→139), turn_complete reliable (~3s), output capped (~0.54s/~19tok), socket
  healthy 3/3. Cap is orthogonal to the input-transcription stream.
- **M3** stale parallel-audio-window comment in `index.js` updated. **M4** documented
  why no new pricing var. **M5** confirmed `responseTokenCount` reports the CAPPED
  count (4/12/~20/~26 for caps 8/16/24/32) → COGS truth-path correct.
- **Smalls**: S-number→filename map in the bridge comment; reopen-persistence test.
- Bridge tests 37/37; full proxy suite 357/357 (the transient "fail 6" was
  pre-existing order-dependent `brain-bridge.failover`/cogs pollution, not this change).
- **PRE-EXISTING (out of scope, flag):** the decoupled early-trigger
  (`index.js` ~1806-1822) returns BEFORE `truncationSuspected` (~1834), so a >15s
  question is answered from a possibly-truncated transcript with no operator signal.
  Not caused by the cap; tracked separately.
- **Localhost caveat:** set `DECOUPLED_MAX_OUTPUT_TOKENS=24` explicitly locally to
  exercise the env path prod uses; a ~3-4s demo question won't surface the (separate)
  >15s truncation gap.

## 10. Net verdict after Round 2
Thesis holds (stop blocking on `turn_complete`; TEXT output for the saving), but the
shape changed: `turn_complete` is kept as a live event (D-GoAway + #707 + async COGS),
only the *blocking finalization* moves to the playout gate. **Layer 1 ships coupled
to the async harvest and to Layer 2 — never standalone.** Spike grew S7–S9 (D-GoAway
survival, barged-incomplete protocol, fast-follow supersede) and a confound-control
precondition. No further auto-audit — Vuk decides whether Round 3 is warranted.
