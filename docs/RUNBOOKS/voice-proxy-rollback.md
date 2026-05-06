# Voice-Proxy Cutover Rollback Runbook

**SIMLI_WIREUP §7 / R3-M6.** Procedure for rolling back the
`NEXT_PUBLIC_VOICE_PROXY_PATH=1` cutover when something regresses post-flip.

**Audience:** anyone with Vercel + Fly access.

---

## When to execute

Roll back when ANY of these are true within 30min of flag-on:

- `simli_lipsync_latency_ms` p95 jumps > 1500ms (Sentry alert configured
  in `sentry/alerts/lipsync.json`).
- `user_perceived_response_ms` p95 jumps > 2500ms.
- Sustained >5% rate of `proxy_*` Sentry events.
- Reports of avatar lipsync looking "off" / "out of sync."
- `simli_video_paused_with_track` PostHog event fires for >2% of sessions
  on iOS PWA (R4-YC-Day demo-day failure mode).

Do NOT roll back for:

- A single one-off Sentry event (transient network).
- `cartesia_reconnecting` events at ≤1% — that's normal upstream blips.
- Lipsync >1200ms alerts in absence of user reports — verify against user
  signal before flipping.

---

## Execution sequence (NOT just "flip env + redeploy")

The naive flip would leave a 90s split-brain window where existing tabs'
proxy WSs still run against potentially-rotated infrastructure. Follow
this order exactly:

1. **Vercel: flip the env var.** Settings → Environment Variables →
   `NEXT_PUBLIC_VOICE_PROXY_PATH` → set to `0` (or delete).
2. **Trigger a Vercel redeploy.** Production deploy. Takes ~90s build
   + propagation. New page loads from this point use the legacy
   direct-Gemini path. Existing tabs keep their proxy WS until close.
3. **Do NOT redeploy the Fly proxy during rollback.** Existing
   proxy-WS sessions naturally end at:
   - User-tap-close (most common, <60s).
   - Gemini's 15-min audio cap (rollover triggers naturally on the
     legacy path).
   - Reaper at 60s post-heartbeat.

   Redeploying Fly during rollback would force-drop in-flight sessions
   hard, doubling user-visible failures during the bad window.
4. **Monitor for 30min post-flip.** Watch:
   - Sentry: new errors should drop to baseline.
   - PostHog dashboards: `simli_lipsync_latency_ms`, `user_perceived_response_ms`.
   - Don't expect proxy traffic to drop to zero immediately — old WSs
     are still draining.
5. **Verify rollback completed:** wait for old proxy-WS sessions to
   drain (check `wsRegistry` size in proxy logs; should approach zero
   within 20 minutes since Gemini cap is 15min + reaper grace).

---

## What rollback does NOT undo

- The schema migrations (`voice_tickets.session_id`,
  `creators.voice_id_preview`, `creators.voice_id_dev`,
  `simli_face_delete_queue`). All are additive / nullable; legacy
  path ignores them.
- The proxy's attach-not-insert path (proxy still falls back to the
  legacy `openSession` insert when the ticket has `session_id IS NULL`,
  which is what admin spike-a tickets always do).
- The bridge chunker (R3-C1). Active even on flag-off path; harmless
  because the legacy path's audio cadence is also accepted by the
  6000-byte ring.

---

## When to roll FORWARD instead

If the failure is in cookie/session/ticket layer (e.g., 4001
`invalid_ticket` epidemic), don't roll back the flag — it would still
crash the session-open envelope. Instead:

- Check `voice_tickets` table for stuck rows.
- Verify VERCEL → Fly clock skew (UA-hash vs `expires_at`).
- File a hotfix forward.

---

## After-action

Once stable for 24h on the flag-off path, file a bug describing what
went wrong and re-attempt cutover. Do NOT leave the flag-off path live
indefinitely — it ships Gemini stock voice into Simli (Sev-0 violation
of "cloned voice everywhere"). Cutover MUST land before the stock-voice
violation becomes user-visible at scale.
