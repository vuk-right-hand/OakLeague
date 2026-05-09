# Brain Wire-Up — Manual Test Runbook

**Branch under test**: `feat/brain-wireup`
**Commits**: `8a49b47` (PR-1) → `7d95e4c` (PR-2) → `01c102d` (PR-3) → `7c3c3a0` (whole-build fix)

This runbook walks the full deploy + verification flow. Targets staging first, then prod. Each section has a **PASS** condition; if any fails, do NOT proceed.

---

## Phase 0 — Local pre-flight (before deploy)

### 0.1 — Restart Docker Desktop

Docker Desktop must be running for local Supabase + pgTAP. If `docker ps` errors out, start it from Start Menu, wait until status shows "running."

### 0.2 — Apply migrations to local DB

```bash
cd c:/Antigravity/OakLeague
supabase db reset
```

**PASS**: ends with `Finished supabase db reset on branch feat/brain-wireup.` and no `ERROR:` lines.

### 0.3 — Run the full pgTAP suite

```bash
for f in supabase/tests/session_open_hook_creator_mismatch_rejected.test.sql \
         supabase/tests/creator_brain_compile_persona_shape.test.sql \
         supabase/tests/creator_brain_compile_null_bio_zero_topics.test.sql \
         supabase/tests/creator_brain_compile_null_display_name.test.sql \
         supabase/tests/creator_brain_compile_does_not_flip_brain_status.test.sql \
         supabase/tests/creator_brain_compile_idempotent.test.sql \
         supabase/tests/creator_brain_compile_owner_can.test.sql \
         supabase/tests/creator_brain_compile_admin_revoked_unauthed.test.sql \
         supabase/tests/creator_brain_compile_unsafe_blocked_from_roles.test.sql \
         supabase/tests/creator_brain_compile_concurrent.test.sql \
         supabase/tests/approve_creator_application_compiles_brain.test.sql \
         supabase/tests/voice_tickets_brain_payload_check.test.sql \
         supabase/tests/voice_tickets_purge_consumed.test.sql; do
  echo "=== ${f##*/} ==="
  docker exec -i supabase_db_oakleague psql -U postgres -d postgres -t < "$f" 2>&1 | grep -E "^( ok |^ not ok|^ERROR)" | head -10
done
```

**PASS**: every line should be ` ok N - …`. Any ` not ok` or `ERROR` blocks deploy.
**Expected total**: 48 assertions across 13 files.

### 0.4 — Run vitests + typecheck

```bash
npm run typecheck && npx vitest run --reporter=dot
```

**PASS**: `463 passed (463)` and typecheck clean.

### 0.5 — Run the 2 measurement spikes against real Gemini

These pin two production constants. Do them BEFORE deploying — both run in <2 minutes.

```bash
# Resumption regression: does a 700-char persona survive a 1000-close + reopen?
GEMINI_API_KEY=$YOUR_KEY node scripts/brain-resumption-spike.mjs
```

**PASS**: exit 0, output contains `[PASS] persona + seed survived resume`.
**FAIL fallback**: exit 1 → fall back path required (persona via `sendClientContent` instead of `LiveConnectConfig.systemInstruction`); document and pause.

```bash
# Server-side seed-ingest latency p99 across 1KB / 30KB / 90KB:
GEMINI_API_KEY=$YOUR_KEY BRAIN_SPIKE_TRIALS=10 node scripts/brain-seed-ingest-latency-spike.mjs
```

Output ends with: `recommended BRAIN_SEED_MARGIN_MS = NNN`. Take this number.

**Action**: set `BRAIN_SEED_MARGIN_MS_OVERRIDE=NNN` as a Fly secret on the voice proxy (see Phase 2.2). If `recommended > 1000`, do NOT just bump — investigate; the constant has a 5000 max, and >1s p99 suggests Gemini is degraded.

---

## Phase 1 — Migration deploy (staging FIRST)

### 1.1 — Apply migrations to staging

```bash
# From a checkout pointing at the staging Supabase project
supabase link --project-ref <staging-ref>
supabase db push
```

