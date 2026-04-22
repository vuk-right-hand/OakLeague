# Days 13–14 Handoff — Admin Console Polish Window

**Audience:** The next agent/session picking up Days 13–14 after Days 8–12
voice pipeline build wraps. **Date handed off:** 2026-04-22.
**Window:** 2026-05-02 → 2026-05-04 (3 days before YC deadline 2026-05-06).
**Scope:** Admin console surfaces defined in CLAUDE.md + final polish before
YC submission. **Out of scope:** voice architecture reopens, provider swaps,
schema redesigns.

---

## Read this first — decisions that are LOCKED

These were settled over the Days 8–12 build. Do not re-open them. If they
seem wrong to you, you're missing context — read the referenced files
before proposing a change.

### Voice architecture is Pipeline α' — frozen

> user audio → `gemini-3.1-flash-live-preview` (`responseModalities:[AUDIO]`
> + `outputAudioTranscription:{}`) → we read the streaming
> `outputTranscription.text` chunks → **discard the audio bytes Google
> synthesized** → Cartesia Sonic 3 WS (IVC cloned voice per creator) →
> user hears creator's own cloned voice.

- **Pipeline α (literal `responseModalities:[TEXT]`) is dead.** Google's
  docs advertise it; the preview model rejects the config at WS open with
  "Internal error encountered." Verified live 2026-04-22. Do not retry.
- **β fallback (Gemini 2.5 STT → 2.5 Pro brain → Cartesia) exists in code
  only as emergency-break-glass.** Never propose promoting it. 2.5 is
  ~2× slower than 3.1 on audio-in per Spike-A (2026-04-21).
- **Gemini's stock voices (Puck, etc.) NEVER reach a user's ears on any
  tier.** Cloned Cartesia voice is non-negotiable. See feedback memory
  `cloned_voice_everywhere`.

**Tier is a minutes-per-day dial, not a pipeline swap.** Free / Premium /
Boardroom all run α'. Caps live on `profiles`:

| Column | Default | Meaning |
|---|---|---|
| `voice_daily_cap_seconds`   | 300  (5 min)  | Free baseline |
| `voice_weekly_cap_seconds`  | 900  (15 min) | Funnel lever; NULL = disabled |
| `voice_monthly_cap_seconds` | NULL (unlimited) | Paid-tier knob; NULL = unlimited |

Enforced by RPCs `voice_usage_record` (at turn-flush, exactly-once via
`voice_usage_turns` PK) and `voice_usage_ticket_check` (at session-open).

### Avatar provider is Simli Trinity-1 on every tier

**Tavus was scrapped after Spike B** — 502'd on every attempt. Simli
handles all tiers. Premium avatar provider re-evaluated post-YC.
`sessions.tier_at_session` is still snapshotted so a future swap is a
bridge-file change, not a product refactor. See memory `tavus_scrapped`.

### Schema is frozen for Days 13–14

- **12-migration batch (0045–0056)** is the Days 8–12 delivery. If Vuk has
  already applied it, treat those tables as immutable. If still pending,
  apply as-is before touching anything else — the batch is internally
  consistent and REV 5.2-audited.
- **Do not add `cogs_insert_turn_*` variants.** `cogs_insert_turn_voice`
  (4-leg) covers every voice turn. Legacy `cogs_insert_turn` was dropped in
  0055 and is not coming back.
- **`voice_usage_record` signature is fixed:**
  `(user_id uuid, session_id uuid, turn_number int, seconds numeric,
   turn_started_at timestamptz DEFAULT NULL) RETURNS boolean`.
  Returns `true` if counters incremented, `false` if turn was already
  recorded (idempotent no-op). The proxy decides what to do with `false`
  (log-only; no error).

### Creator model + onboarding flow is LOCKED

Invite-only in v1. Admin generates invite → creator signs up via token →
fills application → admin reviews queue → approves → brain-training job
runs → published. Do not add self-serve creator signup. See
`docs/OAKLEAGUE_WALKTHROUGH.md`.

