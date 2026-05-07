# #3 — `use-session-pipe.ts` Rewire (Cartesia α' Cutover Cleanup)

**Status:** v3 — round-1 (4C/7M/6S) + round-2 (3C/7M/7S) findings applied. Stop point per `feedback_audit_loop` (no auto-3rd round).
**Owner:** Vuk
**Branch (planned):** `feat/session-pipe-cleanup`
**Predecessor:** `feat/simli-wireup-face-upload` (Cartesia α' wire-up shipped behind `NEXT_PUBLIC_VOICE_PROXY_PATH=1`)

---

## 1. Goal in one line

Delete the legacy direct-Gemini path in [`src/app/s/[id]/use-session-pipe.ts`](../../src/app/s/[id]/use-session-pipe.ts) so that the proxy/Cartesia α' path is the only path, retiring the `NEXT_PUBLIC_VOICE_PROXY_PATH` cutover flag.

---

## 2. Why now

1. **"Cloned voice everywhere" is a hard rule** ([CLAUDE.md](../../CLAUDE.md), `feedback_cloned_voice_everywhere`). While the legacy branch lives, a misconfigured deploy where `NEXT_PUBLIC_VOICE_PROXY_PATH` is unset/`0` silently ships **Gemini stock voice** at the wrong sample rate (R1-C2) — Sev-0. We are one config flip from disaster.
2. **Doubled bug + reasoning surface** in the hook (the reducer is already path-agnostic — see §4.6).
3. **Single-path code is faster to debug** when `/s/[id]` regresses.

---

## 3. Pre-#3 gates (NOT optional — verified at PR-merge moment, not just earlier)

- [ ] Simli queue #0 enqueued for the lipsync-test face_id.
- [ ] **`NEXT_PUBLIC_VOICE_PROXY_PATH=1` AND `NEXT_PUBLIC_VOICE_PROXY_URL` set in Vercel `Production` AND `Preview` AND `Development` envs.** Verified via the Vercel CLI (`vercel env ls`) — paste the trimmed output into the PR description (S4 — there is no manual screenshot mechanism). **Re-verify immediately before merging step 6.4 (the server-route hardening PR)** — that step makes a missing `NEXT_PUBLIC_VOICE_PROXY_URL` fatal at session-open. Per audit C4: §3 gate stale-by-the-time-PR-lands is the bad window.
- [ ] `VOICE_CARTESIA_ENABLED=1` + `CARTESIA_USD_PER_CHAR` + `CARTESIA_QUOTED_AT` Fly secrets present (per CLAUDE.md voice section's fail-closed).
- [ ] **End-to-end /s/[id] lipsync test on preview URL** passes on **desktop Chrome + iOS Safari (PWA install) + Android Chrome**. Capture PostHog `simli_lipsync_latency_ms` p50/p95 + `user_perceived_response_ms`.
- [ ] **iOS 4002 reconnect-race repro (M3)** — on iOS Safari with an active turn in progress, kill Wi-Fi for ≥3s then restore. Verify (a) proxy WS closes with `4002`, (b) reducer reaches `reconnecting`, (c) the *next* `/api/sessions/open` from the same tab does **not** fail with `session_already_active` from a not-yet-reaped row (memory `project_ios_4002_reconnect`).
- [ ] **24h soak** on the proxy path with real (not synthetic) sessions before merge.

If you start #3 before these are green, you are deleting the rollback path while the forward path is unverified.

---

## 4. Scope (what changes, file by file)

### 4.1 [`src/app/s/[id]/use-session-pipe.ts`](../../src/app/s/[id]/use-session-pipe.ts) — primary surgery

**Delete:**

- L28-33 — `USE_PROXY_PATH` const + comment block.
- L21 — `import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai'`.
- L77-88 — `bytesToBase64`. Verify `base64ToBytes` has no surviving consumer (proxy delivers binary directly); if not, drop too.
- L144 — `geminiRef` ref + every `geminiRef.current?.close()` / assignment site (L405, 583-585, 692-735, 828-829, 878).
- **L165 — `ephemeralTokenRef` (S2)**, dead after envelope `gemini.token` removal (4.2).
- L344-410 — `openGemini()` function entirely.
- L489-493 — `if (USE_PROXY_PATH) { void openProxy(); } else { void openGemini(); }` → just `void openProxy();`.
- L582-585 — legacy rollover-close branch.
- L668-690 — `if (USE_PROXY_PATH)` wrapper around `proxyRef.current.swapTo`. Inline the body.
- L691-735 — legacy Gemini reopen-after-rollover block.
- L744-750, L777-790, L810-812 — `USE_PROXY_PATH` conditionals in `startMic`, worklet message handler, `stopMic`. Inline the proxy-side bodies.
- L828-829, L878 — `geminiRef.current?.close()` in `endSession` and unmount cleanup.

**Modify:**

- L368 — PostHog `session_ready` event currently emits `surface: 'gemini'` from the proxy `onReady` callback (L428 path) AND from the legacy callback. Rename to `surface: 'voice'` for clean dashboards (S6).

**Keep:** Simli bridge wiring, recording-controller surface, video-stats / drift accumulators, heartbeat, visibility, rollover timer, retry-after-gesture.

**Resulting size estimate:** ~939 → ~620 LOC.

### 4.2 `OpenEnvelope` shape — hoist to shared module (round-1 C1; refined round-2 C3 + M6)

**Audit C1 root-cause fix:** the envelope is constructed in **THREE** places, each with its own inline `gemini: {token, model}` type literal:
- [`src/app/(feed)/hook-panel.tsx:646`](../../src/app/(feed)/hook-panel.tsx) (writer — Ask click on hook clip)
- [`src/app/v/[id]/long-form-player.tsx:337`](../../src/app/v/[id]/long-form-player.tsx) (writer — Ask click on long-form player)
- [`src/app/s/[id]/use-session-pipe.ts:42`](../../src/app/s/[id]/use-session-pipe.ts) (reader)

**Action:**
1. Create `src/app/s/[id]/session-envelope.ts` exporting the canonical `OpenEnvelope` type + `envelopeStorageKey` + `isValidEnvelope`. The new module is a pure type + helper module (no React, no `'use client'` directive needed; it's importable from any client file).
2. **Update all three writer/reader import paths (round-2 M6):**
   - [`hook-panel.tsx:8`](../../src/app/(feed)/hook-panel.tsx) — change `import { envelopeStorageKey } from '@/app/s/[id]/session-client'` → `from '@/app/s/[id]/session-envelope'`.
   - [`long-form-player.tsx:10`](../../src/app/v/[id]/long-form-player.tsx) — same edit.
   - [`session-client.tsx:13` and 37-39](../../src/app/s/[id]/session-client.tsx) — re-export the symbol from the shared module if any external module still imports it from here, OR migrate all consumers (preferred — there are only the two above).
3. Delete the inline `gemini: { token: string; model: string }` type literals in both writers. The cast becomes `JSON.parse(text) as OpenEnvelope` against the canonical type.
4. **Round-2 C3 — required-vs-nullable rollout safety.** v2's "PR-1 ships type as no-op while server still returns nullable" is broken: writers cast against the new type, typecheck fails on parsed-server-response shape, OR they cast loosely and we lose the type safety entirely. **Fix:** ship 4.2 (envelope hoist + shape) and 4.3/4.4 (server hardening + required fields) atomically in **one PR**. Step 6 ordering revised.
5. Apply the shape change in the shared module:

```ts
// after #3
export type OpenEnvelope = {
  session_id: string;
  tier: 'free' | 'premium' | 'boardroom';
  avatar: { session_token: string; expires_at: string; face_id: string } | null;
  avatar_status: 'pending' | 'minted' | 'skipped_tier' | 'failed_mint' | 'failed_connect' | 'not_applicable';
  voice: { model: string };                              // renamed from `gemini`
  voice_ticket: { ticket: string; expiresAt: string };   // required (was nullable)
  proxy_url: string;                                     // required (was nullable)
  max_duration_s: number;
  max_session_s: number;
  is_takeover?: boolean;
};
```

### 4.2.1 Stale-envelope shape guard (round-1 C2; refined round-2 M2 — wire-it-into-readEnvelope)

`session-client.tsx` reads from `sessionStorage` with a blind cast. Add a runtime guard that catches **two** stale shapes:

- (a) **Pre-deploy tab wrote old shape, post-deploy reader.** Old shape lacks `voice_ticket` / `proxy_url`.
- (b) **C2 case — pre-deploy writer (still-running JS) wrote old shape, brand-new reader on the new build.** Old shape has `gemini.token` but no `voice.model`. The plan's earlier guard missed this.

Single guard checks all three required new-shape keys in one pass:

```ts
function isValidEnvelope(env: unknown): env is OpenEnvelope {
  if (!env || typeof env !== 'object') return false;
  const e = env as Record<string, unknown>;
  if (typeof (e.voice as { model?: unknown })?.model !== 'string') return false;
  if (typeof (e.voice_ticket as { ticket?: unknown })?.ticket !== 'string') return false;
  if (typeof e.proxy_url !== 'string') return false;
  return true;
}
```

On guard failure → existing "Session expired" screen + emit a PostHog `envelope_shape_mismatch` event.

**Wiring (round-2 M2):** in [`session-client.tsx:45`](../../src/app/s/[id]/session-client.tsx) replace the blind `JSON.parse(raw) as OpenEnvelope` cast with `const parsed = JSON.parse(raw); if (!isValidEnvelope(parsed)) return null;` — the guard is dead code if not wired into `readEnvelope()`.

**Telemetry registry (round-2 S7):** add `envelope_shape_mismatch` to the PostHog events registry / dashboard owned by `posthog-safe-capture.ts` at the same time, otherwise AC #9 ("<0.1%") is unmeasurable.

### 4.3 [`src/app/api/sessions/open/route.ts`](../../src/app/api/sessions/open/route.ts)

- L289-314 — voice-ticket mint failure becomes **fatal**: call `session_close` with `p_end_reason: 'voice_ticket_mint_failed'`, return 502.

#### 4.3a — Daily-cap check (audit R2-C1: today not wired at HTTP layer)

**Verified gap:** [`src/lib/voice/mint-voice-ticket.ts`](../../src/lib/voice/mint-voice-ticket.ts) L54-107 only checks the 5-live-tickets rate limit. Daily-cap enforcement today runs at **proxy WS open** (close code `4006`). The plan's 429 `daily_cap_hit` UX therefore requires net-new code, not "verify it's already wired":

1. **Add an explicit pre-mint cap RPC call** in `/api/sessions/open` (between `session_open` RPC at ~L298 and `mintVoiceTicket` at L298+): `await sb.rpc('voice_usage_ticket_check', { p_user_id: callerUserId })`.
2. On RPC rejection (cap hit): call `session_close({ p_end_reason: 'daily_cap_hit' })` to avoid orphaning the just-opened session row, then return `429 { error: 'daily_cap_hit', resetAtMs }`.
3. Client maps 429 to the existing "You've hit today's limit" screen (already used for the proxy 4006 path post-mint).
4. Same insertion in [`/api/sessions/rollover/route.ts`](../../src/app/api/sessions/rollover/route.ts) — cap hit during rollover is fatal-end-session (no retry).
- L342-350 — drop `gemini.token`, rename `gemini` → `voice`. Drop the L342-344 cleanup comment.
- Refuse to open a session if `NEXT_PUBLIC_VOICE_PROXY_URL` is unset → return 503 `proxy_url_unconfigured`. **C4 deploy ordering:** §3 env-confirmation gate must be re-checked at PR merge moment, not just at #3 kickoff.

### 4.4 [`src/app/api/sessions/rollover/route.ts`](../../src/app/api/sessions/rollover/route.ts)

- L144-160 — voice-ticket mint failure redesigned (round-1 C3, refined by round-2 C2):
  - On rollover ticket-mint failure, return `503 { retry: true, error: 'voice_ticket_mint_failed', session_id: newSessionId }`. **The `session_id` MUST be in the body even on retry** — without it the client cannot close the orphaned new row on second-failure, and the next `/api/sessions/open` collides with `session_already_active` (the iOS 4002 race pattern).
  - Client behaviour in `use-session-pipe.ts` rollover handler:
    - On first 503 `{retry:true}`, **persist `body.session_id` to a `pendingRolloverSessionIdRef`** before scheduling a 2s retry.
    - On second-failure: dispatch `fatal_error`, then POST `/api/sessions/close` with `pendingRolloverSessionIdRef` (the new id), then `closed_ack`.
    - On retry success: clear `pendingRolloverSessionIdRef`; the new session id becomes `sessionIdRef.current` per existing rollover-complete path.
  - Document the `session_id`-in-503 contract in the route comment.
- L162-172 — drop the entire `gemini` object key (audit S5 — not just `.token`); add `voice: { model }`. Require `proxy_url`.

### 4.5 [`src/lib/voice/proxy-client.ts`](../../src/lib/voice/proxy-client.ts)

- L4 — strip the `"when NEXT_PUBLIC_VOICE_PROXY_PATH=1"` doc comment (M1 / S5).
- No code changes — public surface is path-agnostic.

### 4.6 [`src/app/s/[id]/session-reducer.ts`](../../src/app/s/[id]/session-reducer.ts) and `.test.ts`

Reducer is path-agnostic — proxy `onReady` dispatches `gemini_setup_complete`, proxy `onAudioOut` dispatches `gemini_audio_chunk`. **Zero reducer test deletions required.**

**Bundle the action-kind rename into #3 (round-1 M2):**
- `gemini_setup_complete` → `brain_ready`
- `gemini_audio_chunk` → `tts_audio_chunk`
- `gemini_turn_complete` → `turn_complete`
- `gemini_interrupted` → `barge_in`
- State field `geminiReady` → `brainReady`

**Full callsite list to update in the same commit (round-2 M1 — was under-enumerated):**
- [`session-reducer.ts`](../../src/app/s/[id]/session-reducer.ts) — owner: lines 33, 64, 99, 110, 169-180, 229.
- [`session-reducer.test.ts`](../../src/app/s/[id]/session-reducer.test.ts) — line 173 (`geminiReady`) + 14 references to the four `gemini_*` action kinds.
- [`barge-in.test.ts`](../../src/app/s/[id]/barge-in.test.ts) — lines 11, 20, 23, 30.
- [`session-client.tsx`](../../src/app/s/[id]/session-client.tsx) — line 174 (`geminiReady` reader).
- [`use-session-pipe.ts`](../../src/app/s/[id]/use-session-pipe.ts) — every dispatch site (4.1 already touches all four action kinds).

### 4.7 [`src/lib/avatar/simli-bridge.ts`](../../src/lib/avatar/simli-bridge.ts) and [`tavus-bridge.ts`](../../src/lib/avatar/tavus-bridge.ts)

No proxy-vs-legacy assumptions. **No change.** Tavus cleanup is a separate ticket per `project_tavus_scrapped`.

### 4.8 [`docs/RUNBOOKS/voice-proxy-rollback.md`](../../docs/RUNBOOKS/voice-proxy-rollback.md) — surgical rewrite (audit M6)

- **§1 "When to execute"** — rewrite. Remove flag-flip references. Replace with: "rollback = `git revert PR #N` + redeploy."
- **§2 "Execution sequence"** — rewrite. Drop the Vercel env-flip step; add the revert-and-redeploy sequence + Fly-proxy don't-redeploy rule (still load-bearing, kept verbatim).
- **§3 "What rollback does NOT undo"** — **keep verbatim** (schema migrations, attach-not-insert, bridge chunker — all still operationally relevant).
- **§4 "When to roll FORWARD instead"** — **keep verbatim** (cookie/ticket-layer debugging, clock-skew, `voice_tickets` table inspection).
- **§5 "After-action"** — minor edit: drop the "stock-voice violation" paragraph (no longer applicable).

### 4.9 [`CLAUDE.md`](../../CLAUDE.md), [`docs/_planning/SIMLI_WIREUP_PLAN.md`](./SIMLI_WIREUP_PLAN.md), `.env.example`

- **`.env.example` — verified (S1):** no `NEXT_PUBLIC_VOICE_PROXY_PATH` entry today. ✅
- **CLAUDE.md** — no direct mention; no edit needed.
- **`SIMLI_WIREUP_PLAN.md`** — historical record; leave as-is.

### 4.10 Vercel env cleanup — order changed for safety (round-1 M7; refined round-2 M3 + M5)

1. **Before #3 merge:** post a notice asking owners of all open PRs that predate #3 to rebase or close. **48h SLA (round-2 M5)** — after that, owner-of-#3 force-closes stragglers and pings owners to reopen post-rebase. Avoids indefinite stall if a contributor is on PTO.
2. **Post #3 merge + 24h green:** delete `NEXT_PUBLIC_VOICE_PROXY_PATH` from `Preview` first. Wait 30min. Watch Sentry for any preview-traffic anomaly.
3. **Then delete from `Production` — gated on AC #5 (round-2 M3).** Owner: #3 PR author. Threshold-breach action: file revert PR; do **not** delete prod env. Concretely: run PostHog query for `session_close` event count, 24h pre-deploy vs 24h post-deploy. If outside ±10%, halt 4.10 step 3, file `revert: #3` PR. Document the exact PostHog query URL in the PR description.
4. **Delete from `Development`** last.

### 4.11 Sentry / PostHog dashboard verification

- `sentry/alerts/lipsync.json` — verify no flag-conditional logic. Path-agnostic monitor; no change expected.
- PostHog dashboards — `proxy_warning`, `cartesia_reconnecting`, `simli_video_stats`, `simli_clock_drift_ms`, `user_perceived_response_ms` are unconditional after #3. Filter cleanup (if any) is a separate ticket.

---

## 5. Out of scope (explicit non-goals)

- Removing `tavus-bridge.ts` (separate ticket).
- Removing `@google/genai` from `package.json` (still consumed by `src/app/admin/spike-a/spike-client.tsx`).
- Touching `src/lib/voice/audio-bridge.ts` unless `use-session-pipe`'s legacy path was its sole consumer (verify during 4.1).

---

## 6. Order of operations (TDD) — revised per round-2 C3 (atomic shape+server PR)

1. Branch from latest main: `git checkout -b feat/session-pipe-cleanup`.
2. **Test first:** vitest case in `session-reducer.test.ts` asserting proxy `onReady` dispatch path drives `phase: 'opening' → 'ready'`.
3. **Test first:** integration test for `/api/sessions/open` returning 502 on voice-ticket mint failure AND 429 `daily_cap_hit` on cap RPC rejection. Both fail today.
4. **Re-verify Vercel envs** at this moment (round-1 C4) — `vercel env ls` paste in PR description.
5. **Atomic PR-1: Land 4.2 (envelope hoist + new required-shape) + 4.3 + 4.3a + 4.4 (server hardening + cap-RPC pre-mint + rollover-retry contract).** These ship together so the writer typecheck against the new required-shape sees the new server response in the same deploy. Round-2 C3 — the v2 "no-op superset" framing was broken.
6. **Atomic PR-2: Land 4.1 (delete legacy path) + 4.6 (action-kind rename) + 4.2.1 wiring.** Pre-#3 lipsync gate (§3) must already be green at this moment.
7. **Doc PR: 4.5 + 4.8.**
8. Auditor subagent on full diff per PR (per `feedback_audit_before_push`).
9. Apply revisions. Max 2 audit rounds per `feedback_audit_loop`.
10. Push to main → **30min monitor + production iOS 4002 repro retest** (round-2 M4 — preview-URL repro is not equivalent to production).
11. **Wait 24h-green** → execute 4.10 sequence.

---

## 7. Risk register (revised)

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | Stale `sessionStorage` envelope from a tab opened just before deploy lacks new-shape keys | Medium | 4.2.1 shape guard checks `voice.model` + `voice_ticket` + `proxy_url`. Telemetry via `envelope_shape_mismatch`. |
| R2 | Vercel `Preview` env has `NEXT_PUBLIC_VOICE_PROXY_PATH=0` (default for unset) — preview lipsync test passes today by accident | Critical | §3 gate requires `vercel env ls` paste in PR description, re-verified at merge moment of step 6.6 (audit C4) |
| R3 | Cartesia outage during #3 deploy — no flag rollback | Medium | `VOICE_CARTESIA_ENABLED` Fly-side flag stays intact (separate kill-switch). Documented as the operational lever in 4.8 §4 |
| R4 | Daily/weekly cap rejection produces unstructured 502, not clean UX | Medium | 4.3 returns structured 429 `daily_cap_hit` upstream of ticket mint (audit M4) |
| R5 | Reporter's "~50% reducer tests are legacy" claim was wrong but might mask other gaps | Low | Audit step 6.7. If a transport-coupled assertion exists (none found in v2 read), replace |
| R6 | `@google/genai` SDK still referenced from `spike-a/spike-client.tsx` | Low | Out of scope; flag in changelog |
| R7 | iOS Safari WS-close-then-reconnect race (`project_ios_4002_reconnect`) — not covered by automated tests | High | §3 gate adds explicit manual repro: kill Wi-Fi ≥3s during turn, restore, verify next `/api/sessions/open` doesn't 4001/`session_already_active` |
| R8 | Drop of `gemini` envelope key breaks a writer/reader | Critical | 4.2 hoist consolidates all 3 sites (writers + reader) into one shared type — type system catches any miss. Round-2 S4 — risk text now matches §4.4 which drops the entire `gemini` parent key, not just `.token`. |
| R9 | Sentry alert `lipsync.json` references stale event names | Low | Verify at step 6.8 |
| R10 | Rollover ticket-mint fatality causes client-side `rollingOverRef` deadlock | Critical | 4.4 `{retry:true}` + bounded retry + clean fatal_error path (audit C3) |
| R11 | Vercel env deletion silently routes a stale preview branch to legacy path | High | 4.10 staged sequence — `Preview` first with monitoring window; block #3 merge until all pre-#3 PRs rebased/closed (audit M7) |
| R12 | Acceptance criterion #5 ("session_close ±10%") not falsifiable in PR window | Medium | 8.5 reframed as a *post-merge gate* — `Production` env deletion held back until metric holds (audit M5) |

---

## 8. Acceptance criteria (must hold at merge unless flagged post-merge)

1. `grep -rn "USE_PROXY_PATH\|NEXT_PUBLIC_VOICE_PROXY_PATH\|legacy direct-Gemini" src/` returns **zero matches**. Separate check (round-2 M7): `grep -rn "@google/genai" src/` returns **at most 1 file** (`src/app/admin/spike-a/spike-client.tsx`).
2. `npm run typecheck` clean — type system catches any straggler `envelope.gemini` reader/writer (depends on 4.2 hoist).
3. `npm run test -- session-reducer barge-in` clean. (Round-2 S1: dropped `session-envelope` from test selector — no test file with that name is in scope; the shape guard is exercised by `session-client` integration if added.)
4. `/s/[id]` lipsync test on preview URL passes on Chrome + iOS Safari + Android Chrome.
5. **(Post-merge gate, not PR gate)** PostHog `session_close` count over 24h post-deploy stays within ±10% of pre-deploy baseline. **Production env-var deletion (4.10 step 3) is gated on this metric.**
6. Zero new `proxy_*` Sentry events at >5% rate within 30min post-deploy.
7. Auditor subagent on full diff returns ≤1 Critical, ≤3 Medium remaining.
8. PR description contains `vercel env ls` output proving `NEXT_PUBLIC_VOICE_PROXY_PATH=1` and `NEXT_PUBLIC_VOICE_PROXY_URL` set in all three Vercel scopes (audit S4).
9. PostHog `envelope_shape_mismatch` 24h post-deploy is <0.1% of session-open attempts (rollout-window stale-tab measure).

---

## 8.5 Whole-build audit follow-ups (filed as separate tickets — NOT blocking PR-3)

The pre-merge whole-build audit surfaced three items that pre-date the
use-session-pipe rewire (the rewire amplifies but does not introduce
them). They are tracked here so they don't slip:

1. **HeyGen rollover orphans server-side sessions every 15 minutes.**
   `reopenAfterRollover` keeps the existing avatar bridge alive
   (pipe-warm) on rollover. For HeyGen that means the freshly-minted
   HeyGen session — created by the rollover route's
   `mintHeygenSessionToken` call — is never joined, never heartbeated,
   and times out at 120s burning credits with zero playback. Pre-rewire
   tech debt; the rewire didn't change rollover semantics. Fix path:
   either skip HeyGen mint when `bridgeRef.current` is alive, or tear
   down + rebuild HeyGen on rollover and accept the avatar gap.
2. **`isValidEnvelope` does not deep-validate `avatar` discriminated
   union.** A pre-HeyGen-deploy stale envelope sails through the guard
   and crashes `heygen-bridge.ts` with `requires opts.heygenSessionBoot`.
   Add per-provider field-shape checks to the guard.
3. **Rollover route does not re-run the `voice_usage_ticket_check` cap
   gate.** A user 14:30 into a 15-min session whose accrual just pushed
   them past the daily cap will roll over, get a fresh ticket, and the
   proxy WS will then 4006-close the new session within seconds —
   re-spending Simli/HeyGen mint cost on a session that can't be used.
   Add the same pre-mint cap check to `/api/sessions/rollover`.

## 9. Open questions (resolve before implementation)

1. **(Resolved by round-2 audit C1.)** `voice_usage_ticket_check` RPC is **not** called by `mintVoiceTicket` today. §4.3a now adds the explicit pre-mint RPC call.
2. **Q:** Should #3 also retire `src/app/admin/spike-a/`? Out of scope today, but if yes the `@google/genai` dep can be removed in the same PR. **Decision:** defer.
3. **Q:** Sentry breadcrumb on `proxy.open` / `proxy.swapTo`? **Decision:** out of scope; track separately.

---

## 10. References

- [`src/app/s/[id]/use-session-pipe.ts`](../../src/app/s/[id]/use-session-pipe.ts) — target file.
- [`src/lib/voice/proxy-client.ts`](../../src/lib/voice/proxy-client.ts) — proxy WS client (header comment touch-up only).
- [`src/app/(feed)/hook-panel.tsx`](../../src/app/(feed)/hook-panel.tsx) — envelope writer #1 (audit C1).
- [`src/app/v/[id]/long-form-player.tsx`](../../src/app/v/[id]/long-form-player.tsx) — envelope writer #2 (audit C1).
- [`docs/_planning/SIMLI_WIREUP_PLAN.md`](./SIMLI_WIREUP_PLAN.md) — original cutover plan; §7 documents the flag.
- [`docs/RUNBOOKS/voice-proxy-rollback.md`](../RUNBOOKS/voice-proxy-rollback.md) — to be surgically rewritten in 4.8.
- [`CLAUDE.md`](../../CLAUDE.md) — "cloned voice everywhere" rule, voice section.
- Memory: `feedback_cloned_voice_everywhere`, `project_voice_model`, `project_ios_4002_reconnect`, `feedback_audit_before_push`, `feedback_audit_loop`.