**PASS**: 6 migrations land in order:
- `20260511000000_session_open_hook_creator_binding.sql`
- `20260511000001_creators_system_prompt.sql`
- `20260511000002_creator_brain_compile_rpc.sql`
- `20260511000003_approve_calls_brain_compile.sql`
- `20260511000004_voice_tickets_brain_payload.sql`
- `20260511000005_voice_tickets_purge_consumed.sql`

### 1.2 — Verify pg_cron registration (whole-build audit C4)

In the Supabase SQL editor for staging:

```sql
SELECT jobname, schedule, command
  FROM cron.job
 WHERE jobname = 'voice_tickets_purge_consumed_daily';
```

**PASS**: 1 row. **FAIL**: zero rows means pg_cron isn't enabled on the project.
**Fix**: Supabase Dashboard → Database → Extensions → enable `pg_cron`, then re-run migration `20260511000005`.

### 1.3 — Run backfill SQL job

In the Supabase SQL editor for staging:

```sql
-- Paste contents of supabase/sql_jobs/2026-05-11-brain-compile-backfill.sql
```

**PASS**: ends with `NOTICE: brain-compile backfill: N compiled, M skipped (already fresh), 0 failed`. Zero failures.

### 1.4 — Verify backfill coverage

```sql
SELECT count(*) FILTER (WHERE system_prompt IS NULL) AS null_prompts,
       count(*) AS total
  FROM creators
 WHERE brain_status <> 'errored';
```

**PASS**: `null_prompts = 0`.

---

## Phase 2 — Code deploy

**Order is load-bearing**: migrations are already in (Phase 1). Now ship app + proxy.

### 2.1 — Vercel deploy (staging)

Push `feat/brain-wireup` to a Vercel preview branch, OR merge to `main` if going straight to prod. Vercel deploys on push.

**PASS**: Vercel build status = green. Smoke check: `curl https://<preview-url>/healthz` returns 200 (or whatever your existing health endpoint is).

### 2.2 — Voice-proxy deploy (Fly)

Set the seed-margin secret first if the spike measured ≠ 250ms:

```bash
flyctl secrets set BRAIN_SEED_MARGIN_MS_OVERRIDE=NNN --app oakleague-voice-proxy-staging
```

Deploy:

```bash
flyctl deploy --app oakleague-voice-proxy-staging
```

**PASS**: `flyctl status` shows the new revision serving. Tail logs:

```bash
flyctl logs --app oakleague-voice-proxy-staging
```

Wait for a clean WS open (anyone can trigger by visiting the staging site and tapping a hook). Look for:

```
[ws ABCD] gemini.open ok in 800ms (sysprompt=NNNc prefix=y)
```

**PASS**: `sysprompt=` shows a non-zero char count (persona delivered) and `prefix=y` (or `prefix=n` if the hook has no overlap, also fine).

---

## Phase 3 — End-to-end validation (staging UI)

### 3.1 — Approve a creator via the real flow

1. Sign in as admin → https://staging-url/admin/applications
2. If no pending applications, create one: sign out, visit https://staging-url/apply with an invite token. Complete the form (handle, display name, bio "I teach cold outreach", at least one topic with slug "outreach", topics + proof JSON valid).
3. Sign back in as admin → https://staging-url/admin/applications → click the new application → "Approve."

**PASS**: redirect to `/admin/applications` with success state. The creator now appears at https://staging-url/admin/creators.

### 3.2 — Verify persona compiled at approve-time

Click the creator's row → land on https://staging-url/admin/creators/[id]

In the **Brain status** section, check:
- `brain_status` = `training`
- `system_prompt` = `NNN bytes` (non-zero)
- `brain_compiled_at` = a timestamp (just now)

**PASS**: all three populated. **FAIL**: `system_prompt = — (not compiled)` means migration M3 didn't fire — investigate.

### 3.3 — Test the admin Recompile button

Click **Recompile brain** on the same page.

**PASS**: button changes to "Recompiling…", then back to "Recompile brain." A success line appears: `last compile: <new timestamp> · NNN bytes`.

### 3.4 — Voice clone + face upload (existing flows)

Without these the session-open will 409 on `creator_voice_not_trained` or `creator_not_ready` — separate from the brain gate.

