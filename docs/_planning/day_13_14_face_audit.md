Read through the plan, the existing migrations (0017 sessions, 0019 daily_quotas, 0020 cogs_log, 0040/0041/0042/0043 voice/caller-guards), the current SimliBridge, insertAvatarCogs, resolver, /api/voice/ephemeral-token, /api/spike-b/session, hook-panel.tsx, and the enums (voice_model, profile_tier, session_status, cogs_service). Here's the audit — grouped by severity, sourced to code/migration.

CRITICAL — block the plan until resolved
C1. /api/voice/ephemeral-token is admin-gated, plan says to reuse it for end users
src/app/api/voice/ephemeral-token/route.ts:49 calls assertAdminFromSession(). Plan line 92 says "Gemini ephemeral token mint (reuse existing /api/voice/ephemeral-token logic)" inside /api/sessions/open. A free-tier user hitting Ask will get 403 Forbidden from the reused path.

Fix: Two options (pick one in Phase 0):

Extract the mint into src/lib/voice/mint-ephemeral.ts and call it from /api/sessions/open after getCallerUserId() (NOT admin).
Or rewrite /api/voice/ephemeral-token to take a caller-identity dependency; legacy admin-only clients pass through admin guard in a wrapper.
The plan has no note that the existing route cannot be reused as-is.

C2. SimliBridge.open() hardcodes /api/spike-b/session — plan ships with that call path unchanged
src/lib/avatar/simli-bridge.ts:103 literally fetches /api/spike-b/session, which is admin-gated. The plan adds a new production mint inside /api/sessions/open but the bridge will still call the spike endpoint and 403 for non-admin users.

Fix: Plan §Bridge polish (line 221–225) lists only isTrinityAvatar + onLipsyncLatency. Add a required sessionTokenEndpoint or (better) pass the pre-minted session_token down from /api/sessions/open and skip the in-bridge fetch entirely. The latter matches the Tavus pattern and the plan's own sequence diagram step 2 ("Response: { …, avatar: {...} | null }").

C3. voice_model enum variant vs. wire string — RPC signature mismatch
Migration 0034 defines the enum values as underscored: gemini_3_1_flash_live_preview, gemini_live_2_5_flash_native_audio. The GenAI SDK and the existing /api/voice/ephemeral-token accept the hyphenated wire form (gemini-3.1-flash-live-preview). Plan's session_open(p_model voice_model) signature only accepts enum variants.

Fix: Either

Route handler translates request body {model: 'gemini-3.1-flash-live-preview'} → enum via voice_model_wire_value() reverse lookup before calling the RPC, OR
Client passes the enum name directly (ugly + couples client to DB schema).
Option A is right, but the plan doesn't specify the conversion step — and /api/sessions/open will silently fail with invalid input value for enum voice_model until someone adds it.

C4. cogs_insert_avatar_turn assertion ended_at IS NULL will drop end-of-session cost rows
Plan line 165: asserts auth.uid() = sessions.user_id AND ended_at IS NULL. Avatar COGS rows are written per-turn. Real race at session close: the final Simli lipsync chunk round-trip lands after session_close sets ended_at. The RPC rejects, the cost goes unbilled, the kill-switch under-accounts. Daily_quotas drift downward — exactly the v1-launch silent cost-leak the plan is trying to prevent.

Also: reaper-closed zombie sessions (line 149) will reject any final in-flight turn.

Fix: Accept the turn if ended_at IS NULL OR ended_at > now() - interval '60s' (grace window matches reaper timeout). Add a test for this.

C5. Materialized view refresh without CONCURRENTLY — admin dashboard will block every 60s
Plan line 186: cogs_log_admin_rollup has index on (bucket_ts DESC) only. pg_cron refreshes every 60s. Without REFRESH MATERIALIZED VIEW CONCURRENTLY, each refresh takes an ACCESS EXCLUSIVE lock on the MV — any admin read in that window blocks. CONCURRENTLY requires a UNIQUE index on the MV. Plan doesn't have one.

Fix: Add CREATE UNIQUE INDEX cogs_log_admin_rollup_uq ON cogs_log_admin_rollup (bucket_ts, service, environment) and write the pg_cron job as REFRESH MATERIALIZED VIEW CONCURRENTLY cogs_log_admin_rollup. Note: CONCURRENTLY cannot be used on the initial refresh — the migration must do one non-concurrent refresh before handing off to cron.

