# Voice-Proxy Rollback Runbook

**Audience:** anyone with Vercel + Fly access.

The `NEXT_PUBLIC_VOICE_PROXY_PATH=1` cutover flag is **retired** as of the
use-session-pipe rewire (`feat/session-pipe-cleanup` branch, PR-2). The
proxy WS is the only brain transport; there is no flag to flip.

Rollback is now: **`git revert` the offending commit on `main`** and let
Vercel redeploy. This document covers when to do that and the operational
details that revert alone doesn't undo.

---

## When to roll back

Roll back when ANY of these are true within 30min of the cutover commit
landing on production:

- `simli_lipsync_latency_ms` p95 jumps > 1500ms (Sentry alert configured
  in `sentry/alerts/lipsync.json`).
- `user_perceived_response_ms` p95 jumps > 2500ms.
- Sustained > 5% rate of `proxy_*` Sentry events.
- Reports of avatar lipsync looking "off" / "out of sync."
- `simli_video_paused_with_track` PostHog event fires for > 2% of
  sessions on iOS PWA.
- A spike in `envelope_shape_mismatch` PostHog events past the rollout
  window — should be near-zero after 24h.

Do NOT roll back for:

- A single one-off Sentry event (transient network).
- `cartesia_reconnecting` events at ≤ 1% — that's normal upstream blips.
- Lipsync > 1200ms alerts in absence of user reports — verify against
  user signal before reverting.

---

## Execution sequence

1. **Identify the bad commit.** `git log --oneline main` — typically
   the most recent merge from `feat/session-pipe-cleanup` or whatever
   branch shipped the regression.
2. **Verify what the revert will undo (load-bearing).** Run
   `git log --oneline <sha>~1..<sha>` (or for a merge-commit, expand
   with `git log --oneline <merge-sha>^1..<merge-sha>^2`). If the
   target commit is a squash-merge of multiple PRs (e.g., PR-1 cap RPC
   + PR-2 legacy delete in one squash), reverting takes ALL of them —
   you cannot partial-revert. If the branch landed as separate commits
   on `main`, you can pick which one to revert. Pick the latest commit
   that introduced the regression.
3. **Revert on `main`.** `git revert <sha>` (or `git revert -m 1 <merge-sha>`
   if it was a merge commit). Push to `main` → Vercel production deploy
   kicks in (~90s build + propagation).
4. **Do NOT redeploy the Fly proxy during rollback.** Existing
   proxy-WS sessions naturally end at:
   - User-tap-close (most common, < 60s).
   - Gemini's 15-min audio cap (rollover triggers naturally).
   - Reaper at 60s post-heartbeat.

   Redeploying Fly during rollback would force-drop in-flight sessions
   hard, doubling user-visible failures during the bad window.
5. **Monitor for 30min post-revert.** Watch:
   - Sentry: new errors should drop to baseline.
   - PostHog dashboards: `simli_lipsync_latency_ms`,
     `user_perceived_response_ms`, `envelope_shape_mismatch`.
   - Don't expect proxy traffic to drop to zero immediately — old WSs
     are still draining.
6. **Verify rollback completed:** wait for old proxy-WS sessions to
   drain (check `wsRegistry` size in proxy logs; should approach zero
   within 20 minutes since Gemini cap is 15min + reaper grace).

---

## What rollback does NOT undo

- The schema migrations (`voice_tickets.session_id`,
  `creators.voice_id_preview`, `creators.voice_id_dev`,
  `simli_face_delete_queue`, HeyGen-related tables added 2026-05-09).
  All are additive / nullable; reverted code ignores them.
- The proxy's attach-not-insert path (proxy still falls back to the
  legacy `openSession` insert when the ticket has `session_id IS NULL`,
  which is what admin spike-a tickets always do).
- The bridge chunker (R3-C1). Active in any code generation; harmless.
- The `voice_usage_ticket_check` RPC pre-mint cap check added in PR-1.
  Reverting **PR-2 alone** leaves it in place — fine, it just enforces
  caps at HTTP layer regardless. Reverting a squash-merge of PR-1 + PR-2
  takes both, including the cap check (caps would then enforce only at
  the WS-side 4006 close, as before — still correct, just later in the
  flow). Step 2 of the execution sequence tells you which case you're in.

---

## When to roll FORWARD instead

If the failure is in the cookie/session/ticket layer (e.g., 4001
`invalid_ticket` epidemic), don't revert — the same failure mode exists
on the prior code. Instead:

- Check `voice_tickets` table for stuck rows.
- Verify Vercel → Fly clock skew (UA-hash vs `expires_at`).
- File a hotfix forward.

If the failure is `envelope_shape_mismatch` events firing for in-flight
users right after deploy: that's the expected stale-tab race window —
those users get the "Session expired" screen, click again, get a fresh
envelope, recover. NOT a rollback signal unless the rate stays > 1%
past 30min (then a writer somewhere wasn't updated).

If the failure is at the Cartesia layer (`cartesia_reconnecting` >> 1%,
TTS dropping out): toggle `VOICE_CARTESIA_ENABLED=0` on Fly secrets and
redeploy the proxy. That's a separate kill-switch from the cutover and
remains operational. The proxy will fall through to the legacy
Gemini-audio-out path; the avatar will speak Gemini's stock voice
(Sev-0 violation of "cloned voice everywhere" — accept only as a
temporary mitigation, immediately work on a Cartesia fix-forward).

---

## After-action

Once stable for 24h on the reverted state, file a bug describing what
went wrong and re-attempt the cutover. The legacy direct-Gemini path is
gone for good — any rollback puts the codebase in a known-good earlier
state, never in a "flag-off broken-by-design" state.