1. **Voice clone**: on the same admin page, "Voice clone" section → upload a 30-second WAV of the creator's voice.
   **PASS**: `cartesia voice_id` populates within ~30 seconds of upload.
2. **Face upload**: same page, "Face upload" tab (Photo, not Video — Video is greyed) → upload a portrait JPG.
   **PASS**: `simli face_id` populates within ~60 seconds.

### 3.5 — Open a session (THE big test)

Sign out → sign in as a regular non-admin user → https://staging-url/feed (or however the staging feed is configured to surface this creator's hooks).

1. Find a hook for the freshly-approved creator. Tap it (mobile) or click (desktop).
2. Watch the long-form video play.
3. When the mic-tap UI appears, tap and ask: **"What's your name?"**

**PASS criteria** (all four must hold):
- ✅ Avatar speaks back (no 409 on session-open)
- ✅ Response transcript contains the creator's display_name
- ✅ Response is in the **cloned voice** (not Cartesia stock; you can tell — listen)
- ✅ No "I am Gemini / I am an AI assistant" generic disclaimer

**Verify in the browser network panel** (DevTools → Network):
- `/api/sessions/open` → 200 OK
- WS connection to `wss://oakleague-voice-proxy-staging.fly.dev/voice/spike-a?ticket=…` → opens, no 4013/4009/4002 close

### 3.6 — Test the brain_not_ready gate (negative test)

In the Supabase SQL editor for staging:

```sql
-- Manually break a different creator's persona to test the 409 path.
-- DON'T run this against the creator you just used in 3.5.
UPDATE creators
   SET system_prompt = NULL
 WHERE id = '<some-other-creator-id>';
```

Tap one of THAT creator's hooks as a non-admin.

**PASS**: page shows error "Brain not ready" or 409 in network panel. WS does NOT open.

**Then restore**:

```sql
SELECT _creator_brain_compile_unsafe('<some-other-creator-id>');
```

### 3.7 — Test the hook↔creator binding fix (security check)

Pick two creators (A and B) and find one of B's hook IDs. Open browser DevTools → Network. In the console:

```js
fetch('/api/sessions/open', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    creator_id: '<creator-A-id>',
    hook_id: '<hook-of-B-id>',
    model: 'gemini-3.1-flash-live-preview',
  }),
}).then(r => r.json()).then(console.log)
```

**PASS**: response is `{ error: 'hook_creator_mismatch' }` with HTTP 400. **FAIL**: success or 500 → privacy bug regressed.

### 3.8 — Test creator-side auto-recompile

Sign in as the creator (the one approved in 3.1) → https://staging-url/creator/brain.

1. Add a new topic (slug `pricing`, title `Pricing`).
2. Wait ~3 seconds.
3. Sign out → sign back in as admin → https://staging-url/admin/creators/[id].
4. The `brain_compiled_at` timestamp should be ~3 seconds AFTER the topic add. The `system_prompt` byte count should differ.

**PASS**: timestamp advanced + persona content changed without admin clicking Recompile. **FAIL**: stale → `after()` recompile didn't fire; check Sentry for `creator_brain_recompile_after` exceptions.

---

## Phase 4 — Telemetry verification

### 4.1 — PostHog events landing

Open https://eu.posthog.com → Activity → Events (filter: last 1 hour).