`creators.creator_type enum: human | brand | sponsored_segment`. v1 uses
`human` only. Other types exist in schema for v2 (interactive ads) — do
not prune them.

---

## Admin console scope (CLAUDE.md §"Admin console in v1")

Days 13–14 delivers these five surfaces. Everything else is v2.

### 1. Creator invitation generator
- Page: `/admin/creators/invites` (existing — verify + polish).
- Creates single-use invite tokens. Token → `/apply?token=xxx` → creator
  onboarding flow.
- Lists outstanding (unconsumed) invites with expiry + revoke action.

### 2. Application review queue
- Page: `/admin/creators/applications` (existing).
- Columns: applicant name, topic drawer titles, voice sample (play inline),
  submitted_at, action (approve / reject / request-changes).
- Approve → kicks brain-training job + Cartesia clone upload flow.

### 3. Creator brain-status visibility
- On creator detail page (`/admin/creators/[id]`), show:
  - Brain-training job state (queued / running / succeeded / failed).
  - Sample content indexed count per topic drawer.
  - Cartesia voice_id presence + last clone upload timestamp.
- Read-only. Do not add re-trigger actions unless Vuk asks.

### 4. Manual tier flip + voice cap edit (per user)
- Page: `/admin/users/[id]`.
- Editable fields:
  - `profiles.tier` (`free | premium | boardroom`, default `free`).
  - `profiles.voice_daily_cap_seconds` (int 0–86400).
  - `profiles.voice_weekly_cap_seconds` (int 0–604800 or NULL).
  - `profiles.voice_monthly_cap_seconds` (int 0–2678400 or NULL).
- Server action calls a new `admin_set_user_voice_caps(user_id, caps)` RPC
  — one RPC, service-role-only, uses `assertAdminFromSession` +
  service-role Supabase client (see `src/lib/auth-guards.ts`).
- **Never** flip tier mid-session. Changes take effect at the user's next
  ticket-mint.

### 5. COGS log viewer with real-time per-session cost
- Page: `/admin/cogs`.
- Two tabs:
  - **Live sessions**: rows from `sessions` where `ended_at IS NULL`,
    joined with `SUM(cogs_log.cost_usd) WHERE session_id = ... AND
    operation LIKE 'voice_%'` — running total per session.
  - **Historical**: paginated `cogs_log` with filters on service,
    operation, user_id, date-range.
- Group charts by `operation` — α' legs are:
  - `gemini.voice_audio_input_seconds` (billable)
  - `gemini.voice_audio_out_tokens` (billable — paid-and-discarded)
  - `cartesia.voice_tts_characters` (billable — primary Cartesia unit)
  - `cartesia.voice_tts_audio_seconds` (cost=0, observability only — drives
    minutes-per-day cap)
- Do NOT double-count: sum `cost_usd`, not units. Leg 4 has cost=0 on
  purpose.

---

## Files / tables that already exist — do not recreate

### Migrations (in `supabase/migrations/`)

| File | What |
|---|---|
| `20260428000001_cogs_insert_turn_voice.sql` | 4-leg α' COGS RPC. Call via service-role client. |
| `20260428000002_voice_usage_counters.sql` | `voice_usage_turns` + `voice_usage_daily` + `voice_usage_weekly` + `voice_usage_record` RPC + `voice_usage_ticket_check` RPC. |
| `20260420000020_cogs_log.sql` | The append-only `cogs_log` table + block-update/delete triggers. |
| `20260427000007_cogs_log_turn_number_and_idempotency.sql` | Partial unique index `cogs_log_turn_idempotency` on `(session_id, turn_number, service, operation)`. |

### Voice bridge + proxy code

