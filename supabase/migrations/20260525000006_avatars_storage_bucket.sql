-- 20260525000006 — avatars storage bucket (PROFILE_SYSTEM_PLAN U2 / §3.5)
--
-- Public-read bucket for user avatars. Objects are written ONLY by the
-- /api/me/avatar route via the service role (which bypasses storage RLS);
-- there is no client-side write policy. Path convention is
--   avatars/{profiles.public_id}/avatar.webp
-- keyed on the OPAQUE public_id — never auth.users.id (audit M3). The route
-- re-encodes every upload to stripped 512px WEBP, so the bucket only ever
-- holds image/webp.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152, ARRAY['image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Public read (the avatar appears on public profiles). Writes are service-role
-- only — no INSERT/UPDATE/DELETE policy, so authenticated/anon cannot write
-- directly; the upload route uses the service key.
DROP POLICY IF EXISTS "avatars public read" ON storage.objects;
CREATE POLICY "avatars public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');
