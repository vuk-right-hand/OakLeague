-- 0024 — top up reserved_handles with route names that emerged during
-- onboarding plan (invite/claim/apply/admin/etc). Idempotent via ON CONFLICT.
-- Audit refs: R2-Small, R3-Small.

INSERT INTO public.reserved_handles (handle) VALUES
  ('c'),('invite'),('apply'),('auth'),('onboarding'),('logout'),('callback'),
  ('public'),('assets'),('icons'),('images'),('static'),('health'),('robots'),
  ('sitemap'),('favicon'),('manifest'),('team'),('teams'),('billing'),
  ('dashboard'),('claim'),('search'),('explore'),('notifications'),('messages')
ON CONFLICT (handle) DO NOTHING;
