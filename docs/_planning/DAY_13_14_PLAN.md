# Day 13–14 — Avatar production, admin polish, landing (REV 5 FINAL)

Status: REV 5 — post-audit-4 (fold-in side-effects), ready for approval gate
Dates: May 2–3 2026 (starting Apr 22, earlier days shipped ahead of plan)
Owner: Vuk + Claude
YC deadline: 2026-05-06

**Audit history:**
- Rev 1 → audit-1: 5 Critical + 7 Medium + 12 Small — all folded
- Rev 2 → audit-2: 3 Critical + 4 Medium + 10 Small — all folded
- Rev 3 → audit-3 (integration seams): 6 Critical + 7 Medium + 10 Small — all folded
- Rev 4 → audit-4 (fold-in side-effects): 2 Critical + 3 Medium + 5 Small — all folded below
- Rev 5 → this document, ready to ship

---

## Prime question the plan answers

> A free-tier user opens the PWA on iPhone 11 over LTE, swipes through hooks, taps "Ask" on a Vuk video. Within ~3s an animated Vuk avatar answers in real time. The phone backgrounds for 10s; it resumes. Session ends cleanly. Admin can see the session, flip the user's tier without corrupting quota, and audit the change.

---

## What already exists (don't rebuild)

- `AvatarBridge` + `SimliBridge` (Spike-B-proven)
- `/api/spike-b/session` (admin-gated Simli mint — template only, production diverges)
- `public.sessions` with tier snapshot + kill-switch trigger (migration 0017)
- `daily_quotas` with 1.5× kill-switch latch (migration 0019) — **load-bearing**
- `sessions_one_active_per_user` partial unique index (migration 0421001:index)
- `sessions.last_heartbeat_at` column already exists (migration 0421001)
- `cogs_insert_turn` RPC (voice), `insertAvatarCogs` helper (avatar)
- Admin: applications, invites, content, layout
- `isSameOrigin()` pattern (copy-inline, x-forwarded-host honored)
- Caller-identity pattern: migration 0043 — SECURITY DEFINER + `ASSERT p_user_id = auth.uid()`

---

## Scope (four rocks)

1. **Avatar production wiring** — RPCs + routes + `/s/[id]` + feed integration
2. **Pipe-stays-warm + iOS background + Gemini 15-min cap** (close-and-reopen, NOT transparent resumption)
3. **Admin console expansion** — Users/tier-flip (live-session-safe), Creators/brain, COGS viewer via admin API
4. **Landing page** — `/waitlist` rewrite

Out of scope: Stripe, Tavus revival, new providers, goals-based personalization, hooks publisher UI.

---

## Phase 0 — pre-implementation spikes (45 min, blocks everything)

**P0-1 Simli Trinity flag plumbing** (M1) — **RESOLVED 2026-04-22**
- Read: `node_modules/simli-client/dist/Client.d.ts` — `SimliSessionRequest = { faceId, handleSilence, maxSessionLength, maxIdleTime, model?: "fasttalk" | "artalk" }`. NO `is_trinity_avatar` field exists.
- Finding: Trinity-1 is a server-side face attribute; Simli's `/compose/token` routes to Trinity based on the face record tied to `faceId`. No client-side flag.
- **Plan impact**: DROP `isTrinityAvatar: boolean` from `AvatarOpenOptions`. Replica `faceId` is sufficient.

**P0-2 `active_seconds` server-side computation design** (C5)
- Confirm sessions column for `paused_seconds_total` exists or needs migration
- Confirm `session_turns` table captures enough data to recover active_seconds if heartbeat is lost
- Output: data-flow diagram (3 lines) and column add-or-reuse decision

**P0-3 Mux COGS deferral** (M7)
- Confirm Mux Data API `bandwidth_seconds` + `views` endpoint is the right source
- Decision: implement nightly rollup in v1 OR defer with a dated ticket — plan says **defer with ticket** due to 14-day crunch, but ticket must be filed before end of Day 14

**P0-4 Ephemeral token mint extraction** (R3-C1) — NEW
- Decision made in advance: **Option (a)**: extract the mint into `src/lib/voice/mint-ephemeral.ts` as `mintEphemeral(model: string, callerUserId: string, env: string)` returning `{ token, expiresAt }`.
- Existing `/api/voice/ephemeral-token` route (admin-gated, Spike-A harness) becomes a thin wrapper that: admin-guards, calls the lib, writes the Spike-A COGS row.
- New production `/api/sessions/open` calls the same lib directly after `getCallerUserId()` — no admin guard.
- Rationale: matches CLAUDE.md production-from-line-one; keeps the spike harness working; no duplicated Gemini SDK init.
- Output: stubbed lib file + updated route on first Day 13 AM step.

**P0-5 SimliBridge token-injection contract** (R3-C2) — NEW
- Decision: `/api/sessions/open` mints the Simli session_token server-side (copying mint logic from `/api/spike-b/session` into `src/lib/avatar/mint-simli.ts`), then returns it to the client in the `avatar: { session_token, expires_at, face_id, is_trinity }` envelope.
- `SimliBridge.open()` gains a NEW option `preMintedSessionToken?: string`. When present, bridge SKIPS the internal fetch to `/api/spike-b/session` entirely — constructs `SimliClient` with the pre-minted token directly.
- Spike-B harness continues to work unchanged (no `preMintedSessionToken` → old path). Production always uses the pre-minted form.
- Output: lib stub + bridge signature change logged; no admin-route cross-talk in prod path.

---

## Architecture — production session flow (REV 2)

