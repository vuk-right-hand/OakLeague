# Creator Voice Speed — implementation plan

**Revision:** R2 (2026-05-11, post second auditor pass — bedrock Cartesia API correction + count-based daily cap)

## R2 corrections summary (authoritative — supersedes R1 details below where they conflict)

R1 was built on the wrong Cartesia API surface. R2 corrects:

| Surface | R1 (wrong) | R2 (correct) |
|---|---|---|
| Cartesia field path | `voice.__experimental_controls.speed` | `generation_config.speed` |
| Value range | `[-1, 1]`, default `0.0` | `[0.6, 1.5]`, default `1.0` |
| "No-op" value | `0.0` | `1.0` |
| Slider range (UI) | `-0.5 to +0.5` | `0.6 to 1.5` (display as symmetric "Slower ← → Faster" with the multiplier shown small) |
| Presets | `-0.2 / 0 / +0.2` | `0.85 (-15%) / 1.0 (default) / 1.15 (+15%)` |
| Helper threshold | `Math.abs(v) > 0` | `v !== 1.0` |
| Migration DEFAULT | `0.0` | `1.0` |
| Migration CHECK | `>= -1 AND <= 1` | `>= 0.6 AND <= 1.5` |

**Daily cap changed from $2 USD aggregate → 20-tap count cap (Vuk decision):**
- Burst: 5 taps/min/creator via `rate_limit_hit('voice_tts_preview_burst', creatorId, '1 minute', 5)`
- Daily: 20 taps/day/creator via `rate_limit_hit('voice_tts_preview_daily', creatorId, '1 day', 20)`
- No `cogs_log` SUM aggregate needed. Two `rate_limit_hit` calls cover both layers; either returning false → 429.
- Friendly UX copy near the Check Speech button:
  > *Each Check Speech generates ~7s of fresh audio in your voice. Soft cap: 5/minute, 20/day. Resets midnight. (Your slider value is saved — preview is for tuning, not the actual conversation.)*

**Other R2 fixes (non-numeric, propagated to relevant sections below):**
- C2: bridge call sites are `sendText()` + `turnEnd()` — there is NO separate "initial open" voice payload.
- C3: drop `::float8` cast — not valid in supabase-js `.select()`. Use `Number(raw)` with `Number.isFinite` guard at the boundary.
- C4: `cogs_log` INSERT must include `units` (transcript.length) + `unit_label='characters'` + correct `service='cartesia'` / `operation='voice_tts_preview_characters'` / `environment='production'` / `metadata.kind='voice_speed_preview'` (renamed from 'preview' to avoid VERCEL_ENV collision).
- C5: `rate_limit_hit` signature: `(p_scope text, p_key text, p_window interval, p_limit int)` returns boolean. Key by `creatorId`, not `userId`.
- M1: `getCreatorForCaller()` doesn't return `voice_id`/`tts_speed` — use a separate targeted SELECT in preview API + server action.
- M5: `shouldSendSpeed()` helper inline-duplicated in bridge AND preview API with `// keep in sync` comment (cross-package import not feasible).
- M6: 200 + 0-byte Cartesia response → return JSON 502 `cartesia_empty_body`.
- M7: confirm brain-recompile trigger does NOT fire on `tts_speed` UPDATE (otherwise every slider save burns a Gemini compile).

---



## Goal
One knob: creators can slow down or speed up how their cloned voice plays.
They must **hear** the change before saving, not guess at a slider value.

## Non-goals (explicitly)
- Pitch / emotion / language / Cartesia experimental controls beyond speed
- Admin-side override
- Per-user speed (user-side preference)
- A/B testing infrastructure for speed values
- Voice clone retrain UI (separate v1.2 item)

## Scope statement
Single column on `creators`, ride-along through `voice_tickets` and into the
Cartesia bridge. New creator-side page with a slider, three preset chips,
and a "Play preview" button that calls Cartesia REST to synthesize a canned
sentence at the current slider value and plays it inline.

