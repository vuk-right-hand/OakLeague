I'll audit the plan against the actual codebase, schema, and stated assumptions. Read done across the plan, existing migrations, and proxy code. Here's the full report.

Audit Report — DAYS_8_12_VOICE_PLAN REV 3
I verified claims against the shipped schema in supabase/migrations/, the proxy in server/voice-proxy/index.js, and server/voice-proxy/gemini-bridge.js. Below: issues that need resolution before code.

Critical (must fix before coding)
C1 — R2's idempotency index is unbuildable as written. cogs_log has no turn_number column.
REV 3 R2: "Idempotency via unique partial index (session_id, turn_number, service) on cogs_log". But supabase/migrations/20260420000020_cogs_log.sql defines cogs_log with columns {id, created_at, user_id, session_id, service, operation, units, unit_label, cost_usd, metadata} — no turn_number. Three knock-ons:

cogs_insert_turn (existing RPC, migration 0040 line 127) doesn't take a turn number either.
The existing cogs_log_block_update trigger (migration 0020 line 37) strictly allow-lists columns; adding turn_number without extending the trigger breaks FK-cascade SET NULL paths.
ON CONFLICT DO NOTHING on an index that targets a non-existent column silently becomes no-op. Idempotency is lost.
Fix: pick one before Phase 5 — (a) add turn_number int NULL column + extend trigger allow-list + make index partial WHERE turn_number IS NOT NULL; or (b) expression index ((metadata->>'turn_number'), session_id, service) and enforce turn_number in metadata at the RPC. Spell out which, and migrate existing cogs_insert_turn to take p_turn_number uuid too.

C2 — 20260427000008_session_turns_speaker.sql duplicates an existing column.
Plan adds a speaker user|assistant enum to session_turns. But 20260420000018_session_turns.sql line 12 already has role session_turn_role NOT NULL with enum ('user', 'assistant') (defined in 20260420000001_extensions_and_enums.sql line 16). Drop that migration and read role in the N-C2 rebuild path.

C3 — Resume-same-row has a concurrent-connection window. Two proxies can both "activate" the same sessions row.
REV 3 B1: resume path UPDATE existing row to set status='active'. The unique partial index sessions_one_active_per_user WHERE ended_at IS NULL (migration 0040 line 19) does NOT prevent this — if the prior WS died ungracefully and the 60s reaper hasn't run, the row still has ended_at IS NULL. A resume ticket consumed before reaping → UPDATE succeeds → two open bridges to Gemini Live share one sessions row. Double Gemini audio billing against one quota bucket; one-active-per-user invariant broken silently.

Fix: resume must be conditional on ended_at IS NOT NULL OR status IN ('ended','errored') with a distinct error (4009 resume_conflict) when the prior row is still live. Alternative: client MUST hit /api/voice/session/end via sendBeacon (N-C4) and the RSC route must wait for the row to flip to ended before minting the resume ticket — otherwise deny.

C4 — Transcript-replay leaks user text into systemInstruction + inflates per-turn prompt tokens.
REV 3 B1: "Returned transcripts are formatted into systemInstruction prefix at Gemini open time." Two problems:

systemInstruction is rebilled as prompt tokens on every turn of the resumed session. 8 turns × ~500 tokens = 4k replay tokens × (e.g.) 60 post-resume turns = 240k extra input tokens — and the kill-switch latch is seconds-based, not token-based, so this goes unmetered. Minimum: cap at 2 turns / 1.5k chars and write an explicit voice_resume_overhead_tokens leg to cogs_log on resume.
Plaintext user transcripts flow into an upstream system prompt. Verify Gemini's data-retention for systemInstruction content vs. contents[] input under your DPA — the native-resumption handle was opaque, this is not. Gate resume-with-context on an OKAY_TO_RESEND_TRANSCRIPT flag or use contents[] seeding via send_client_content (CLAUDE.md already notes that's the seed path).
C5 — /api/voice/session/end via sendBeacon: auth + content-type pitfalls unspecified.
REV 3 N-C4 proposes a JSON body over beacon. sendBeacon can't set credentials, sets Content-Type from Blob MIME only, and silently drops on cross-origin without CORS pre-match. Plan must specify: (a) Blob type application/json, (b) route tolerates missing auth (user may have logged out in the same tab) → in that case, no-op + 204, (c) idempotent — rapid iOS foreground/background flicker may fire 3-5 beacons before the SELECT returns, (d) route must NOT require same-origin header check since beacons often drop Origin on some browsers — use caller uid vs. sessions.user_id as the sole check.

