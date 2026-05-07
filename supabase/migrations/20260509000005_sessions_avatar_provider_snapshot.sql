-- 20260509000005 — sessions.avatar_provider + heygen_session_token snapshot
--
-- HeyGen wireup, follow-up migration after post-build audit.
--
-- Audit (post-build) M1: rollover currently re-resolves the avatar
-- provider from env at the time of rollover. If an admin flips
-- AVATAR_PROVIDER_PREMIUM between the original session-open and the
-- 15-min Gemini-cap-driven rollover (Vercel re-deploy, Fly machine
-- restart), the rolled-over session silently swaps providers — a
-- different face_id column, different bridge factory, different
-- LiveKit room. CLAUDE.md mandates tier (and by extension provider)
-- never changes mid-session. Snapshot to DB so the rollover RPC and
-- route inherit the original provider.
--
-- Audit (post-build) C3: voice-proxy must fire HeyGen
-- /v1/sessions/keep-alive every 30s with the privileged session JWT.
-- The proxy doesn't have it today — we plumbed it through voice_tickets
-- in the prior migration but session_rollover would lose it. Snapshot
-- onto sessions so the proxy can re-read it on attach via the existing
-- attachToSession() flow without a second round-trip.
--
-- Both columns NULLABLE: existing rows pre-dating this migration have
-- no recorded provider, and voice-only sessions stay NULL.
--
-- heygen_session_token security: never SELECTed by anything but the
-- service-role client (RLS on sessions blocks anon/authenticated reads
-- of arbitrary columns; this column joins that posture).

ALTER TABLE public.sessions
  ADD COLUMN avatar_provider      public.face_vendor,
  ADD COLUMN heygen_session_id    text,
  ADD COLUMN heygen_session_token text;

-- The HeyGen session JWT is privileged (server-side only, never
-- returned via REST). Comment makes the rule explicit so a future
-- contributor doesn't accidentally add it to a public RPC return type.
COMMENT ON COLUMN public.sessions.heygen_session_token IS
  'Privileged HeyGen /v1/sessions/start JWT. Service-role only — never expose via API. Used by voice-proxy for /v1/sessions/keep-alive heartbeat.';

-- Helper index for the proxy heartbeat reaper-style query: "find all
-- live sessions on heygen that need a keep-alive tick." Partial keeps
-- it tiny.
CREATE INDEX sessions_heygen_live_idx
  ON public.sessions (avatar_provider, started_at)
  WHERE avatar_provider = 'heygen' AND ended_at IS NULL;