C6. admin_set_profile_tier downgrade-block uses ambiguous "today"
Plan line 176: "today's daily_quotas exists with seconds_used > 0". Existing triggers (0017, 0042) key quota_date on user-local date via (now() AT TIME ZONE profiles.timezone)::date. If the admin function uses UTC "today" or server-local, it will mis-gate around the user's midnight boundary (block when it shouldn't, allow when it shouldn't — a user in Sydney at 23:45 local gets flipped, their seconds_used stays on yesterday's row, admin sees today's row empty, downgrade proceeds mid-use).

Fix: Use the same formula: v_qdate := (now() AT TIME ZONE (SELECT timezone FROM profiles WHERE id = p_target_user_id))::date. Reference migration 0017:62, 0042:41.

MEDIUM — fix before implementation or accept & document
M1. session_rollover atomicity — ordering not specified
Plan says "atomic close-old + open-new in ONE transaction". The sessions_one_active_per_user partial unique index is NOT deferrable (migration 0040:19 — created as plain CREATE UNIQUE INDEX). Inside one tx, PG checks partial-unique on each INSERT row immediately, not at commit. If the RPC INSERTs new-row before UPDATEing old-row's ended_at, it fails with 23505 — exactly the bug the rollover was designed to avoid.

Fix: Explicitly require the RPC body order: UPDATE sessions SET ended_at = now()... WHERE id = p_old; then INSERT INTO sessions.... Add to the DON'T list.

M2. Gemini mint runs before Simli mint — wasted cost on FORCE_AVATAR_REQUIRED=1 failures
Plan sequence (lines 85–92) mints Simli first then Gemini, but the files+routes list isn't explicit about ordering. If Gemini mints first and Simli fails under FORCE_AVATAR_REQUIRED=1, the Gemini token was burned for nothing. Low dollars but it also consumes Gemini rate-limit and leaves orphaned COGS rows.

Fix: Explicit order in the route spec: session_open RPC → resolveAvatarProvider → mint avatar → if FORCE_AVATAR_REQUIRED and mint failed, early return before Gemini mint.

M3. Heartbeat response contract for dead sessions undefined
Plan line 105: heartbeat asserts ended_at IS NULL. What status does the server return when the session was reaped (common after 90s background)? Client needs to distinguish "rate-limited, keep going" (204) from "session dead, stop polling and show reconnect UI" (404/409). Not specified. Without this, client hammers dead sessions at 20s until close.

Fix: Define the response envelope: 204 on rate-limit, 410 Gone on dead session, 401 on auth fail. Client state machine acts on 410 by transitioning to closed.

M4. AudioContext .resume() on iOS PWA often needs a user gesture
Plan line 110: audioCtx.resume() on visibilitychange=visible. WebKit has historically required a direct user gesture (tap) to resume a suspended AudioContext — a visibilitychange event is not a gesture. The smoke checklist step 6 ("return → assert session still live, mic still works") will pass on desktop Safari (approximation, line 287) but likely fail on the actual iPhone 11.

Fix: Plan the fallback now: if audioCtx.state !== 'running' after resume attempt, show the "Tap to reconnect" overlay (same as the ICE-fail path). Don't pretend the auto-resume is guaranteed.

M5. admin_force_close_session needs admin UI surface
Plan adds the RPC but the admin users detail page (line 232) only mentions "tier form". When tier-flip fails with has_active_session, the admin sees a message (line 322) saying "click force-close". What button? Where? The UI piece isn't in the files list.

Fix: Add to /admin/users/[id]/page.tsx: a list of the user's open sessions (ended_at IS NULL) with a per-row "Force close" button wired to /api/admin/sessions/force-close. Same server-action + window.location.href pattern.

M6. session_pause / session_resume edge cases
Double-resume (no open pause row): RPC should be idempotent no-op or return a clear error code — plan doesn't say. Client state machine can get into this via double-visibilitychange (known Chrome quirk on tab switches).
Resume without prior pause: same, undefined.
Fix: Spec both as soft no-ops returning the current paused_seconds_total. Add tests.

