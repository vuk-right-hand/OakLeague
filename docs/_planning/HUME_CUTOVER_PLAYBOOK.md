# Hume Cut-Over Playbook — operator runbook

Companion to `HUME_TTS_PLAN.md §8`. This document is the **step-by-step ops checklist** for flipping production traffic from Cartesia to Hume. Each step has a rollback path. Do them in order, do not skip.

**Last reviewed:** 2026-05-13
**Owner:** Vuk

---

## Pre-flight (every step below assumes these are green)

- [ ] All §1–§7 work merged to `main` + deployed to production (Vercel + Fly).
- [ ] `VOICE_TTS_PROVIDER=cartesia` on Fly (env default; Hume code merged but inactive).
- [ ] HUME_API_KEY, HUME_USD_PER_CHAR=0.0000076, HUME_QUOTED_AT=2026-05-13 set on Fly.
- [ ] Vuk's Hume voice clone exists and `creators.hume_voice_id` is populated for Vuk via admin UI.
- [ ] §7 A/B harness has been run; verdict recorded in `docs/_planning/HUME_VS_CARTESIA_AB.md`.

If any of the four pre-flight items is missing, STOP. Don't proceed.

---

## Step 1 — Run §7 A/B harness and score

```bash
# Decision input (locked normalized text)
node scripts/hume-vs-cartesia-ab.mjs

# Informational (raw Unicode through both)
node scripts/hume-vs-cartesia-ab-raw.mjs

# Cancellation-waste check (Phase-0 risk 11.2)
node scripts/hume-vs-cartesia-ab-cancel.mjs
```