**PASS** (events visible, in this order roughly):
- `brain_prefix_built` with props `{creator_id, hook_id, source_count, total_raw_chars, encoded_bytes}` — fires once per session-open with overlapping samples.
- `brain_prefix_skipped` with `reason: 'no_overlap'` or `'builder_error'` — fires when buildBrainPrefix returns null.
- `brain_admin_preview` — fires when the admin used in 3.6's negative test bypasses the gate.
- `brain_prefix_reseeded` — fires at session-end if the bridge re-seeded (which it always does on every connect; count=1 normal, count>1 if the session hit js-genai#707 reopens).

If you don't see them within 5 min of the session: PostHog client probably isn't initialized on staging. Check `NEXT_PUBLIC_POSTHOG_KEY` env on Vercel.

### 4.2 — Sentry breadcrumbs + errors

Open https://sentry.io → Issues for the staging project (last 1 hour).

**Expected if you ran 3.6 (negative test)**:
- 1 error event titled `brain.not_ready` with the affected creator_id in extras.

**Expected if you ran 3.7 (binding negative)**:
- May see no Sentry event — 400 mismatch is logged but not Sentry-level. That's fine.

**Should NOT see**:
- `brain.prefix_builder_error` (means buildBrainPrefix threw — investigate)
- `brain.unset_with_cartesia` (4013 close at proxy — means a session got past the route gate without persona; investigate)
- `brain.admin_recompile_errored_creator` (only if you recompiled an explicitly errored creator — fine if intended)

---

## Phase 5 — Production rollout

Once staging Phase 3 + 4 are PASS:

```bash
# Same order as staging.
git checkout main
git merge feat/brain-wireup --no-ff
git push origin main          # triggers Vercel prod deploy

# Apply migrations to prod Supabase
supabase link --project-ref <prod-ref>
supabase db push

# Run prod backfill (use Supabase prod SQL editor, paste sql_jobs/2026-05-11-brain-compile-backfill.sql)
# Verify Phase 1.4 query returns null_prompts=0

# Set BRAIN_SEED_MARGIN_MS_OVERRIDE on prod proxy (use the value from Phase 0.5)
flyctl secrets set BRAIN_SEED_MARGIN_MS_OVERRIDE=NNN --app oakleague-voice-proxy

# Deploy prod proxy
flyctl deploy --app oakleague-voice-proxy

# Verify pg_cron job registered on prod (Phase 1.2 query)
```

Repeat **Phase 3.5 (real session)** against prod with one production creator (Vuk, once approved through the real flow). PASS = avatar speaks as Vuk in Vuk's cloned voice.

---

## Rollback

If anything in Phase 3 fails after prod deploy:

```bash
# Revert main to before merge
git revert -m 1 <merge-commit-sha>
git push origin main           # Vercel re-deploys old version

# Roll proxy back to previous release on Fly
flyctl releases --app oakleague-voice-proxy
flyctl deploy --image <previous-image> --app oakleague-voice-proxy
```

Migrations are NOT rolled back — they're forward-compatible (new columns are nullable; new RPCs unused by the rolled-back app). Brain gate at the route is the only behavior change.

For the gate specifically: temporarily flip the route to allow everything by hand-editing `brain_not_ready` to short-circuit, deploy, investigate root cause.

---

## Quick links

| What | URL |
|---|---|
| Plan | [docs/_planning/BRAIN_WIRE_UP_PLAN.md](BRAIN_WIRE_UP_PLAN.md) |
| Branch | `feat/brain-wireup` |
| Staging admin | `<staging-url>/admin/creators` |
| Staging apply | `<staging-url>/apply` |
| Prod admin | `<prod-url>/admin/creators` |
| Sentry | `https://sentry.io` |
| PostHog | `https://eu.posthog.com` |
| Fly proxy logs | `flyctl logs --app oakleague-voice-proxy` |
| Supabase SQL editor | `https://supabase.com/dashboard/project/<ref>/sql/new` |

## Quick failure decoder

| Symptom | Likely cause | Fix |
|---|---|---|
| 409 brain_not_ready on EVERY session | Backfill didn't run / persona NULL | Re-run backfill SQL job; check Phase 1.4 query |
| WS closes 4013 brain_unset_with_cartesia | Persona missing despite gate passing — bypass path | Check Sentry for which creator; investigate route gate logic |
| WS closes 4009 cartesia_no_voice | Creator's voice clone missing | Voice clone via `/admin/creators/[id]` |
| WS closes 4002 session_already_active | Reaper hasn't cleaned old session yet | Wait 60s, retry |
| 400 hook_creator_mismatch | Hook is from a different creator's video | Pick the right hook |
| Pre-mic-audio transcript chunk in WS | `BRAIN_SEED_MARGIN_MS` too low | Re-run ingest-latency spike, bump override |
| Sentry `brain.prefix_builder_error` | sample_content schema mismatch / bug | Read the breadcrumb extras for the creator_id |
| `brain_compiled_at` not advancing on creator edit | `after()` recompile fails | Sentry `creator_brain_recompile_after` |