M7. Sentry alert floor logic
Plan line 262: "rate > 5% of session_open in 10-min window AND total session_open >= 10". Good floor, but what happens during normal day 1 traffic (6 sessions total)? No alerts fire even if 100% of them reconnect. Document that Day 1–3 post-launch will be manually monitored via PostHog until the alert floor is crossed.

SMALL — nits / polish / flag-and-move-on
S1. SimliBridge.open() error surface leaks quota_exceeded taxonomy for 429 (line 112 of simli-bridge.ts) — production mint route will rate-limit for different reasons (kill-switch, Simli-side cap); client shouldn't show "quota exceeded" for kill-switch. Separate code or clarify copy.
S2. PostHog captureSafe regex is too narrow: /token|secret|key|bearer|ephemeral/i misses api_key (matches via key, OK), authorization, credential, password, jwt. Widen to /token|secret|key|bearer|ephemeral|auth|cred|password|jwt/i.
S3. Test tests/cogs-rollup-grants.spec.ts must assert permission_denied (error), not "0 rows". A badly REVOKED MV returns 0 rows under RLS but still technically-granted — false positive.
S4. Smoke checklist step 10 demands manually waiting 15 real minutes. Add a dev-only GEMINI_SESSION_CAP_S env override (defaults to 900) so the rollover path is testable in 60 seconds.
S5. /waitlist time budget: Day 14 PM is 3h covering landing rewrite + red-team + device smoke + obs verify + Mux ticket + git tag. That's <1h for landing copy/design — YC will read this. Either move landing to Day 14 AM slot (trim admin) or acknowledge it's a minimum-viable rewrite.
S6. admin_audit_log FK on admin_roles(user_id) — admin_roles has a block_delete trigger (0025:26), so revocation is soft. Fine, but add an index on (admin_user_id, created_at DESC) for per-admin audit queries from the UI.
S7. session_set_avatar_status transition check: plan says "only allows transitions from 'pending' → terminal". No path from 'minted' → 'failed_connect' for post-mint WS drop. If the UX wants to differentiate mint success vs. connect success, add 'minted' → 'failed_connect' as a legal transition.
S8. Reaper update in migration 1 claims "extend existing reap_stale_sessions". That function's signature is RETURNS TABLE (session_id, user_id, age_seconds) (0040:100). Updating both ended_at and avatar_status in one statement is fine, but the SET end_reason = 'ghost_reaper' vs. plan's 'failed_mint' are different states — the reaper needs to route: if avatar_status was 'pending' on a session that never produced any heartbeat traffic, end_reason should be mint_never_completed, not ghost_reaper. Otherwise ops can't tell them apart in COGS forensics.
S9. Hook-panel wiring (plan line 217): router.push('/s/' + sessionId) comment says "flag in comment" — but the hard rule in CLAUDE.md is window.location.href for role/tier changes, not session-creation. Plan gets the rule right; the in-file comment should cite the exact carve-out rather than "hard rule exception" (confusing phrasing).
S10. daily_quotas downgrade-block error code — plan raises 'downgrade_blocked_until_tomorrow' but doesn't specify PG errcode. Use a non-P0001 code (say P0003) so the route layer can distinguish it from the existing kill-switch raise.
Phase 0 additions (before Day 13 AM)
Add one more blocker:

P0-4. Confirm /api/voice/ephemeral-token refactor path — decide now whether to (a) extract mintEphemeralToken(model) lib + new public route, or (b) parameterize the guard. Option (a) is the production-from-line-one answer; option (b) is cheaper but leaves the admin-only route load-bearing. Output: one-line decision appended to the plan.

Summary
The plan is substantively sound on data-integrity and RLS (auth.uid() + SECURITY DEFINER pattern, atomic rollover, active_seconds server-side, MV with explicit REVOKE, audit log). The two audit rounds caught the big accounting/race holes.

What the audits missed are the integration seams: the ephemeral-token endpoint being admin-only (C1), SimliBridge still pointing at /api/spike-b/session (C2), the voice_model wire-format mismatch (C3), the ended_at-rejects-in-flight-cost race (C4), the MV lock without CONCURRENTLY (C5), and user-local today in the tier-flip gate (C6). All six are fixable in Phase 0 or the first migration pass — but shipping without them either breaks the happy path for non-admin users (C1, C2, C3) or silently corrupts accounting (C4, C5, C6).

I'd run one more mini-audit round after folding these, focused only on C1–C6 + M1/M4, before gate-opening the code.