Then **listen blind** to `tmp/ab/q{NN}_A.wav` / `tmp/ab/q{NN}_B.wav` (mapping is at `tmp/ab/provider-mapping.json` — do NOT open that file until you've finished scoring every row) and fill out the scoring table in `docs/_planning/HUME_VS_CARTESIA_AB.md`. (Audio playback required — run this on a workstation with speakers/headphones, not a headless server.)

**Decision gate (HUME_TTS_PLAN §7):** Hume wins iff ALL FOUR:
- (a) sounds-like-Vuk avg ≥ Cartesia avg
- (b) emotional fit avg ≥ Cartesia avg
- (c) zero recurring artifacts in Hume's 20 turns
- (d) warm p50 TTFA ≤ 1.5× Cartesia

If Hume does not win all four → **STOP**. Stay on Cartesia. Re-evaluate when Hume ships Octave 3 or a model upgrade.

If the cancellation harness shows Hume's post-cancel cost waste >5% → **STOP**. Open a ticket with Hume to revisit cancel semantics. Don't proceed even if (a)-(d) pass.

---

## Step 2 — Set Vuk's creator override to Hume (single-creator burn-in)

**Only flip Vuk-as-creator-#1.** No other creator gets the override during burn-in.

**Use the admin UI ONLY** for this step: `/admin/creators/[vuk-id]` → "TTS Provider" panel → set dropdown to "hume" → Save. The admin UI calls `creator_set_tts_provider` (SECURITY DEFINER RPC) which row-locks the creator AND raises SQLSTATE 55006 (`creator_has_active_sessions`) if any session is in-flight. This is the only path that enforces the active-session guard.

> ⚠️ **Do NOT use a raw SQL UPDATE** to flip `creators.tts_provider`. A bare UPDATE skips the active-session guard and can split-brain a mid-session user (proxy bridge on the old provider per snapshot lock, but a subsequent admin re-read sees the new value, with no audit trail of the change time). The SQL path is for emergency-only use when the admin UI is completely broken — and even then, manually `SELECT count(*) FROM sessions WHERE creator_id='<id>' AND ended_at IS NULL` first.

**Pre-flight checks before flipping (verify via admin UI display or a `SELECT`):**
- [ ] `creators.hume_voice_id` is set (not null) for env=production.
- [ ] `creators.hume_voice_name` is set (not null).
- [ ] No active sessions for that creator — the admin RPC will raise SQLSTATE 55006 (`creator_has_active_sessions`) otherwise.
- [ ] `voice_delete_queue` is empty for this creator's old Hume voice (if any) — check via:
  ```sql
  SELECT * FROM public.voice_delete_queue WHERE tts_provider='hume';
  ```

**Rollback (any time during burn-in):** flip `tts_provider` back to NULL (= inherit env, which is still `cartesia`). Effective at next session-open. In-flight sessions finish on Hume (per snapshot lock). No data loss.

```sql
UPDATE public.creators SET tts_provider = NULL WHERE id = '<vuk-creator-id>';
```

---

## Step 3 — Burn-in: 48 hours of real sessions on Vuk-as-creator-#1

Start the burn-in monitor in a long-running terminal:

```bash
HUME_BURNIN_CREATOR_ID=<vuk-creator-id> node scripts/hume-burnin-monitor.mjs
```

The monitor polls every 60s. It exits non-zero if any of these red flags fire:
- Any session for this creator with `end_reason` in `('tts_failed', 'tts_open_failed', 'cartesia_no_voice', 'quota_state_inconsistent')`
- Any `cogs_log` row with `metadata.tts_cap_exceeded=true`
- Any cogs row with `service='hume'` AND `cost_usd=0` (pricing misconfig)
- Sentry events tagged `op:tts.error` with provider=hume and fatal=true

**Burn-in pass criteria (all must hold over the 48h window):**
- [ ] At least **two** sessions crossed the Gemini 3.1 15-min cap (rollover exercised under Hume — parity with Cartesia §8 step 6 spec). Pattern check via:
  ```sql
  SELECT count(*) FROM public.sessions
   WHERE creator_id = '<vuk-creator-id>'
     AND tts_provider_at_session = 'hume'
     AND metadata->>'rollover' = 'true';
  ```
- [ ] Zero `4006 quota_state_inconsistent` close codes.
- [ ] Zero `4014 tts_no_voice_hume` close codes (would mean voice column went NULL mid-session).
- [ ] `hume` cogs rows look right: chars > 0, cost_usd > 0, audio_seconds > 0 per turn.
- [ ] No recurring artifacts (clicks, glitches, mispronunciations) — listen back to at least 5 random session WAVs via Mux session-record playback or proxy log replay.

If any criterion fails → execute Step 2 rollback. Investigate. Don't proceed.

---

## Step 4 — Flip `VOICE_TTS_PROVIDER=hume` on Fly (production cut-over)

This step is the actual cut-over. Every creator with `tts_provider IS NULL` will now route through Hume on next session-open. Existing sessions finish on Cartesia (snapshot lock).

> ⚠️ **In-flight WS sessions get a hard reconnect at restart.** The proxy now ships a graceful WS drain (`shutdown()` in `server/voice-proxy/index.js` sends `code=1012 service_restart` + a `type:'shutdown'` notice to every live socket before exit, audit C3 fix). Clients SHOULD reconnect, but plan the env flip for the lowest-traffic window regardless. After the restart, spot-check `/admin/cogs` for sessions ended within ±60s of the restart with `end_reason IS NULL` — those are likely victims of the restart, and the client app should have re-opened a fresh session automatically.

```bash
# Production Fly app
fly secrets set VOICE_TTS_PROVIDER=hume -a oakleague-voice-proxy
# Confirm:
fly secrets list -a oakleague-voice-proxy | grep VOICE_TTS_PROVIDER
# Trigger rolling restart so the proxy picks up the new env:
fly machine restart -a oakleague-voice-proxy --select
```

**Pre-flight before the flip:**
- [ ] Step 3 burn-in passed all criteria.
- [ ] Every published creator either: (a) has `hume_voice_id` set, OR (b) has `tts_provider='cartesia'` explicitly. Otherwise their next session-open will 409 `creator_voice_not_trained`.
  ```sql
  -- Find creators that would 409 after the env flip (audit C2 fix).
  -- Catches BOTH "tts_provider IS NULL (inherit env)" AND "tts_provider='hume'
  -- but env-scoped hume voice column NULL" cases.
  SELECT id, handle, tts_provider, hume_voice_id, hume_voice_id_preview
    FROM public.creators
   WHERE published_at IS NOT NULL
     AND (tts_provider IS NULL OR tts_provider = 'hume')
     AND hume_voice_id IS NULL;
  -- For each row: either clone on Hume + paste id (admin UI), OR pin
  -- tts_provider='cartesia' (admin UI), OR un-publish.

  -- Informational — creators trained on PREVIEW env only; if a preview
  -- Vercel deploy is your test surface, these are fine for preview but
  -- will 409 in production.
  SELECT id, handle
    FROM public.creators
   WHERE hume_voice_id_preview IS NOT NULL
     AND hume_voice_id IS NULL;
  ```
- [ ] Fresh-deploy smoke test: open one production session and verify audio plays. (v1 fleet: Vuk is the only creator — verify on Vuk's account. When a second Hume-cloned creator exists, smoke-test against THAT one to confirm the env-default Hume routing works for non-override creators.)

**Rollback at this step:** flip the env back. Sessions opened during the bad window finish on Hume per snapshot; new ones go back to Cartesia.

```bash
fly secrets set VOICE_TTS_PROVIDER=cartesia -a oakleague-voice-proxy
fly machine restart -a oakleague-voice-proxy --select
```

**After a successful flip, record the cut-over timestamp** so step 6's 30-day gate has a machine-readable anchor (audit M3 fix):

```sql
-- Audit S9 (unit-wide) — tag the cut-over event under service='hume' so
-- the audit-trail filter doesn't co-mingle the marker with Gemini turn
-- cost rows. The operation string is unique to this event.
INSERT INTO public.cogs_log (
  user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata
) VALUES (
  '<vuk-user-id>', NULL, 'hume', 'hume_cutover_complete', 1, 'event', 0, 'production',
  jsonb_build_object('v2_rpc_first_prod_use', now(), 'note', 'HUME_TTS_PLAN §8 step 4 cut-over')
);
```

Step 6's gate query reads this row to compute the 30-day window. (Re-using `cogs_log` because it's already provisioned for cross-event auditing; no new table needed.)

---

## Step 5 — 7-day production observation

Watch the per-provider cost dashboard at `/admin/cogs` (HUME_TTS_PLAN §6.12 widget). Daily checks:

- [ ] **Cost line:** Hume daily cost ≤ predicted (~15.2% of Cartesia at same character volume; HUME_TTS_PLAN §10: $7.60/1M chars ÷ $50/1M chars). If higher, audit a few sessions — possibly chars/turn went up.
- [ ] **TTFA p50** in Fly logs: warm Hume ≤ 1.5× Cartesia baseline.
- [ ] **Fatal codes:** zero `tts_failed`, zero `4006`, zero `4014` per day.
- [ ] **Cap-exceeded rows:** `metadata.tts_cap_exceeded` count should be ~0 in steady state. Anything above 0/day means `server/voice-proxy/gemini-bridge.js` `OUTPUT_TRANSCRIPT_MAX_CHARS` (per CLAUDE.md hard rule: 4000 chars) was breached upstream — investigate that, not Hume.
- [ ] **Sentry:** zero unmapped `unknown_hume_error_code` events. If any appear, add the code to `HUME_ERROR_MAP` in `hume-bridge.js:107`.

**Rollback at this step:** same as Step 4. Active production sessions take ~15 min (cap) to drain.

---

## Step 6 — Retire VOICE_CARTESIA_ENABLED env (separate PR)

Once 7 days of production are clean on Hume, the `VOICE_CARTESIA_ENABLED` flag is dead weight. It originally gated "α' on/off"; with Hume in prod, α' is always on. Drop the env var + the dead branches.

This is a **separate PR**, not part of the cut-over. Don't pair it with the cut-over itself.

**30-day gate check (audit M3 fix) — run before merging:**
```sql
SELECT (now() - (metadata->>'v2_rpc_first_prod_use')::timestamptz) AS days_since_v2,
       (now() - (metadata->>'v2_rpc_first_prod_use')::timestamptz) >= interval '30 days' AS gate_passed
  FROM public.cogs_log
 WHERE operation = 'hume_cutover_complete'
 ORDER BY created_at DESC
 LIMIT 1;
-- gate_passed must be `true` before proceeding.
```

Also verify zero in-flight sessions opened before the v2 deploy timestamp:
```sql
SELECT count(*) FROM public.sessions
 WHERE ended_at IS NULL
   AND started_at < (
     SELECT (metadata->>'v2_rpc_first_prod_use')::timestamptz
       FROM public.cogs_log
      WHERE operation = 'hume_cutover_complete'
      ORDER BY created_at DESC LIMIT 1
   );
-- Must be 0.
```

Tasks in that PR:
- Drop `VOICE_CARTESIA_ENABLED` env var + remove `useTts = useCartesia` aliasing in proxy.
- Drop `cogs_insert_turn_voice` v1 RPC + `voice_clone_finalize_locked` v1 (both became forwarding shims). Migration: `20260521000001_drop_v1_voice_rpcs.sql`.
- **REQUIRED:** also ship `20260521000001_drop_v1_voice_rpcs__revert.sql` in the SAME PR — a CREATE OR REPLACE restoration script for both functions (audit M6 fix). Without this script, step 6 has NO rollback path; reverting the merge PR alone does not restore the dropped functions, and old proxy VMs running the v1 caller would throw `function does not exist` indefinitely.
- Drop `tts_provider` DEFAULT clauses on `voice_clone_uploads` + `voice_delete_queue` (already in migration 20260520000007).
- Verify writer-discipline CI grep still passes after default removal.

**Rollback for step 6:** apply `20260521000001_drop_v1_voice_rpcs__revert.sql` to restore the dropped functions, then revert the proxy code PR, then redeploy. Order matters — restore the DB symbols BEFORE deploying the reverted proxy build.

**Do not** drop the `voice_id` columns or any Cartesia code — Cartesia stays as a fallback / per-creator override option indefinitely.

---

## Step 7 — Update product comms

Once cut-over is stable:
- [ ] Update `CLAUDE.md` "Stack" line: replace "Cartesia Sonic 3 (cloned voice TTS — the **only** voice path; zero bland AI voice anywhere)" with **"Hume Octave 2 (default cloned-voice TTS, default per A/B verdict 2026-MM-DD) / Cartesia Sonic 3 (per-creator fallback, also cloned voice — never a bland AI voice on either path)"**. The "no bland AI voice anywhere" hard rule still holds for both providers; both are cloned-voice.
- [ ] Add cost note to YC application's progress section if applicable
- [ ] Memo the team (if any) — pricing math, decision rationale, rollback path

---

## Quick-reference: rollback commands

| Step | Rollback |
| --- | --- |
| Step 2 (creator flip) | Admin UI → "TTS Provider" panel → select `inherit env (default)` → Save. The action calls `creator_set_tts_provider(p_value:=NULL)` which row-locks + enforces active-session guard. **Do NOT use raw SQL UPDATE**. |
| Step 4 (env flip) | `fly secrets set VOICE_TTS_PROVIDER=cartesia -a oakleague-voice-proxy && fly machine restart -a oakleague-voice-proxy --select` (in-flight sessions get a `1012 service_restart` close via graceful WS drain). |
| Step 6 (PR merged) | Apply `20260521000001_drop_v1_voice_rpcs__revert.sql` to restore the dropped functions, then revert the proxy code PR, then redeploy. Order matters — DB symbols restored BEFORE reverted proxy build. |

---

## What NOT to do

- ❌ Flip multiple creators at once during burn-in. Single creator = isolatable blast radius.
- ❌ Pair the cut-over PR with the env-retire PR. Two separate PRs.
- ❌ Drop the v1 RPC shims before the 30-day gate. Old proxy VMs may still be calling them during rolling deploys.
- ❌ Flip `VOICE_TTS_PROVIDER=hume` with even one published creator missing a Hume voice clone (will 409 their next session).
- ❌ Skip the cancellation-waste harness. Phase-0 risk 11.2 is real.