---

## Schema

### Migration `20260511000006_creators_tts_speed.sql`
```sql
ALTER TABLE public.creators
  ADD COLUMN tts_speed numeric NOT NULL DEFAULT 0.0
  CHECK (tts_speed >= -1.0 AND tts_speed <= 1.0);

-- R1-C5 disposition: tts_speed will be publicly readable via the existing
-- "creators public read when published" policy (20260420000011_creators.sql).
-- Postgres has no column-level RLS. Decision: ACCEPT. The value is a UX
-- preference, not sensitive. Same posture as creators.system_prompt
-- (added 20260511000001), which is far more sensitive and ships with the
-- same public-read accident. If we ever split sensitive columns into
-- creators_private, tts_speed comes along with system_prompt at that time.
COMMENT ON COLUMN public.creators.tts_speed IS
  'Cartesia Sonic 3 __experimental_controls.speed value. Range [-1, 1]; 0 = Cartesia default, negative = slower, positive = faster. Per-creator playback tuning; rides voice_tickets → proxy → cartesia-bridge. NOTE: publicly readable via creators "published" RLS (Postgres has no column-level RLS); acceptable as a UX preference. R1 audit C5 disposition.';

ALTER TABLE public.voice_tickets
  ADD COLUMN tts_speed numeric NULL
  CHECK (tts_speed IS NULL OR (tts_speed >= -1.0 AND tts_speed <= 1.0));

COMMENT ON COLUMN public.voice_tickets.tts_speed IS
  'Mirrors creators.tts_speed at session-open. NULL means "use Cartesia default" (legacy ticket OR creator not yet on speed-knob schema). Proxy passes to CartesiaTTSBridge via __experimental_controls.speed when non-null AND non-zero (R1 audit M6); omits the field entirely when NULL or 0.0 — explicit 0 is a no-op to Cartesia but sending the wrapper changes request shape unnecessarily.';
```

**Backfill**: existing rows default to `0.0` (Cartesia native, no behavior change). Vucko + any future creators can dial via the UI. **No silent global slowdown.**

**Why NOT NULL on creators**: every creator has *a* speed preference; defaulting to 0.0 (= Cartesia native) means "no opinion expressed = no playback adjustment", which is the safe baseline.

**Why NULL allowed on voice_tickets**: tickets minted before this migration applied carry NULL; the bridge treats NULL as "skip the experimental_controls block" — backward compatible.

**R1 audit M7 — Postgres numeric → JS string coercion.** supabase-js leaves `numeric` as a string in JS. The proxy `SELECT` and the preview-API creator-read MUST cast: prefer `SELECT tts_speed::float8 AS tts_speed` in both `voice_tickets` consume (`server/voice-proxy/index.js`) and the creator preview lookup. Belt-and-suspenders: `Number(ticket.tts_speed)` with `Number.isFinite` guard at the boundary, fall back to omit-the-knob on coercion failure.

---

## File-by-file changes