```
PWA (browser)
  │
  ├─ 1. User taps "Ask" on HookPanel
  │        └─ POST /api/sessions/open  { hook_id, creator_id }
  │              headers: same-origin, authenticated cookie
  │
  ├─ 2. Server /api/sessions/open:
  │     ├─ isSameOrigin() → 403 bad_origin  (copy-inline from spike-b)
  │     ├─ getCallerUserId() → 401 if null
  │     ├─ Parse body; translate wire-form model string ('gemini-3.1-flash-live-preview')
  │     │   to enum value ('gemini_3_1_flash_live_preview') via an ALLOWED_MODELS map
  │     │   BEFORE calling the RPC. Invalid → 400 model_not_allowed. (R3-C3)
  │     ├─ RPC session_open(p_creator_id, p_hook_id, p_model)
  │     │   SECURITY DEFINER, no p_user_id param — uses auth.uid() internally
  │     │   (matches migration 0043 cogs_insert_turn pattern)
  │     │   - Inserts public.sessions row: user_id = auth.uid()
  │     │   - Trigger snapshots tier_at_session + kill-switch + quota upsert
  │     │   - Collision on one-active-per-user index → returns 'already_active'
  │     │   - Returns (session_id, tier, daily_limit_remaining_s)
  │     ├─ Avatar mint FIRST (R3-M2 — ordering matters for FORCE_AVATAR_REQUIRED cost):
  │     │   - resolveAvatarProvider(tier) = 'simli' → mintSimliSessionToken(replica_id)
  │     │   - resolveAvatarProvider(tier) = null → avatar_status = 'skipped_tier'
  │     │   - mint fails → avatar_status = 'failed_mint' + taxonomy code
  │     │   - If FORCE_AVATAR_REQUIRED=1 AND status != 'minted':
  │     │     * CALL session_close(session_id, 'force_required_mint_failed') FIRST (R4-C2 —
  │     │       prevents orphaned row blocking retry via one-active-per-user until reaper)
  │     │     * THEN early return 503 (do NOT proceed to Gemini mint)
  │     │   - Persist avatar_status on sessions via session_set_avatar_status RPC
  │     ├─ Gemini ephemeral token mint via mintEphemeral() lib (NOT /api/voice/ephemeral-token,
  │     │   which is admin-gated and reserved for the Spike-A harness — see P0-4)
  │     └─ Response: { session_id, tier, avatar: { session_token, expires_at, face_id,
  │                    is_trinity } | null, avatar_status, gemini: { token, model:
  │                    wire-form }, max_duration_s, max_session_s: 900 }
  │     (Note: `avatar.session_token` is consumed by SimliBridge via
  │      `preMintedSessionToken` option — see P0-5. Bridge never calls /api/spike-b/session
  │      in production.)
  │
  ├─ 3. Session client /s/[id]
  │     ├─ SimliBridge.open({ replicaId,
  │     │                     preMintedSessionToken: avatar.session_token,  // R3-C2/P0-5
  │     │                     simliChunkBytes: 1920, videoEl, audioEl })
  │     ├─ GoogleGenAI Live.connect(ephemeral)
  │     ├─ Mic → AudioBridge → Gemini
  │     ├─ Gemini.onAudio → SimliBridge.sendAudio (per-chunk; pipe stays warm)
  │     ├─ Gemini.onInterrupted → SimliBridge.cancel (ClearBuffer only — PC stays)
  │     ├─ Liveness: POST /api/sessions/heartbeat every 20s
  │     │   - Client sends { session_id } only. NO delta_seconds.
  │     │   - Server bumps last_heartbeat_at; rate-limited to >=10s floor.
  │     │   - Ownership asserted: session.user_id = auth.uid() AND ended_at IS NULL.
  │     ├─ visibilitychange hidden →
  │     │     POST /api/sessions/pause; stop mic; leave PC+WS open
  │     ├─ visibilitychange visible →
  │     │     POST /api/sessions/resume; audioCtx.resume();
  │     │     if PC.iceConnectionState in ('disconnected','failed') OR
  │     │        Gemini WS readyState=CLOSED → close + show "Tap to reconnect"
  │     │     ALSO: if audioCtx.state !== 'running' 300ms after resume() call →
  │     │        show "Tap to reconnect" overlay (iOS WebKit requires user gesture
  │     │        to resume AudioContext; visibilitychange is not a gesture — R3-M4)
  │     └─ 15-min Gemini cap (900s hard):
  │         - ATOMIC RPC session_rollover(old_id, creator_id, hook_id, model)
  │           closes old row + inserts new row in ONE transaction
  │         - Client calls one endpoint: POST /api/sessions/rollover
  │         - Avoids unique_violation race on sessions_one_active_per_user (R2-C1)
  │         - end_reason='gemini_15min_cap'; new.metadata.prev_session_id = old_id
  │         - User sees "Reconnecting…" state (NOT silent resumption)
  │
  ├─ 4. Session close
  │     └─ POST /api/sessions/close { session_id, end_reason }
  │         ├─ RPC session_close(p_session_id, p_end_reason)
  │         │   - auth.uid() ownership check
  │         │   - active_seconds := LEAST(now() - started_at - paused_seconds_total,
  │         │                              tier_limit_s)
  │         │   - sets ended_at, status='ended'
  │         │   - server-computed, not client-reported (C5)
  │         └─ Avatar COGS: per-turn rows written during session
  │             (NOT a single close-time sum — live dashboard needs granularity)
  │
  └─ 5. Admin /admin/cogs, /admin/users, /admin/creators
        └─ Every admin view behind assertAdminFromSession()
```

---

## Files to build / modify

### Migrations (all RLS enabled; SECURITY DEFINER uses `auth.uid()` + explicit assert pattern from 0043)

1. **`20260502000001_sessions_avatar_status_and_pause.sql`** (C2-R1, C5-R1, M3-R2, R3-S8, R4-C1)
   - `ALTER TABLE sessions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 4096)` — **REQUIRED** (R4-C1: `public.sessions` has no `metadata` column today per migration 0017 inspection; rollover writes `metadata->>'prev_session_id'` — ships broken without this). 4096-byte cap matches `admin_audit_log`.
   - `ALTER TABLE sessions ADD COLUMN avatar_status text CHECK (avatar_status IN ('pending','minted','skipped_tier','failed_mint','failed_connect','not_applicable'))` — **nullable, defaults `'pending'`** (R2-M3 window resolution). Legal transitions: `pending → {minted, skipped_tier, failed_mint, not_applicable}` AND `minted → failed_connect` (R3-S7: post-mint WS drop distinct from pre-mint failure).
   - `ALTER TABLE sessions ADD COLUMN paused_seconds_total int NOT NULL DEFAULT 0 CHECK (paused_seconds_total >= 0)`
   - `ALTER TABLE sessions ADD CONSTRAINT active_seconds_sane CHECK (active_seconds <= 28800)` — defensive upper bound (single-session cap, 2× boardroom daily)
   - `public.session_pauses(id, session_id uuid REFERENCES sessions(id) ON DELETE CASCADE, paused_at timestamptz NOT NULL DEFAULT now(), resumed_at timestamptz CHECK (resumed_at IS NULL OR resumed_at >= paused_at))`
   - `CREATE UNIQUE INDEX session_pauses_one_open_per_session ON session_pauses (session_id) WHERE resumed_at IS NULL` (R2-Small: double-pause guard)
   - RLS enabled on session_pauses, zero policies (service-role via RPCs only)
   - Stale-pending reaper updates (R3-S8 — distinguish mint-never-completed from heartbeat-stale ghosts):
     * If `avatar_status='pending' AND last_heartbeat_at IS NULL AND created_at < now() - interval '60s'` → `avatar_status='failed_mint'`, `end_reason='mint_never_completed'`
     * If `last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '90s'` → `end_reason='ghost_reaper'` (existing behavior)
     * Function signature unchanged; internal branching only.

