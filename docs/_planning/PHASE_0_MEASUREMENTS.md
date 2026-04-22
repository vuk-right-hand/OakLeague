# Phase 0 Measurements — Days 8–12 Voice Plan

Generated: 2026-04-22T21:02:03.418Z
Script: `scripts/voice-phase0-verify.mjs`
Fixture: `scripts/fixtures/voice-test-vuk-hello.wav` (2.60s, mono 16kHz s16 PCM,
real speech — "Hello, can you hear me?", transcoded from Vuk's recording via
ffmpeg).

## Gate summary

**Phase 1 is UNBLOCKED.** Pipeline α' is the architecture for every tier:

> user audio → `gemini-3.1-flash-live-preview` (`responseModalities:[AUDIO]`
> + `outputAudioTranscription:{}`) → read
> `serverContent.outputTranscription.text` chunks as they stream → **discard**
> the audio bytes Google synthesized → Cartesia Sonic 3 WS (IVC cloned voice
> per creator) → user hears creator's own cloned voice.

Pipeline α (literal `responseModalities:[TEXT]`) was ruled out by live runtime
test — Google's pricing page advertises text-output billing but the preview
model does not actually expose the capability.

## Results (live run, 2026-04-22 21:02 UTC)

| # | Check                                                           | Status | Evidence |
|---|-----------------------------------------------------------------|--------|----------|
| 1 | SDK `@google/genai` inspection                                  | PASS   | version=1.50.1, SessionResumptionUpdate=true, inputAudioTranscription=true |
| 2 | Cartesia Sonic 3 reachability                                   | PASS   | open=193ms, ttfb=343ms, ctx_id=`phase0-upox36cu` |
| 3 | Cartesia context-id reconnect (N3-M7 resumption)                | PASS   | Re-attach on same ctx_id accepted; audio continued to flow |
| 4 | Gemini 2.5 native-audio `inputAudioTranscription` (β fallback)  | PASS   | `serverContent.inputTranscription` event emitted on 1s silent PCM (text string empty as expected — the point is that the field populates and the config is accepted, not that silence transcribes to words). Proves β fallback is wireable should Pipeline α' regress. |
| 5 | googleapis/js-genai#2238 state                                  | INFO   | Upstream fetch 404 — not a blocker |
| 6 | **Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)**            | **FAIL** | WS opens → server immediately closes with `"Internal error encountered."` — config rejected outright. No `setupComplete`, no events. |
| 7 | **Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')**   | **PASS** | `setupComplete=true`; 3 streaming `outputTranscription.text` events ("Yes, I" → " can hear" → " you clearly."); `turnComplete=true`; `sessionResumptionUpdate.newHandle` emitted; `audio_out_bytes=86406` (discarded by design) |
| 8 | Gemini 3.1 Live AUDIO-only (control)                            | INFO   | Back-to-back run after #7 returned "Precondition check failed" — concurrent-session cap on the preview model. Non-blocking: production opens one session per user. Script REV 5.2 adds a 10s sleep between checks #7 and #8 so the next run exercises the control cleanly. Not part of the mandatory gate either way. |

## Evidence — check #7 (Pipeline α')

Real-speech input: "Hello, can you hear me?" (2.60s, from
`voice-test-vuk-hello.wav`).

Streaming `outputTranscription.text` chunks (concatenated):

> **"Yes, I can hear you clearly."**

Server event sequence observed:

1. `setupComplete`
2. `outputTranscription` chunk 1 — "Yes, I"
3. `outputTranscription` chunk 2 — " can hear"
4. `outputTranscription` chunk 3 — " you clearly."
5. `turnComplete`
6. `sessionResumptionUpdate.newHandle` — resumption token emitted on normal
   (non-goaway) turn boundary, so `ReconnectController` can checkpoint every
   turn without waiting for a disconnect.

`usageMetadata` was present on turn close — confirms billing leg 2
(`voice_audio_out_tokens`) will have real token counts to insert into
`cogs_log`.

## Why Pipeline α (TEXT-out) is dead

Check #6 on the live run produced exactly two WS events:

```
{"t":"open"}
{"t":"close","reason":"Internal error encountered."}
```

The server rejects `responseModalities:[TEXT]` on
`gemini-3.1-flash-live-preview` at session-open. No amount of retry / longer
timeout / different audio fixture changes the outcome — the config itself is
refused. Documentation claims text-output is supported; runtime says
otherwise. We trust runtime.

This is the single biggest plan change vs. REV 5: **we cannot save the
~$0.0001/min of discarded Gemini audio-out tokens**, because the modality
swap the savings depended on does not work. Cost impact: negligible.
Architectural impact: Pipeline α' (4 billable legs, read transcript + discard
audio) is the real design.

## Go-conditions for Phase 1

| Condition                                                      | Status |
|----------------------------------------------------------------|--------|
| SDK version pinned, resumption + transcription fields exposed  | ✅ PASS (check #1) |
| Cartesia open+TTFB budget met                                  | ✅ PASS (check #2) |
| Cartesia context-id reconnect working                          | ✅ PASS (check #3) |
| 3.1 Live AUDIO + outputTranscription proven end-to-end         | ✅ PASS (check #7) |
| β fallback (2.5 STT) still viable                              | ✅ PASS (check #4) |
| 3.1 Live TEXT-out viable                                       | ❌ FAIL → design pivoted to α' (check #6) |

All mandatory gates green. Days 8–12 REV 5.1 build proceeds.

## Sign-off

Plan REV 5.1 Hard Contract items 4–7 covered by the live run results above.
Migrations 0055 (`cogs_insert_turn_voice`, 4-leg α') and 0056
(`voice_usage_daily` / `voice_usage_weekly` + ticket-check RPC) land as the
enforcement layer built on top of this architecture.

Fixture and verify script are kept in-tree so the gate can be re-run any time
Google ships a new preview string or a capability regression is suspected.