### Backend plumbing
1. **`src/lib/voice/mint-voice-ticket.ts`** — accept optional `ttsSpeed: number | null`, INSERT into ticket row.
2. **`src/app/api/sessions/open/route.ts`** — extend `creators` SELECT to include `tts_speed`; pass to `mintVoiceTicket`.
3. **`src/app/api/sessions/rollover/route.ts`** — same.
4. **`server/voice-proxy/index.js`** — extend ticket SELECT to include `tts_speed`; pass to `new CartesiaTTSBridge({ ..., ttsSpeed })`.
5. **`server/voice-proxy/cartesia-bridge.js`** — accept `ttsSpeed` constructor opt (number or null). Add a tiny helper `shouldSendSpeed(v): boolean` returning `typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > 0` (R1 audit M6 — omit on null OR explicit 0, so two paths can't drift). When the helper returns true, add to BOTH the initial-context send (line ~187) AND per-turn send (line ~250):
   ```js
   voice: {
     mode: 'id',
     id: this._voiceId,
     __experimental_controls: { speed: this._ttsSpeed },
   }
   ```
   Share `shouldSendSpeed()` between the bridge and the preview API route so both paths apply the identical omit-rule (don't duplicate the threshold logic in two places).

### Creator dashboard
6. **`src/app/creator/voice/page.tsx`** (NEW) — server component, reads creator row, renders `<VoiceUI />`.
7. **`src/app/creator/voice/voice-ui.tsx`** (NEW) — client component:
   - Slider `<input type="range" min="-0.5" max="0.5" step="0.05">` (constrained to a sane subset of the full [-1, 1] range; ±0.5 covers all human-acceptable cadences without making the avatar sound broken).
   - Three preset chips: "Slower (-0.2)" / "Default (0.0)" / "Faster (+0.2)" (Vuk R1 decision — tightened anchors, less risk of sounding broken).
   - "Play preview" button — POSTs to `/api/creator/voice-preview` with the current slider value, plays returned audio inline.
   - "Save" button — calls server action `updateTtsSpeed(value)`. Beneath the slider, render the copy: **"Changes apply to your next conversation. Active sessions keep their current speed."** (R1 audit clarification — concurrency state surface).
   - Voice state UI (R1 audit M8 — three states, not two):
     - `voice_id present` → preview enabled, normal UI.
     - `voice_id NULL but creator row exists` → preview disabled, copy: "Train your cloned voice first to enable preview." Save still works.
     - `voice clone retraining in flight` → no current column flags this; covered by "voice_id NULL" fallback. v1.2 may add explicit retraining-state copy.
   - Loading + error states for preview (timeout 8s); 4xx responses parsed as JSON (R1 audit M5), not as audio. Error mapped to user-readable toast (e.g. `voice_not_trained → "Train your voice first"`, `daily_budget_exceeded → "Too many previews today, try tomorrow"`).
   - **R1 audit S5 — audio cleanup pattern**:
     - On preview tap, create `URL.createObjectURL(blob)`.
     - Track in a ref so we can `URL.revokeObjectURL(prev)` before assigning a new one.
     - On unmount: `audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(currentObjectUrl);`
     - AbortController on the fetch; abort on unmount or rapid re-tap.
     - Client-side 500ms debounce on the Play button to avoid hammering Cartesia.
8. **`src/app/creator/voice/actions.ts`** (NEW) — `updateTtsSpeed(speed: number)`:
   - `getCallerUserId()` gate.
   - **R1 audit M3** — reuse the existing `getCreatorForCaller()` helper at `src/lib/creator/get-creator.ts` (same pattern as `/creator/brain/actions.ts`); do NOT hand-roll a `creators.select().eq('user_id', userId)` here.
   - Server-side range check (-1.0..1.0) — explicit; mirror the DB CHECK to fail fast before the round-trip.
   - **R1 audit M3 — defense-in-depth WHERE clause**: UPDATE must include `WHERE id = $creatorId AND user_id = $callerUserId`. The ownership check from `getCreatorForCaller` is not enough on its own — a race between the SELECT and the UPDATE could land on a foreign row if a creator row's `user_id` was reassigned (extremely unlikely but cheap to guard).
   - **R1 audit M4 — revalidate ALL surfaces showing speed**: `revalidatePath('/creator/voice')` AND `revalidatePath('/creator')` (mirror the brain-actions pattern at `actions.ts:104-106`).
   - Returns `{ ok: true }` or mapped error.

### Voice preview API
9. **`src/app/api/creator/voice-preview/route.ts`** (NEW) — `POST`:
   - Auth: `getCallerUserId()` gate.
   - Creator binding (R1 audit M2 — distinguish "not a creator" from "no voice"):
     - Look up creator by `user_id = caller`.
     - **No creator row** → 403 `not_a_creator`.
     - **Creator row exists but `resolveVoiceId(row)` returns null** → 409 `voice_not_trained`. (R1 audit C4 fix: use `resolveVoiceId()` from `src/lib/voice/env-scoped-voice-id.ts` — single-column `voice_id` read breaks on preview deploys and localhost where `voice_id_preview`/`voice_id_dev` carry the value.)
     - **Creator row but ALL three voice_id columns are NULL** → also 409 `voice_not_trained`. UI shows "Train your cloned voice first."
     - **Future: voice retrain in-flight** (R1 audit M8): no current column flags this state; for now the NULL → 409 fallback covers admin force-retrain windows. Add a `voice_retraining_at` column in v1.2 if support requests come in.
   - Body validation: `{ speed: number }` in [-1, 1]; reject 400 otherwise. Server-side schema check belt-and-suspenders even though slider clamps to [-0.5, 0.5].
   - **Rate limit (R1 audit C3 fix)**: `rate_limit_hit` RPC only supports `interval '1 minute'`; use `5/minute/creator` with operation name `voice_tts_preview`. Caps single-creator peak burst at $0.0375/min ≈ $2.25/hr worst case.
   - **Aggregate budget cap (R1 audit M1)**: BEFORE calling Cartesia, sum `cogs_log.cost_usd` for `operation='voice_tts_preview_characters' AND user_id=$caller AND created_at > now() - interval '24 hours'`. If ≥ `$2.00/day/creator`, return 429 `daily_budget_exceeded`. This is the actual abuse defense; rate-limit only bounds peak rate, aggregate stops cumulative bleed.
   - Call Cartesia REST `POST /tts/bytes` with the canned sentence, the env-scoped voice_id, speed in `voice.__experimental_controls.speed` ONLY when `Math.abs(speed) > 0` (R1 audit M6 — omit the wrapper entirely on explicit 0).
   - **R1 audit M5 — response branching**: branch on `upstream.ok`:
     - `200 OK` from Cartesia → stream mp3 bytes with `Content-Type: audio/mpeg`.
     - `4xx/5xx` from Cartesia → return JSON `{ code: 'cartesia_<mapped>', upstream_status }` with appropriate status. The client must NEVER feed an error JSON body into the `<audio>` element; this prevents the silent-confused-UX failure mode.
   - **COGS logging (R1 audit C1 + C2 fix)**:
     - Service: `'cartesia'` (the existing enum value; `cartesia_tts` does NOT exist).
     - Operation: `'voice_tts_preview_characters'` (NEW operation string; no migration needed — `operation` is a freeform text field).
     - Environment: `'production'` (the only allowed value; preview is still production traffic). Tag the preview-vs-session distinction via `metadata.kind='preview'` jsonb — same pattern as `cogs_insert_turn_voice` legs.
     - Character count = transcript length × cartesia_per_char rate.
   - Timeout 8s for the Cartesia call; map to 504 with code `cartesia_timeout`.
10. **Canned preview sentence**: lives as a const in the route file. R1 audit S4 — straight ASCII apostrophes, no smart-quote autocorrect:
    ```
    "Hi, this is how I will sound when someone taps to ask me a question. If this feels too fast or too slow, drag the slider and play this again."
    ```
    (Rewrote `I'll → I will` to dodge curly-quote risk altogether.) Long enough to hear pacing (~7-8 seconds), short enough that 5 previews/minute × 60 min = $0.225/hr max even under burst.

### Tests

**pgTAP** (new):
- `supabase/tests/creators_tts_speed_check.test.sql` — INSERT with -1.5 fails 23514; INSERT with 0.5 succeeds; INSERT with NULL fails NOT NULL.
- `supabase/tests/voice_tickets_tts_speed_check.test.sql` — INSERT with NULL succeeds; INSERT with 0.5 succeeds; INSERT with 1.5 fails 23514.

**vitest** (new or modified):
- `mint-voice-ticket.test.ts` — assert ttsSpeed is included in insert payload when passed.
- `route.test.ts` (open) — assert `tts_speed` from creator row reaches `mockMintVoiceTicket` args.
- `route.test.ts` (rollover) — same.
- `cartesia-bridge.test.js` — bridge constructed with `ttsSpeed: 0.3` includes `__experimental_controls.speed=0.3` in the JSON sent on first context AND on per-turn; with `ttsSpeed: null` AND `ttsSpeed: 0.0` the field is omitted entirely (R1 audit M6 dual-coverage).
- `cartesia-bridge.test.js` — R1 audit S1: Cartesia responds with `{error_code:'unknown_param'}` (simulated unknown-field rejection) → bridge emits `code:'other'` non-fatal error.
- `voice-preview/route.test.ts` (NEW) — auth gate (403 `not_a_creator` vs 409 `voice_not_trained` separation per M2), range validation, no-voice 409, rate-limit hits 429, daily-budget exceeded 429, Cartesia 4xx returns JSON not mp3 (M5), success returns audio Content-Type. Verify env-scoped voice_id resolution via `resolveVoiceId()` is the lookup (M2/C4).
- `voice/actions.test.ts` (NEW — R1 audit S3 fix, do NOT skip) — server action range validation: `-1.1` rejected, `1.1` rejected, `0.3` accepted; ownership check: caller's creator-row gets updated, foreign-creator-row update attempt silently writes 0 rows; `getCallerUserId() === null` → returns `not_authenticated`.
- **`brain-prefix.integration.test.ts` companion or NEW `tts-speed.integration.test.ts`** (R1 audit S8) — single happy-path test exercising the full chain: stub Supabase to return `creators.tts_speed = 0.3` → `mintVoiceTicket` insert captured with 0.3 → simulated proxy SELECT returns 0.3 → `CartesiaTTSBridge` constructed and the outbound JSON payload contains `speed: 0.3` (NOT `"0.3"`). Catches the M7 numeric→string coercion if any boundary regresses.

### Vercel env vars to verify

- `CARTESIA_API_KEY` — currently a Fly secret on the proxy. Confirm it exists on Vercel; if not, copy over (Vuk has the value).

---

## Order of operations (build order)

**Branch**: R1 audit S6 fix — branch off `main` (just pushed brain wireup is already there), name `feat/creator-voice-speed`. Do NOT continue on `feat/brain-wireup` even though it's currently identical.

1. `git checkout -b feat/creator-voice-speed` off `main`.
2. Migration + pgTAP tests (apply to local-via-CLI, then prod after vitests are green).
3. `cartesia-bridge.js` + its test — bridge change is isolated, easy to verify first. Use the shared `shouldSendSpeed()` helper.
4. `mint-voice-ticket.ts` + route changes (open, rollover) + tests.
5. Proxy `index.js` SELECT (with `::float8` cast per M7) + pass-through.
6. Preview API route + tests (auth gate ladder per M2, env-scoped voice_id per C4, cogs logging shape per C1/C2, rate-limit per C3, budget cap per M1, error-response branching per M5).
7. Creator UI page + UI + server action.
8. Full vitest + tsc green.
9. **Auditor pass** (per memory rule before commit; this is the second audit if Vuk requests, or first audit on the code after this plan revision).
10. Apply migration to prod Supabase.
11. Commit + push to `feat/creator-voice-speed`, then fast-forward `main`.
12. Fly proxy redeploy (only because cartesia-bridge.js changed).
13. Manual smoke from localhost (now pointing at new prod everything): load `/creator/voice`, drag slider, preview plays, save persists, mic-tap new session reflects the speed.

**R1 audit S7 — audit-trail decision**: explicit `creators.updated_at` tick is sufficient for v1. No history table for `tts_speed` changes (low-frequency change, easy to inspect via `updated_at` if support needed). Document this in the migration comment.

---

## Edge cases / explicit decisions

- **Slider range visible to creator**: [-0.5, 0.5] (subset of DB [-1, 1]) — Cartesia values past ±0.5 sound broken on human voices. Server-side accepts the full range for forward compat.
- **What happens to active sessions on save**: nothing. Active session's ticket already carries the prior `tts_speed`. Next mic-tap mints a fresh ticket with the new value. **Documented in the UI**: "Changes apply to your next conversation."
- **Voice not trained yet**: Preview button disabled with copy. Save button still enabled (creator can pre-set their speed before training).
- **Concurrent preview taps**: client-side debounce 500ms + abort prior fetch on new tap. Server rate-limit catches the rest.
- **mp3 format**: works in all modern browsers without codec issues; Cartesia REST returns mp3 directly.
- **Mobile**: range input + `<audio>` element work natively; tap on Play preview satisfies autoplay-gesture requirement.
- **Cost**: ~150 chars × $0.00005/char = **$0.0075 per preview tap**. Rate limit (30/hr) caps at $0.225/hr/creator. Trivial.
- **Cogs logging**: every preview writes a `cogs_log` row with `environment='preview'`. Production sessions already do this for `cartesia_tts`; preview reuses the same service enum value, no new migration.
- **Persist across rollover**: rollover route also pulls fresh from creators row, so if a creator updates speed mid-session-string-of-rollovers, the next rollover picks it up. Same behavior as system_prompt and voice_id.

---

## Risks

- **Cartesia API contract drift**: `__experimental_controls.speed` is documented as experimental; could break in a Cartesia version bump. Mitigation: if Cartesia rejects the field, bridge logs an error but the session still synthesizes (Cartesia would just ignore the unknown field, or fail the open and we fall back). pgTAP tests don't catch this; relies on real-API smoke after deploy.
- **Slider UX with audio playback latency**: from tap to first audio playback, ~1-2 seconds (Cartesia synthesis + transfer). Spinner shown during; no surprise.
- **Speed value caching**: if a creator opens two browser tabs, modifies in one, the other tab shows stale value until refresh. Acceptable for v1.
- **Backfill: Vucko gets 0.0**: if you actually want -0.2 for him out of the gate (since "talks fast" was the trigger), separate manual SQL after migration:
  ```sql
  UPDATE creators SET tts_speed = -0.2 WHERE id = '74e897d8-6e91-4f00-98ab-190a66c92d9a';
  ```
  Or just let the UI ship and he can dial it.

---

## Time estimate (R1 revision — updated)

Honest wall-clock from this plan being approved:
- Migration + pgTAP (incl. ::float8 cast handling): 15 min
- Bridge + tests (incl. shouldSendSpeed helper + Cartesia-rejection test S1): 20 min
- Route + mint + route tests: 25 min
- Proxy `::float8` cast + pass-through: 10 min
- Preview API + tests (3-state auth ladder, env-scoped voice_id, budget cap, error branching, cogs shape): 45 min
- Creator UI page + actions (3-state voice render, audio cleanup, debounce): 40 min
- Integration test S8: 15 min
- Vitest + tsc green: 10 min
- Second auditor pass on code + revisions: 25 min
- Apply migration + push + fly deploy: 10 min
- Smoke test: 5 min
- **Total: ~3 hr 40 min**

R1 audit added ~40 min vs original estimate. Most of the added time is in the preview API (auth ladder + budget cap + error branching) and the integration test. Worth it: those are the bug paths most likely to surface in real-world creator use.

---

## Open questions — resolved by Vuk 2026-05-11

All four answered + structural C5 decision:

1. **Slider range**: UI `-0.5 to +0.5` (DB allows full `-1 to +1` for forward compat). ✅
2. **No backfill**: Vucko ships with `0.0` (Cartesia native) and dials via the UI as the first dogfood of the dashboard. ✅
3. **Rate limits**: 5/min/creator + $2.00/day aggregate cap. ✅
4. **Preset chips**: Slower `-0.2` / Default `0.0` / Faster `+0.2`. (Tightened from -0.3/+0.3 — less risk of sounding broken.) ✅
5. **C5 RLS disposition**: ACCEPT public-read with same posture as `system_prompt`. Documented in migration COMMENT. No `creators_private` table. ✅
