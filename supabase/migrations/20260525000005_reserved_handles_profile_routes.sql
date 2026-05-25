-- 20260525000005 — reserve live top-level route segments missing from
-- reserved_handles before /@[handle] profiles go live (PROFILE_SYSTEM_PLAN
-- U4 / audit Round-2 M7). Without these, a user could claim handle 's', 'v',
-- 'rate', or 'upgrade' and shadow a live route (or just confuse links).
-- Audited against the src/app tree, not from memory. Idempotent.

INSERT INTO public.reserved_handles (handle) VALUES
  ('s'),          -- /s/[id]   session
  ('v'),          -- /v/[id]   video
  ('rate'),       -- /rate/[token]
  ('upgrade'),    -- /upgrade
  ('r'),          -- /r/[token] recording referral
  ('creator'),    -- /creator  studio
  ('admin'),      -- /admin
  ('login'),      -- belt-and-suspenders (already present, ON CONFLICT no-ops)
  ('feed'),       -- bottom-nav Home target
  ('discover'),   -- bottom-nav Discover
  ('activity'),   -- bottom-nav Activity
  ('you'),        -- bottom-nav self
  ('profile'),
  ('handshakes'),
  ('watch'),
  ('terms'),
  ('privacy'),
  ('waitlist')
ON CONFLICT (handle) DO NOTHING;