Medium
M1 — Cartesia cancel records under/over-billed on abandoned contexts. Plan's C4 error path says "Cartesia fails mid-synthesis: … COGS records Gemini legs only." But characters streamed to Cartesia BEFORE the WS dropped are already billable. Add: always emit a Cartesia-characters row to cogs_log regardless of end state, with status=partial in metadata.

M2 — Postgres-global IP rate limit (N-C3) is write-heavy on one table. At YC-demo scale fine, at 120/min/IP × even modest NAT you'll see thousands of UPSERTs/min thrashing one hot row per IP. Wrap the RPC write in pg_advisory_lock(hashtext(ip)) or accept the in-proxy per-machine limit if Fly is pinned single-instance. Confirm fly.toml has a single machine before shipping. pg_cron cleanup interval not specified — pick 1m (sliding window is 60s).

M3 — Admin voice-clone upload: two-hop auth not spelled out. Plan has Next.js assertAdminFromSession() → token → Fly proxy consume. Missing: token store (reuse voice_tickets with purpose='voice_clone'?), TTL, single-use, same-origin CORS on Fly endpoint, pre-upload size gate (Fly buffers 10 MB if not streamed). Also: 20260427000003_voice_clone_uploads.sql should include index on (admin_user_id, created_at DESC) for the 3/day count query.

M4 — Reaper multi-proxy locking: plan says wrap caller; simpler to move into RPC. Proxy currently calls reap_stale_sessions with p_threshold_seconds: 90. Plan wants 60s + pg_try_advisory_lock. Spell out: either (a) modify the RPC body to take the lock and no-op on contention (recommended — single source of truth); or (b) require every caller to wrap, which creates drift. Also update the default in the RPC signature if 60s becomes the contract.

M5 — Heartbeat "aggregate pong → flush every 10s" requires a code path that doesn't exist yet. index.js:407 writes to sessions on every pong. Plan prose implies a batched write but doesn't spell out the change. Add a Phase 8 task: "Replace per-pong UPDATE with an in-memory Map<sessionId, lastPongAt>; 10s interval flushes dirty keys in one upsert."

M6 — Pro pipeline has no per-session USD ceiling. Pro is admin-gated in v1 but burn is wild: Gemini STT (audio discarded = ~$0.018/s out) + Gemini 2.5 LLM tokens + Cartesia chars + Cartesia audio. Seconds-based kill-switch doesn't protect against a feedback loop spewing 20k chars in 30s. Add a per-session USD latch (e.g., $3 for premium, $10 for boardroom) to the existing kill-switch trigger, not just seconds.

M7 — Admin-role revocation race. The RSC route gates Pro on admin_roles at mint time, proxy verifies tier_at_session == expected_tier post-insert (D7). But if admin role is revoked between mint and consume (or mid-session), admin tier stays premium → post-insert matches → Pro pipeline activates for a non-admin. Two options: (a) proxy also selects admin_roles post-insert and matches; (b) add admin_roles revocation trigger that nukes unconsumed voice_tickets WHERE pipeline_kind='pro' AND user_id = revoked_user.

M8 — 4-byte turn prefix on every audio frame is over-engineered. 100 prefixes/s per session is fine cost-wise but an easy source of bugs (first 2 PCM samples if the strip is forgotten). Simpler: proxy sends a single control JSON {type:'turn_boundary', turn:N} before the first audio frame of each turn; client tracks currentTurn. Same semantics, no framing ambiguity.

M9 — Mic-worklet AudioContext({sampleRate:16000}) honor not verified on iOS 17+. Plan asserts Voicer §4.1 covers it, but no runtime assertion shipped. Add: log ctx.sampleRate to PostHog on first open; surface if ≠ expected for >0.5% of iOS sessions.

