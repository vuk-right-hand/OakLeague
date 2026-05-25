-- 20260525000001 — profiles: bio, opaque public_id, handshake counts
-- PROFILE_SYSTEM_PLAN U1. All additive + nullable/defaulted → no NOT NULL drift
-- on existing rows (CLAUDE.md schema blast-radius discipline).
--
--  - bio:        users have no bio column today (creators do, on creators).
--  - public_id:  opaque per-profile id for public surfaces (avatar paths,
--                client keys) so auth.users.id NEVER leaks to anon
--                (Round-1 audit M3/M4). Volatile default → table rewrite
--                fills existing rows with distinct UUIDs.
--  - handshake_count / handshakes_given_count: denormalized follow counters,
--                maintained by the handshakes trigger (20260525000002).
--                handshake_count (RECEIVED) is the headline number; given is
--                secondary + self-inflatable (Round-2 audit M2).

ALTER TABLE public.profiles
  ADD COLUMN bio                    text  CHECK (bio IS NULL OR char_length(bio) <= 2000),
  ADD COLUMN public_id              uuid  NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN handshake_count        int   NOT NULL DEFAULT 0 CHECK (handshake_count >= 0),
  ADD COLUMN handshakes_given_count int   NOT NULL DEFAULT 0 CHECK (handshakes_given_count >= 0);

CREATE UNIQUE INDEX profiles_public_id_idx ON public.profiles (public_id);
