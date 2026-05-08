-- 20260509000004 — creators.heygen_avatar_id
--
-- HeyGen wireup, migration 4 of 4. Adds the per-creator HeyGen avatar
-- identifier, parallel to creators.simli_face_id (migration
-- 20260420000011:25).
--
-- Provisioning today: manual SQL only. As of 2026-05-08 there is NO
-- admin UI / API that writes this column. `/api/admin/face-upload` is
-- Simli-only (Trinity-1 image clone). Until a HeyGen face-upload path
-- is wired (planned: extend `face_clone_uploads.vendor` to 'heygen' +
-- finalize hook copies vendor_face_id here), HeyGen is unreachable for
-- any creator without a hand-rolled UPDATE. See Phase C punch list
-- B2.6 for the wiring plan.
--
-- Format: HeyGen avatar IDs are UUID v4. NOT enforced as a CHECK here
-- because face_clone_uploads.vendor_face_id has the canonical 1–128 char
-- bounds and our mint helper at mint-heygen.ts validates strict UUID
-- shape at the API boundary. Mirroring the lax simli_face_id constraint
-- (which is plain `text` with no shape check on creators).
--
-- Sessions/open / sessions/rollover read this column when
-- resolveAvatarProvider(tier) == 'heygen' and pass it as
-- mintHeygenSessionToken({ avatarId }). NULL means "creator hasn't
-- trained a HeyGen avatar yet" — sessions/open returns 503
-- avatar_unavailable in that case (FORCE_AVATAR_REQUIRED), or falls
-- through to voice-only mode.

ALTER TABLE public.creators
  ADD COLUMN heygen_avatar_id text;