| Path | What |
|---|---|
| `src/lib/voice/audio-bridge.ts` | Provider-agnostic voice session interface. `enableOutputTranscription` opt + `output_transcription_chunk` events are the α' hooks. |
| `server/voice-proxy/gemini-bridge.js` | Production GeminiBridge. Pipeline α' config lives here when Phase 1 proxy swap ships. |
| `server/voice-proxy/index.js` | Fly proxy entrypoint. Currently Spike-A; Phase 1 swap is Days 8–12. |

### Phase 0 evidence

| Path | What |
|---|---|
| `docs/_planning/PHASE_0_MEASUREMENTS.md` | Live runtime gate, sign-off table. |
| `scripts/voice-phase0-verify.mjs` | Re-runnable if Google ships a new preview string. |
| `scripts/fixtures/voice-test-vuk-hello.wav` | Real-speech fixture for check #7. |

### Admin infrastructure (in `src/lib/`)

| Path | What |
|---|---|
| `src/lib/auth-guards.ts` | `getCallerUserId()` + `assertAdminFromSession()`. **Every admin server action must call one.** Never inline the auth check. |
| `src/app/admin/*` | Existing admin pages. Read them before adding — most surfaces exist in skeleton form. |

---

## Prime directives (repeated for emphasis — taken from CLAUDE.md)

1. **Verify, don't guess.** Web search official docs before claiming a version, API, or capability works. Phase 0 caught Google's docs lying about TEXT-out support; docs are not a substitute for runtime.
2. **No hardcoded IDs, no "v2 becomes real later."** If you're tempted to stub `is_founder` or inline a UUID, stop and wire the real flow.
3. **Production from line one.** Schema, RLS, admin auth — all production-grade on day one.
4. **Cloned voice everywhere.** Gemini stock voice is never user-facing. If the user-facing path ever plays a Gemini voice, that's a Sev-0 bug.
5. **Tier = minutes/day dial.** Tier does not swap pipelines, models, or providers.
6. **RLS on every table. Service-role-only tables = RLS ENABLED, zero policies.** The three voice_usage_* tables are service-role-only — don't add policies when wiring the admin reader.
7. **Admin reads via service-role Supabase client in server action,** not via policies. `assertAdminFromSession` first, then service-role client.
8. **`window.location.href` after login/signup/role/tier change.** Never `router.push()`.
9. **Admin tier flip → force the user to re-mint their ticket.** Don't try to hot-swap an in-flight session.

---

## What NOT to do (red flags)

- ❌ Propose a Gemini-TEXT-out revival ("maybe the docs are right now").
- ❌ Add a tier-based model-swap anywhere.
- ❌ Add UI for toggling "use Gemini voice" / "use generic voice."
- ❌ Add `is_founder`, `is_vuk`, or any hardcoded user-UUID branch.
- ❌ Skip `assertAdminFromSession()` on a server action "just for dev."
- ❌ Add an `ON CONFLICT DO UPDATE SET ...` path to a usage counter without
  an idempotency guard — see REV 5.2 audit C2.
- ❌ Rename COGS operation strings. Dashboard aggregates depend on them.
  `voice_audio_input_seconds` is intentionally pre-α' compatible.
- ❌ Touch Tavus. Scrapped.
- ❌ Spin up a new migration to "clean up" existing ones. 0045–0056 is the
  final sequence for v1.

---

## Quickstart checklist for the Day 13–14 session

1. Read `CLAUDE.md` top-to-bottom once.
2. Read this file.
3. Read `docs/_planning/DAYS_8_12_VOICE_PLAN.md` §"REV 5.2 delta" (the
   final section) — tells you what's done and why.
4. `git log --oneline -20` to see what just landed.
5. Run `npm run build` once to confirm green before touching anything.
6. Tackle admin console surfaces in the order listed above — invite
   generator → application queue → creator detail → user detail → COGS
   viewer. Ship each to production individually; YC reviewers don't care
   about a mono-PR.
7. Final day: run the pre-deploy red team checklist
   (`docs/VIBECODERSHQ_HANDOFF.md` §17) before the last push to main.

YC deadline: **2026-05-06.** Assume no slack in the schedule.
