-- 0003 — reserved_handles
-- Seed of names that cannot be claimed as a handle. "vuk" is NOT seeded:
-- creator #1 must go through the real invite → application → approval flow.

CREATE TABLE public.reserved_handles (
  handle citext PRIMARY KEY
);

ALTER TABLE public.reserved_handles ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

INSERT INTO public.reserved_handles (handle) VALUES
  ('admin'),('oakleague'),('support'),('api'),('www'),('root'),('system'),
  ('null'),('undefined'),('settings'),('login'),('signup'),('waitlist'),
  ('about'),('terms'),('privacy'),('help'),('contact'),
  ('creator'),('creators'),('user'),('users'),('home'),('feed');