M10 — Resume-ticket TTL enforcement is split across N-C1 and M-N7. M-N7 says "if prior session ended_at < now() - 2h, respond {expired: true}" — but this logic belongs in the RSC ticket mint, not in the proxy path. State it in the N-C1 body so the ownership check and TTL check are co-located.

M11 — Cartesia mid-synthesis WS drop: no reconnect budget. One automatic reopen attempt before surfacing tts_mid_turn_failure prevents single-flake turn deaths. Plan has zero retry; flaky WiFi will make this feel broken.

Small
S1 — Pre-warm before pointerUp can burn tickets on scroll-past. Phase 4 says pointerDown arms, pointerUp commits. If connect() opens the proxy WS (and thus consumes a ticket), abandoning after pointerDown burns one of the 2/min budget. Split: pointerDown = worklet modules only; pointerUp = mint + WS.

S2 — Bug #2238 link missing. REV 2 cites "upstream bug #2238" for Gemini 3.1 TEXT-only WS 1011. Add the googleapis/google-genai GitHub issue URL so re-auditors (and future you) can verify it's still open.

S3 — VOICE_PIPELINE_OVERRIDE_ADMIN_ONLY=0 is a foot-gun default. Positive-polarity flag safer: default VOICE_PRO_PIPELINE_PUBLIC=0, flip to 1 for public Pro launch.

S4 — tier-changed toast needs auto-retry affordance. R1 auto-re-mints once; surface a "Tap to continue" CTA if the re-mint also fails, not a dead-end error.

S5 — Admin mutation that flips tier should emit voice.tier_flip_during_active_session server-side, not rely on proxy to detect. Proxy can't observe a flip mid-session since tier_at_session is locked. Fire PostHog from the admin tier-flip route when target has sessions WHERE status IN ('starting','active').

S6 — No load test in Phase 9. Add: 50 concurrent 5-min sessions against prod proxy; assert p50 TTFA, memory stability, reaper doesn't false-positive.

S7 — No cross-user resume integration test. REV 3 N-C1 is a security fix; add an explicit test that crafts a ticket mint with another user's session_id and asserts 4001/401.

S8 — Upgrade @google/genai. 1.50.1 → latest minor at Phase 0. If sessionResumption types appear, B1 becomes tractable as documented natively instead of the transcript-replay detour.

S9 — Resume overhead accounting. If C4 stays (transcripts in systemInstruction), write a voice_resume_context_tokens row to cogs_log at bridge-open so the COGS viewer attributes the startup tax correctly.

**S10 — Voicer §5.2 worklet resample 24kHz→48kHz uses zero-stuff + FIR. Cheap, but TTFA budget (Phase 4) target p50<700ms includes this; state the measured cost on desktop Chrome vs. iOS Safari separately — Safari's AudioWorklet is slower on iPhone 11.

Data governance flag (non-blocking, but escalate)
G1 — Pro pipeline sends user audio to Google (STT) AND text to Google (2.5) AND synthesized audio bytes through Cartesia. Three-vendor data path per turn. If YC judges ask about data retention or you need a DPO sign-off, you'll want a written policy per vendor. Not a plan change; a Vuk checklist before Pro demo.

Recommended ordering of fixes
Before you write code: resolve C1, C2, C3, C4, C5 in plan text (migration content + state transitions). M3, M6, M7 are schema/security — settle in the migration prep step. Everything else can be resolved during the respective phase, but pin decisions now to avoid re-planning during Phase 5.

Answer to your open questions
Free-tier voice (Puck vs audition 30-voice set): ship Puck for v1. Per-creator voice is a post-YC polish — you can ship a fresh demo voice in one migration the day YC asks.
STT audio-billing waste (~$0.15/min): accept for v1. Pro is admin-demo-only. Fix post-YC.
Cartesia per-char USD: blocker for accurate Pro-path COGS. If Vuk's dashboard doesn't show it clearly, file the support ticket now — 1-week turnaround is tight.
Voice-clone admin UI timing: backend Phase 5, UI Day 13-14 is the right split, but include M3's two-hop auth contract in the Phase 5 backend work or the Day 13-14 UI will get blocked.
Phase 0 (~1h) before Day 8: yes — and add the @google/genai upgrade (S8) to it. If sessionResumption types appear, you collapse C4 + B1 to near-zero cost.