2. **`20260502000002_sessions_rpcs.sql`** (C1-R1, C3-R1, C4-R1, C5-R1, C1-R2, C3-R2, R3-M1, R3-M6)
   - `session_open(p_creator_id uuid, p_hook_id uuid, p_model voice_model) RETURNS TABLE(session_id uuid, tier profile_tier, daily_limit_remaining_s int)`
     SECURITY DEFINER; uses `auth.uid()` internally (NO p_user_id param); seeds `avatar_status='pending'`; catches unique_violation on one-active-per-user index → raises `'already_active'`
   - `session_close(p_session_id uuid, p_end_reason text)` — SECURITY DEFINER; `auth.uid() = sessions.user_id` ownership check; server-computed active_seconds = `LEAST(now() - started_at - paused_seconds_total, tier_limit)`; user self-close path for zombies (R2-C3)
   - `session_rollover(p_old_session_id uuid, p_creator_id uuid, p_hook_id uuid, p_model voice_model) RETURNS TABLE(new_session_id uuid, tier profile_tier)` (R2-C1, R3-M1, R4-M2)
     SECURITY DEFINER; atomic close-old + open-new in ONE transaction.
     **Body ordering is load-bearing** (R3-M1 — `sessions_one_active_per_user` partial-unique is non-deferrable):
       1. Ownership assert on old (`auth.uid() = old.user_id`)
       2. Capture `v_inherit_tier := old.tier_at_session` (R4-M2 — tier must follow the conversation, not the current `profiles.tier`, to prevent cross-tier leak if admin force-closed + flipped between old close and new insert)
       3. `UPDATE sessions SET ended_at = now(), status='ended', end_reason='gemini_15min_cap' WHERE id = p_old_session_id`  -- old row exits partial-unique predicate FIRST
       4. `INSERT INTO sessions (...) VALUES (..., tier_at_session = v_inherit_tier, metadata = jsonb_build_object('prev_session_id', p_old_session_id, 'rollover', true), ...)`  -- safe: no partial-unique conflict
       5. The `sessions_enforce_tier_and_kill_switch` trigger (0017) must detect `NEW.metadata->>'rollover' = 'true'` and SKIP the `NEW.tier_at_session := p_tier` snapshot + SKIP the daily_quotas upsert (quota already counted against the old row's active_seconds path at close; re-upserting mid-day with a possibly-flipped tier would back-door the downgrade-block). Trigger patch is part of migration 2.
     Swap the ordering and you get `23505 unique_violation`. Skip the rollover branch in the trigger and you get tier-drift + quota double-bump. Both added to DON'T list.
   - `session_heartbeat(p_session_id uuid)` — liveness-only; rate-limited >=10s since `last_heartbeat_at`; ownership asserted; **distinguishes dead vs rate-limited via RETURN status enum**: `'ok' | 'rate_limited' | 'not_found_or_dead'` (R3-M3 — route layer maps: ok→200 with ts, rate_limited→204, not_found_or_dead→410 Gone so client stops polling)
   - `session_pause(p_session_id uuid)` — opens `session_pauses` row; partial-unique index prevents double-open. On duplicate-open: soft no-op, returns current paused_seconds_total (R3-M6).
   - `session_resume(p_session_id uuid)` — closes the open pause row; adds delta to `paused_seconds_total`. If no open pause row exists: soft no-op, returns current paused_seconds_total (R3-M6).
   - `session_set_avatar_status(p_session_id uuid, p_status text)` — ownership-asserted (auth.uid()); enforces transition table: pending→{minted, skipped_tier, failed_mint, not_applicable}, minted→failed_connect (R2-M3, R3-S7)
   - Custom PG errcodes (R3-S10): `P0001` = generic, `P0003` = `downgrade_blocked_until_tomorrow`, `P0004` = `has_active_session`, `P0005` = `already_active`, `P0006` = `not_found_or_dead`. Route layer maps errcodes to HTTP codes and typed error envelopes.
   - Grants: REVOKE ALL FROM public, GRANT EXECUTE TO authenticated on all

3. **`20260502000003_cogs_insert_avatar_turn.sql`** (R2-M1, R3-C4)
   - `cogs_insert_avatar_turn(p_session_id uuid, p_provider cogs_service, p_duration_s numeric, p_cost_usd numeric, p_metadata jsonb) RETURNS void`
     SECURITY DEFINER; asserts `auth.uid() = sessions.user_id AND (ended_at IS NULL OR ended_at > now() - interval '60s')` — 60s grace window matching reaper timeout so final in-flight turn is NOT rejected after close (R3-C4). Bounds: `0 < duration_s <= 60`, `0 <= cost_usd <= duration_s / 60 * 0.50` (ceiling rate cap — migration 0042 style).
   - Existing `insertAvatarCogs` helper in `src/lib/avatar/cogs.ts` becomes a thin wrapper calling this RPC; `sessionId` required, no env-branching (R2-Small)
   - Test `tests/cogs-avatar-rpc.spec.ts` MUST assert both the happy path AND the grace-window case: a turn inserted 30s after ended_at=now() succeeds; a turn inserted 90s after ended_at=now() rejects.

4. **`20260502000004_admin_audit_and_tier_flip.sql`** (C3-R1, M4-R1, M5-R1, C2-R2, C3-R2, M2-R2, R3-C6, R3-S6, R3-S10)
   - `public.admin_audit_log(id uuid PK default gen_random_uuid(), admin_user_id uuid NOT NULL REFERENCES admin_roles(user_id), action text NOT NULL, target_kind text NOT NULL, target_id uuid, before jsonb CHECK (octet_length(before::text) <= 4096), after jsonb CHECK (octet_length(after::text) <= 4096), created_at timestamptz DEFAULT now())` — RLS enabled, zero policies
   - Indexes: `(created_at DESC)`, `(target_kind, target_id)`, `(admin_user_id, created_at DESC)` (R3-S6 — per-admin audit queries from admin UI)
   - `admin_set_profile_tier(p_target_user_id uuid, p_new_tier profile_tier) RETURNS void` (C2-R2: no DELETE of daily_quotas; block mid-day downgrades entirely for v1)
     SECURITY DEFINER; in one tx:
       a. Assert caller `auth.uid()` is in `admin_roles` with `revoked_at IS NULL`
       b. Lock target's profiles row `FOR UPDATE`
       c. Raise `'has_active_session'` (errcode P0004) if a session with `ended_at IS NULL` exists for target
       d. Compute **user-local** today via `v_qdate := (now() AT TIME ZONE (SELECT timezone FROM profiles WHERE id = p_target_user_id))::date` (R3-C6 — matches migration 0017:62 / 0042:41 formula; `profiles.timezone` is `NOT NULL DEFAULT 'UTC'` per 0005:15, so no COALESCE needed — R4-S1)
       e. Raise `'downgrade_blocked_until_tomorrow'` (errcode P0003, R3-S10) if new_tier rank < old_tier rank AND `daily_quotas` row for `(p_target_user_id, v_qdate)` exists with `seconds_used > 0`
       f. UPDATE `profiles.tier`
       g. UPDATE `(p_target_user_id, v_qdate)` daily_quotas row if exists: `tier_snapshot=new_tier, daily_limit_s=new_limit`; re-check latch
       h. INSERT `admin_audit_log` row (action='tier_flip', before/after with tier values)
   - `admin_force_close_session(p_session_id uuid, p_reason text) RETURNS void` (R2-C3: admin-only, separate from self-close)
     SECURITY DEFINER; admin_roles assert; writes `end_reason='admin_force_close: '||p_reason`; audit row

5. **`20260502000005_cogs_admin_rollup_mv.sql`** (M3-R1, M2-R2, R3-C5)
   - Materialized view `cogs_log_admin_rollup` keyed by `(bucket_ts = date_trunc('minute', created_at), service, environment)` with `sum(cost_usd)`, `count(*)`, `sum(units)`.
   - `CREATE UNIQUE INDEX cogs_log_admin_rollup_uq ON cogs_log_admin_rollup (bucket_ts, service, environment)` — **required for CONCURRENTLY refresh** (R3-C5).
   - `CREATE INDEX cogs_log_admin_rollup_bucket_idx ON cogs_log_admin_rollup (bucket_ts DESC)` — query ordering.
   - Initial populate: `REFRESH MATERIALIZED VIEW cogs_log_admin_rollup` (non-concurrent — concurrent requires at least one prior populated refresh).
   - `ALTER MATERIALIZED VIEW OWNER TO postgres; REVOKE ALL ON public.cogs_log_admin_rollup FROM PUBLIC, anon, authenticated;` (R2-M2: grants lockdown)
   - pg_cron job `cogs_rollup_refresh` every 60s runs `REFRESH MATERIALIZED VIEW CONCURRENTLY public.cogs_log_admin_rollup` (R3-C5: avoids ACCESS EXCLUSIVE lock on each refresh — admin reads no longer block). Idempotent unschedule guard (copy pattern from migration 20260425000003).

### Shared libs (before routes — R3-P0-4, P0-5)

- `src/lib/voice/mint-ephemeral.ts` — `mintEphemeral({ wireModel, callerUserId, sessionId, env }: { wireModel: string; callerUserId: string; sessionId: string | null; env: 'spike_a' | 'production' }) => Promise<{ token: string; expiresAt: string }>`. Contains ALLOWED_MODELS set, GoogleGenAI init with `apiVersion: 'v1alpha'`, 10s timeout race, unhandled-rejection swallow (matches existing route). **Writes the cogs_log audit row internally** (R4-M1 — single source of truth; Spike-A and production both get identical mint audit, `environment` tag from arg, `session_id` non-null in production, null in Spike-A). No auth guard inside — caller enforces.
- `src/lib/voice/model-map.ts` — `WIRE_TO_ENUM: Record<string, 'gemini_3_1_flash_live_preview' | 'gemini_live_2_5_flash_native_audio'>` + `ENUM_TO_WIRE` reverse. Single source of truth for the enum/wire boundary (R3-C3). Used by session/open route before RPC, by response envelope on egress. **Parity-tested against the Postgres `voice_model_wire_value()` function** via `tests/model-map-parity.spec.ts` (R4-M3): queries `information_schema` for every enum value, asserts `voice_model_wire_value(v) === ENUM_TO_WIRE[v]` AND round-trip. Prevents silent drift when the enum grows.
- `src/lib/avatar/mint-simli.ts` — `mintSimliSessionToken({ faceId, isTrinity, maxSessionLength, maxIdleTime }) => Promise<{ sessionToken: string; expiresAt: string }>`. Copy-inline from existing `/api/spike-b/session` mint logic. Used by session/open route AND the admin spike-b route (both through the same lib). No `SIMLI_API_KEY` leaks past this module.
- Existing `/api/voice/ephemeral-token` and `/api/spike-b/session` refactor: become thin wrappers that admin-guard, call the lib, write their own COGS row. Behavior unchanged for the Spike-A/B harness.

### Server routes (Node runtime; each: isSameOrigin + auth guard explicit)

4. `src/app/api/sessions/open/route.ts` — user auth (getCallerUserId), NOT admin; translates wire-form model → enum via WIRE_TO_ENUM (400 if not allowed); calls session_open RPC; **mints Simli FIRST** (R3-M2 — early return on FORCE_AVATAR_REQUIRED failure before Gemini mint); then mints Gemini via mintEphemeral lib; calls `session_set_avatar_status` on mint outcome; returns `avatar.session_token` in envelope
5. `src/app/api/sessions/close/route.ts` — user auth; self-close path for own zombie session (R2-C3)
6. `src/app/api/sessions/rollover/route.ts` — user auth; 15-min Gemini cap rollover (R2-C1)
7. `src/app/api/sessions/heartbeat/route.ts` — user auth; no delta input
8. `src/app/api/sessions/pause/route.ts` — user auth
9. `src/app/api/sessions/resume/route.ts` — user auth
10. `src/app/api/admin/cogs/route.ts` — admin auth; queries `cogs_log_admin_rollup` MV via service-role client; URL-driven filters; aggregated JSON
11. `src/app/api/admin/users/tier/route.ts` — admin auth; calls `admin_set_profile_tier` RPC
12. `src/app/api/admin/sessions/force-close/route.ts` — admin auth; calls `admin_force_close_session` RPC (separate from user self-close)

### Observability wrapper for PostHog (R2-Small, R3-S2)

- `src/lib/posthog-safe-capture.ts` — single `captureSafe(event, props)` helper that strips any key matching `/token|secret|key|bearer|ephemeral|auth|cred|password|jwt/i` before dispatch (R3-S2: widened regex catches `authorization`, `credential`, `password`, `jwt`). **File header comment (R4-S4)**: "Regex is intentionally loose. False positives (e.g. `monkey`, `keyboard`, `author`) drop analytics props — recoverable from Sentry breadcrumbs. False negatives leak credentials — NOT recoverable. Tightening this regex to fix a false-positive is a regression; add an allowlist exception instead."
- All session/admin client code goes through this; grep-based test enforces no raw `posthog.capture` outside the wrapper

### Client: avatar session

11. `src/app/s/[id]/page.tsx` — SSR loader (session, creator display, hook context)
12. `src/app/s/[id]/session-client.tsx` — UI shell + reconnect overlay
13. `src/app/s/[id]/use-session-pipe.ts` — state machine hook:
    - idle → opening → ready → speaking | listening | paused | reconnecting → closing → closed
    - Exposes PostHog events (no tokens — M-small)
14. `src/app/s/[id]/visibility.ts` — encapsulates visibilitychange logic + AudioContext resume + PC/WS health check

### Feed integration

15. `src/app/(feed)/hook-panel.tsx` — Ask button: POST `/api/sessions/open` → `router.push('/s/' + sessionId)`. Comment cites the CLAUDE.md carve-out verbatim: *"`window.location.href` after login/signup/role/tier change"* — session creation is none of those, so `router.push` is correct. (R3-S9 — no "hard rule exception" wording)

### Bridge polish

16. `src/lib/avatar/simli-bridge.ts` (R3-C2, R3-S1):
    - P0-1 resolved: NO `isTrinityAvatar` option — `replicaId` alone is sufficient (Trinity is server-side face attribute)
    - Add `preMintedSessionToken?: string` to `AvatarOpenOptions` — when present, bridge SKIPS the `fetch('/api/spike-b/session')` call and constructs `SimliClient` with the token directly (R3-C2). When absent, legacy Spike-B harness path is preserved unchanged.
    - Add `onLipsyncLatency?: (ms: number) => void` handler — measured t1→first-simli-frame
    - Error mapping clarification (R3-S1): when the pre-minted path is used, mint-side 4xx/5xx codes never reach the bridge. When fallback path is used (spike-b), distinguish 429 upstream kill-switch (new taxonomy code `'session_killed'`) from Simli's own 429 rate-limit (`'quota_exceeded'`). Add `'session_killed'` to `AVATAR_ERROR_CODES`. **Code comment above the mapping**: `'session_killed' is fallback-path-only — production uses preMintedSessionToken and mint 429s surface at /api/sessions/open, not here. Do NOT wire this code into the production error map.'` (R4-S2)
    - Same-file; no new module

17. `src/lib/avatar/cogs.ts` — `insertAvatarCogs` gains required `sessionId` in prod mode; keeps optional for Spike B; default is required (breaking for Spike B callers — update them)

### Admin console

18. `src/app/admin/layout.tsx` — nav: Content | Creators | Users | COGS | Tools
19. `src/app/admin/users/page.tsx` — server component list + search (email/handle/id)
20. `src/app/admin/users/[id]/page.tsx` (R3-M5) — detail + tier form + **live sessions panel**: SSR-fetch user's sessions with `ended_at IS NULL`; render each as a row with session_id, started_at, tier_at_session, elapsed, and a "Force close" button. Button POSTs to `/api/admin/sessions/force-close` then `window.location.href` back to detail. This is the UX surface for the `has_active_session` error — admin lands on detail, clicks Flip Tier, sees the error banner with "End the user's live session first ↓" pointing to the live sessions panel below.
21. `src/app/admin/users/[id]/actions.ts` — `setTierAction` calls `/api/admin/users/tier`; on success `window.location.href` back to detail (tier is a role-ish change → per hard rule)
22. `src/app/admin/creators/page.tsx` — brain status list
23. `src/app/admin/cogs/page.tsx` — dashboard shell
24. `src/app/admin/cogs/cogs-live.tsx` — polling client (30s interval, on-focus-only via visibilitychange; pause when tab hidden)

### Landing

25. `src/app/waitlist/page.tsx` — rewrite: hero, demo video (Mux loop), form, FAQ, creator CTA (server component; form is client)
26. `src/app/waitlist/faq.tsx` — static content
27. `src/app/waitlist/demo-loop.tsx` — Mux player, loop, muted-by-default. **Bandwidth guardrail (R4-S3)**: cap the player at 720p via Mux signed playback URL params (`max_resolution=720p`) + `loop`+`muted`+`playsInline`. Rationale: Mux COGS rollup is deferred to 2026-05-10; a YC-window traffic surge against `/` → `/waitlist` could compound bandwidth faster than accounting. Alternative (lighter): serve a ≤2MB MP4 from `/public/` — revisit if Mux Data shows >X views/day at launch.

### Tests

30. `tests/session-open.spec.ts` — caller identity (can't pass foreign user_id), kill-switch gate, avatar-mint-failure voice-only path, avatar-status seeded 'pending' then transitions, one-active-per-user collision, FORCE_AVATAR_REQUIRED path. **Explicit R4-C2 case (R4-S5)**: simulate Simli mint failure under `FORCE_AVATAR_REQUIRED=1`, assert (a) 503 returned, (b) session row has `ended_at IS NOT NULL`, `end_reason='force_required_mint_failed'`, (c) an immediate retry succeeds — NO `already_active` error.
31. `tests/session-close.spec.ts` — server-computed active_seconds correctness with pauses, cannot close another user's session, self-close of zombie works
32. `tests/session-rollover.spec.ts` (R2-C1, R4-C1, R4-M2) — atomic close-old+open-new; exactly 2 sessions rows + 2 COGS streams after mid-session rollover; `new.metadata->>'prev_session_id' = old_id`; `new.metadata->>'rollover' = 'true'`; **tier inheritance case (R4-M2)**: flip `profiles.tier` between UPDATE (step 3) and INSERT (step 4) via an admin simulation; assert `new.tier_at_session = old.tier_at_session`, NOT the new profile tier; assert `daily_quotas.daily_limit_s` unchanged from pre-rollover value.
33. `tests/session-heartbeat.spec.ts` — rate limit floor, ownership, no seconds accrual
34. `tests/session-background.spec.ts` — pause/resume increments paused_seconds_total; partial-unique index prevents double-pause
35. `tests/admin-tier-flip.spec.ts` — non-admin rejected, invalid tier, has_active_session rejection, downgrade_blocked_until_tomorrow path (R2-C2), upgrade path with preserved seconds_used, audit row written
36. `tests/admin-force-close.spec.ts` (R2-C3) — non-admin rejected; admin closes; audit written with reason
37. `tests/cogs-avatar-rpc.spec.ts` (R2-M1) — ownership assert; duration bounds; cost ceiling cap
38. `tests/cogs-rollup-grants.spec.ts` (R2-M2, R3-S3) — authenticated role SELECT on `cogs_log_admin_rollup` must **throw `permission_denied` (42501)**, not return 0 rows (R3-S3: a badly REVOKED MV can return 0 rows under RLS-on-underlying-tables while technically still granted — only the error assertion rules out that false positive); admin route via service-role works
39. ~~`tests/simli-bridge-trinity.spec.ts`~~ — DROPPED (P0-1: no flag; Trinity is server-side)
40. `tests/barge-in.spec.ts` (R2-M4) — Gemini.onInterrupted → SimliBridge.cancel called exactly once; bridge.close NOT called; PC remains connected
41. `tests/posthog-safe-capture.spec.ts` — wrapper strips token-like keys; no raw `posthog.capture` call outside the wrapper (AST check on captureSafe usage)
42. `tests/admin-audit-log-caps.spec.ts` — before/after jsonb size cap rejects >4096 bytes
43. `tests/model-map-parity.spec.ts` (R4-M3) — for every value in `voice_model` enum via `information_schema`, assert `voice_model_wire_value(v)` (Postgres) matches `ENUM_TO_WIRE[v]` (TS) AND round-trip via `WIRE_TO_ENUM[wire]` equals original enum value

Manual: iPhone 11 PWA real-device checklist (see §Manual smoke checklist below).

### Observability

- PostHog events (scrubbed): `session_open`, `session_ready`, `barge_in`, `session_background_pause`, `session_background_resume`, `session_reconnect`, `session_close` (with end_reason), `admin_tier_flipped`
- Sentry tags on AvatarError: `provider`, `code`, `recoverable`, `session_id`, `tier`
- Sentry alert rule: `session_reconnect` rate > 5% of `session_open` in 10-min window AND total `session_open` count >= 10 (minimum-volume floor, R2-Small). Caveat (R3-M7): at launch volume (<10 sessions/10-min for Days 1–3 post-launch), the floor suppresses ALL alerts regardless of rate. Manual mitigation: Vuk manually scans PostHog `session_close` + `session_reconnect` events once daily until floor is consistently crossed. Filed in DONE-WHEN list for post-launch ops.

---

## Order of implementation (TDD per step)

**Phase 0 (45 min)** — P0-1, P0-2, P0-3, P0-4, P0-5 above.

**Day 13 AM (4h)** — Libs + Migrations + server routes
1. Resolve untracked `SIMLI_SUPPORT_EMAIL.md` (commit or delete) — 1 min
2. Extract libs: `src/lib/voice/model-map.ts`, `src/lib/voice/mint-ephemeral.ts`, `src/lib/avatar/mint-simli.ts` — and refactor `/api/voice/ephemeral-token` + `/api/spike-b/session` to call the libs (R3-P0-4/P0-5). Tests: existing spike-a/b harnesses still pass.
3. Migration 1: **`metadata` jsonb** (R4-C1), avatar_status ('pending' default, transition table), paused_seconds_total, session_pauses + partial-unique index, active_seconds CHECK, reaper extension (mint_never_completed vs ghost_reaper)
4. Migration 2: session_open/close/rollover/heartbeat/pause/resume/set_avatar_status RPCs + **`sessions_enforce_tier_and_kill_switch` trigger patch** to detect `NEW.metadata->>'rollover' = 'true'` and skip tier-snapshot + quota-upsert (R4-M2) — tests FIRST (caller identity via auth.uid(); atomic rollover with UPDATE-then-INSERT order + tier inheritance; heartbeat tri-state return; pause/resume idempotency; custom errcodes)
5. Migration 3: cogs_insert_avatar_turn RPC with 60s grace window + bounds
6. Routes: /api/sessions/{open,close,rollover,heartbeat,pause,resume} — each: same-origin copy-inline + getCallerUserId + zod parse + typed error envelope (errcode → HTTP map). `/api/sessions/open` specifically: wire→enum translation BEFORE RPC; Simli mint BEFORE Gemini mint; FORCE_AVATAR_REQUIRED early-return.

**Day 13 PM (4h)** — Client pipe + hardening
5. `use-session-pipe.ts` state machine + unit tests (state transitions are mockable — pure reducer pattern)
6. `session-client.tsx` UI (video panel, mic button, end button, reconnect overlay, cost ticker placeholder)
7. Pipe-stays-warm test: simulate Gemini interrupted → assert `bridge.cancel` called NOT `bridge.close`
8. Visibility hook + manual test on desktop Safari (approximates iOS)
9. 15-min cap close-and-reopen flow + test asserting exactly 2 sessions rows and 2 distinct COGS streams
10. Hook-panel Ask wiring + e2e happy path
11. iPhone 11 PWA real-device smoke (deferred to Day 14 PM red team)

**Day 14 AM (3h)** — Landing first (YC eyes), then admin start (R3-S5: landing is the visible surface, bump it up)
1. `/waitlist` rewrite + demo loop (full copy/design pass, ~2h)
2. Migration 4: admin_audit_log + admin_set_profile_tier (user-local today, block-downgrade-until-tomorrow, errcodes) + admin_force_close_session
3. Migration 5: cogs_log_admin_rollup MV with UNIQUE index + CONCURRENTLY refresh + REVOKE ALL + initial populate

**Day 14 PM (4h)** — Admin finish + red team
1. `/api/admin/cogs` + `/api/admin/users/tier` + `/api/admin/sessions/force-close` routes
2. `/admin/users` list + detail (tier form + live sessions panel with per-row Force close, R3-M5)
3. `/admin/creators` brain-status list
4. `/admin/cogs` dashboard + filters + drilldown (30s poll, on-focus-only)
5. Admin layout nav reorganized; nav tested not to leak links to non-admins (layout `notFound()` already covers)
6. Red team pass: VibeCoders §17 checklist + auditor's "don't do" list (expanded with R3 additions)
7. iPhone 11 PWA real-device full smoke (see checklist; includes S4 `GEMINI_SESSION_CAP_S=60` shortcut for 15-min rollover path)
8. Sentry + PostHog verified receiving events
9. Mux COGS rollup ticket filed with due-date
10. Tag `v1.0-rc1`, push to main

---

## Failure mode matrix (explicit)

| Failure | Response |
|---|---|
| Kill-switch latched | 429 at `/api/sessions/open`; user sees "Daily limit reached" |
| Gemini mint fails | Rollback RPC tx, 503 at route, user sees "Voice unavailable, try again" |
| Simli mint fails (prod, no FORCE_AVATAR_REQUIRED) | Session opens voice-only; `avatar_status='failed_mint'`; user sees "Avatar unavailable — voice only" banner |
| Simli mint fails (FORCE_AVATAR_REQUIRED=1) | Route calls `session_close(..., 'force_required_mint_failed')` FIRST, then 503. Retry is clean — no `already_active` false positive (R4-C2). |
| One-active-per-user collision | 409; user sees "You already have a session open" with a "Close it" button calling admin_force_close for own session |
| iOS background >30s, PC goes disconnected | Client surfaces "Tap to reconnect"; does NOT auto-reopen (avoids Gemini state confusion) |
| 15-min Gemini cap | Atomic `session_rollover` RPC; user sees "Reconnecting…" (~2s); `prev_session_id` linked in metadata |
| Gemini resumption / rollover fails | Session closed with `end_reason='gemini_rollover_failed'`; user sees "Session ended — tap to start again" |
| Heartbeat rate-limit hit (<10s) | Server returns 204 no-op; client keeps its own interval |
| Admin tier flip during live session | RPC raises `has_active_session` (P0004); detail page shows the live-sessions panel with per-row Force close buttons (R3-M5) |
| Heartbeat on dead session | RPC returns `'not_found_or_dead'`; route maps to 410 Gone; client stops polling + shows reconnect UI (R3-M3) |
| AudioContext suspended on iOS resume | 300ms post-resume() `state !== 'running'` check triggers "Tap to reconnect" overlay (R3-M4) |
| Admin tier downgrade mid-day with usage today | RPC raises `downgrade_blocked_until_tomorrow` (R2-C2); admin sees "Downgrade blocked — user has logged time today, wait until tomorrow UTC" |
| User has zombie session (page closed mid-call) | 409 on next open; UI "Close it" button calls `/api/sessions/close` (user self-close, not admin force) |
| Barge-in not firing | `tests/barge-in.spec.ts` asserts wiring; if Gemini 3.1 preview string changes interruption semantics, Sentry tag surfaces it (R2-M4) |

---

## Explicit DON'T list (auditor bait, enforced)

- Don't pass `p_user_id` to `session_open` RPC — use `auth.uid()` with SECURITY DEFINER assertion.
- Don't silent-fallback voice-only in demo envs — use `FORCE_AVATAR_REQUIRED=1`.
- Don't accept client-reported `delta_seconds` on heartbeat — liveness only.
- Don't do transparent Gemini resumption across 15-min cap — explicit close-and-reopen.
- Don't compute `active_seconds` client-side — server-side at close.
- Don't `router.push` after tier flip — `window.location.href` (hard rule).
- Don't spread `patch` in tier mutation — whitelist `{ tier }` only.
- Don't log tokens in PostHog — test enforces (test 34).
- Don't poll `cogs_log` raw in admin dashboard — materialized view via `/api/admin/cogs`.
- Don't flip tier with an active session — raise `has_active_session`, require force-close first.
- Don't let avatar COGS rows share `session_id=null` in prod — `insertAvatarCogs` requires it.
- Don't open a second Gemini WS on iOS resume — close zombie first.
- Don't update `profiles.tier` directly from admin client — route through `admin_set_profile_tier` RPC.
- Don't ship `docs/_planning/SIMLI_SUPPORT_EMAIL.md` untracked — commit or delete at start of Day 13 (not tag time).
- Don't DELETE `daily_quotas` rows in tier flip — preserve `seconds_used` for accounting integrity (R2-C2).
- Don't bundle user self-close into `admin_force_close_session` — two separate RPCs with two separate guards (R2-C3).
- Don't insert avatar COGS via service-role direct from route handler in prod — use `cogs_insert_avatar_turn` RPC (R2-M1).
- Don't grant `cogs_log_admin_rollup` to anon/authenticated — explicit REVOKE in the migration (R2-M2).
- Don't leave `sessions.avatar_status` NULL forever on route crash — reaper handles stale `pending` (R2-M3).
- Don't reuse `/api/voice/ephemeral-token` inside `/api/sessions/open` — that route is admin-gated for Spike-A. Use `mintEphemeral()` from `src/lib/voice/mint-ephemeral.ts` (R3-C1).
- Don't let `SimliBridge` call `/api/spike-b/session` on the production path — pass `preMintedSessionToken` from the session-open envelope (R3-C2).
- Don't pass hyphenated wire-form model strings to the `session_open` RPC — translate via `WIRE_TO_ENUM` first (R3-C3).
- Don't reject in-flight avatar COGS turns after `ended_at` is set — `cogs_insert_avatar_turn` must accept a 60s grace window (R3-C4).
- Don't `REFRESH MATERIALIZED VIEW cogs_log_admin_rollup` without `CONCURRENTLY` — ACCESS EXCLUSIVE lock blocks admin reads every 60s (R3-C5).
- Don't compute "today" for the downgrade-block in UTC or server-local — use `(now() AT TIME ZONE profiles.timezone)::date` to match the quota trigger (R3-C6).
- Don't INSERT-then-UPDATE in `session_rollover` — UPDATE old row's `ended_at` FIRST to clear the partial-unique predicate (R3-M1).
- Don't mint Gemini before Simli in `/api/sessions/open` — Simli first, early-return on `FORCE_AVATAR_REQUIRED` failure (R3-M2).
- Don't trust `audioCtx.resume()` on visibilitychange alone — verify `state === 'running'` 300ms later, else show "Tap to reconnect" (R3-M4).
- Don't return 503 from `/api/sessions/open` without first calling `session_close` on the inserted row — orphaned rows block retry via `sessions_one_active_per_user` until the reaper runs 60s later (R4-C2).
- Don't let `session_rollover` snapshot `tier_at_session` from `profiles.tier` — inherit from the old row. Trigger must detect `NEW.metadata->>'rollover' = 'true'` and skip the tier-snapshot + quota-upsert paths (R4-M2).
- Don't duplicate the Gemini token-mint COGS row in `/api/sessions/open` — `mintEphemeral()` writes it internally (R4-M1).
- Don't assume `public.sessions` has a `metadata` column — migration 1 ADDs it (R4-C1).
- Don't tighten `captureSafe`'s regex to fix false positives — false positives are recoverable via Sentry breadcrumbs, false negatives are not (R4-S4).

---

## Manual smoke checklist (iPhone 11 PWA, real-device)

Reproducible at 2am under deadline pressure:

1. Open PWA from home screen (not Safari tab)
2. Scroll to 3rd hook, tap "Ask"
3. Speak: "tell me about investing in your 20s" (or similar)
4. Observe: avatar appears in <5s, starts speaking; check lipsync roughly aligned
5. **(Pre-flight check first)** confirm `tests/barge-in.spec.ts` passed in CI this session. THEN: interrupt mid-sentence with "wait, actually…" → avatar stops within 500ms, new response starts. If it doesn't: `bridge.cancel` vs `Gemini.onInterrupted` vs Simli buffer flush — three subsystems to isolate (R2-M4).
6. Background for 10s (home button, check a notification) → return → assert session still live, mic still works
7. Background for 30s → return → check PC state; if surfaced "Tap to reconnect", tap and confirm recovery
8. Toggle Airplane Mode ON for 5s, OFF → observe reconnect UI (ICE fail expected; may take up to 15s per RFC 8445 retransmit defaults — R2-Small)
9. Lock screen for 30s → unlock → same
10. Continue to ~15-min mark → observe explicit reconnect UI at cap; session continues with new ID. **Dev-only shortcut** (R3-S4): set `NEXT_PUBLIC_GEMINI_SESSION_CAP_S=60` for a preview deploy and repro in 60s rather than 15 real minutes. This env var is read client-side ONLY; server-side cap remains authoritative at 900 via the `max_session_s` response field.
11. End session → check admin /cogs → see exactly one (or two if 15-min rollover) session row with correct tier, active_seconds, and paired avatar + voice COGS rows

---

## Resolved open questions (from Rev 1)

| Q | Resolution |
|---|---|
| Trinity replica? | P0-1 RESOLVED: no client flag. Trinity-1 is a server-side face attribute via Simli's face record. |
| SDK surface for Trinity flag? | P0-1 RESOLVED: no flag exists in `simli-client` v3. |
| Hook→Session UX? | Full-page `/s/[id]` navigate (PWA back button works; simpler state) |
| What counts as active_seconds? | Server-side at close: `LEAST(now() - started_at - paused_seconds_total, tier_limit_s)` |
| Landing `/` vs `/waitlist`? | Keep current: `/` redirects to `/waitlist` when `NEXT_PUBLIC_FEED_ENABLED != '1'` |

---

## Verification sources (web + repo)

- Simli `/compose/token` accepts `faceId, apiVersion, sessionAggregator, handleSilence, maxSessionLength, maxIdleTime, startFrame, audioInputFormat` (docs.simli.com)
- `is_trinity_avatar` is client-SDK-side per docs; exact TS signature TBD in P0-1 (docs.simli.com/api-reference/simli-client, videosdk.live Simli plugin)
- Gemini 3.1 Flash Live 15-min audio-only cap; session resumption reported flaky with long systemInstructions (Google AI forum) → we do close-and-reopen instead
- iOS PWA ~5s background execution budget + AudioContext suspended on hide (WebKit bug #231105, firt.dev 2025)
- Repo: migration 0017 (sessions), 0019 (daily_quotas 1.5× latch), 0020 (cogs_log RLS service-role-only), 0043 (cogs caller-guard pattern), 0421001 (one_active_per_user index + last_heartbeat_at column)

---

## Deferred (file tickets before Day 14 EOD)

- **Mux COGS nightly rollup** (M7) — blocker: not for v1 launch; required before post-launch scaling math. Ticket due 2026-05-10.
- **Goals/obstacles feed personalization** — v2.
- **Hooks publisher UI** (unblocks creator_topics delete trigger 0039) — v1.1.
- **Sentinel smoke test coverage for voice_quota breach without kill-switch latch** — v1.1.
