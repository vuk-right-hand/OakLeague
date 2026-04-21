Not 11/10 yet. 6 Criticals before you pick up the phone.

Criticals (fix first)
C1 — CSRF check 403s every Vercel preview URL (ephemeral-token/route.ts:28-39)
expectedOrigin() is a single static string from NEXT_PUBLIC_SITE_URL. Preview deploys (oakleague-git-*.vercel.app) never match → every token mint and record call 403s. Fix: also allow process.env.VERCEL_URL, or switch to checking req.headers.get('host') === new URL(req.url).host (real same-origin check).

C2 — GoogleGenAI client constructed before guard + sync throw leaks API key (route.ts:63-77)
If authTokens.create() throws synchronously (bad config, SDK bug), the throw escapes Promise.race unhandled. Stack trace may include the config object — and the key. Wrap the entire create call in try/catch.

C3 — Dangling promise after mint timeout → unhandled rejection → Sentry spam (route.ts:80-88)
When timeout wins the race, mintPromise keeps running, eventually rejects, and becomes an unhandled rejection. Add .catch(() => {}) to the losing promise leg.

C4 — ws.bufferedAmount probe is silently dead (spike-client.tsx:344-346)
(session as unknown as { conn?: { bufferedAmount?: number } }).conn always returns undefined. bufferedAtT4 is always 0, SUSPECT threshold never fires. Inspect the actual runtime Session shape in preflight to find the real property, or drop the metric and document it as missing.

C5 — First-chunk race: t4 recorded after activityEnd send → TTFA wrong or turn times out (spike-client.tsx:348-356)
t4Recorded = true is set after sendRealtimeInput({activityEnd}) returns. If the first audio frame arrives in that microtask gap, onMessage sees t4Recorded=false, drops the resolver, and the turn hits the 15s timeout (recorded as TIMEOUT). Fix: set activityEndAtMs = performance.now(); t4Recorded = true; before calling sendRealtimeInput.

C6 — cogs_log.user_id FKs to profiles(id); if admin's profile row is missing, COGS insert 500s silently (record/route.ts:95)
Route swallows the error (.catch(() => {})), timing data saves fine, but COGS log is empty. Add a SELECT 1 FROM profiles WHERE id = $userId check in the /api/me preflight and fail loudly.

Mediums (worth fixing, won't kill the day)
M4 — turnComplete busy-wait defaults to 10s cap if Gemini 3.1 preview stops emitting it on audio-only turns. 5 turns × 3 sessions × 10s = 150s extra per cell. Reduce to 2-3s.
M5 — String.fromCharCode(...32768-arg spread) is on the edge of iOS Safari's stack limit. Use a for loop instead.
M7 — Output COGS always recorded as 0 — audio byte count is computed on line 230 then immediately discarded. Sum it, divide by 32000, pass real seconds to recordCogs.
Smalls worth noting
S3 — Sentry regex doesn't cover #access_token=... URL fragments (Supabase magic-link pattern).
S5 — sentry.server.config.ts is missing the access_token scrubber that client has.
S6 — PostHog has no before_send scrubber at all; /invite/<token> pageviews log verbatim.
Most important three before picking up the phone: C1 (preview URL CSRF — blocks all device testing), C5 (t4 race — corrupts primary metric on fast responses), C4 (bufferedAmount is a no-op — silent dead metric).