-- 0042 — Mux upload tracking on hooks + welcome_hooks.
-- Days 6-7 feed plan §2.1. Adds direct-upload state, passthrough UUID,
-- normalized aspect + precise duration, seed flag, admin RLS policy,
-- public views (security_invoker), publish guard, welcome swap RPC.
--
-- Column conflicts with existing schema (0015, 0016):
--   • hooks.mux_playback_id and hooks.duration_seconds exist NOT NULL;
--     admin creates the row BEFORE upload completes, so we relax NOT NULL.
--   • welcome_hooks.mux_playback_id / duration_seconds — same treatment.
-- We keep duration_seconds (human) and add mux_duration_ms (webhook precision).
-- hooks needs a `title` column (not in 0016) for the admin console and feed.

-- is_admin(uid) helper — used by admin RLS USING expressions below.
-- admin_roles PK is user_id (migration 0025); revoked_at may be non-null.
CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_roles
    WHERE user_id = p_uid AND revoked_at IS NULL
  );
$$;
REVOKE ALL    ON FUNCTION public.is_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO anon, authenticated, service_role;

-- hooks: relax NOT NULL on playback-dependent columns, add Mux tracking + title.
ALTER TABLE public.hooks
  ALTER COLUMN mux_playback_id  DROP NOT NULL,
  ALTER COLUMN duration_seconds DROP NOT NULL;

ALTER TABLE public.hooks
  ADD COLUMN title            text CHECK (title IS NULL OR char_length(title) <= 200),
  ADD COLUMN mux_upload_id    text,
  ADD COLUMN mux_asset_id     text UNIQUE,
  ADD COLUMN mux_status       text NOT NULL DEFAULT 'pending'
    CHECK (mux_status IN ('pending','uploading','processing','ready','failed')),
  ADD COLUMN mux_aspect_ratio text,
  ADD COLUMN mux_duration_ms  integer CHECK (mux_duration_ms IS NULL OR mux_duration_ms > 0),
  ADD COLUMN mux_passthrough  uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN processing_error text CHECK (processing_error IS NULL OR char_length(processing_error) <= 1024),
  ADD COLUMN is_seed_content  boolean NOT NULL DEFAULT false;

-- welcome_hooks: same treatment (no title column — welcome is per-creator).
ALTER TABLE public.welcome_hooks
  ALTER COLUMN mux_playback_id  DROP NOT NULL,
  ALTER COLUMN duration_seconds DROP NOT NULL;

ALTER TABLE public.welcome_hooks
  ADD COLUMN mux_upload_id    text,
  ADD COLUMN mux_asset_id     text UNIQUE,
  ADD COLUMN mux_status       text NOT NULL DEFAULT 'pending'
    CHECK (mux_status IN ('pending','uploading','processing','ready','failed')),
  ADD COLUMN mux_aspect_ratio text,
  ADD COLUMN mux_duration_ms  integer CHECK (mux_duration_ms IS NULL OR mux_duration_ms > 0),
  ADD COLUMN mux_passthrough  uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN processing_error text CHECK (processing_error IS NULL OR char_length(processing_error) <= 1024);

CREATE INDEX hooks_seed_idx ON public.hooks (is_seed_content) WHERE is_seed_content = true;
CREATE INDEX hooks_feed_order_idx ON public.hooks (created_at DESC, id DESC)
  WHERE mux_status = 'ready' AND is_seed_content = false;

-- Backfill: any pre-existing row with a playback_id predates this migration.
-- Mark it ready so existing admin/test fixtures survive the view filter.
UPDATE public.hooks
   SET mux_status = 'ready'
 WHERE mux_playback_id IS NOT NULL;
UPDATE public.welcome_hooks
   SET mux_status = 'ready'
 WHERE mux_playback_id IS NOT NULL;

-- Admin RLS — authenticated admin sees / writes everything (RSC + realtime).
-- Adds to existing "own all" + "public read when parent published" policies
-- (PostgreSQL OR-combines permissive policies).
CREATE POLICY "hooks admin all"
  ON public.hooks FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "welcome_hooks admin all"
  ON public.welcome_hooks FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Public-facing views. security_invoker=true → RLS on base tables fires in
-- the caller's context. Seed filter lives AT the view so a direct anon
-- SELECT cannot leak placeholder rows (R4-M6).
CREATE VIEW public.hooks_public WITH (security_invoker = true) AS
  SELECT id,
         video_id,
         lesson_number,
         title,
         caption,
         transcript,
         topic_tags,
         mux_playback_id,
         mux_aspect_ratio,
         mux_duration_ms,
         duration_seconds,
         opening_prompt,
         question_seeds,
         created_at
    FROM public.hooks
   WHERE mux_status = 'ready'
     AND is_seed_content = false;

-- welcome_hooks stands alone (no hook_id column in 0015). Narrow shape.
CREATE VIEW public.welcome_hooks_public WITH (security_invoker = true) AS
  SELECT id,
         creator_id,
         video_id,
         mux_playback_id,
         mux_aspect_ratio,
         mux_duration_ms,
         duration_seconds,
         transcript,
         active
    FROM public.welcome_hooks
   WHERE active = true
     AND mux_status = 'ready';

GRANT SELECT ON public.hooks_public, public.welcome_hooks_public TO anon, authenticated;

-- Publish guard: videos.published_at can only be set when at least one
-- hook under that video has mux_status='ready'. Fires on INSERT and UPDATE
-- so a row can't be INSERT'd already-published with no ready hooks.
CREATE OR REPLACE FUNCTION public.guard_published_requires_ready_hooks()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_at IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.hooks
       WHERE video_id = NEW.id AND mux_status = 'ready'
    ) THEN
      RAISE EXCEPTION 'Cannot publish video %: no ready hooks', NEW.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_published_requires_ready_hooks() FROM public;

CREATE TRIGGER videos_publish_guard
  BEFORE INSERT OR UPDATE OF published_at ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.guard_published_requires_ready_hooks();

-- Atomic active-welcome swap. Partial UNIQUE index on welcome_hooks
-- (active=true) means only one row is active at a time. Run the two
-- UPDATEs sequentially: false-all first, then true-one. Between statements
-- zero rows are active — the unique index tolerates that.
CREATE OR REPLACE FUNCTION public.set_active_welcome_hook(p_welcome_hook_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Target must be ready — don't promote a pending/failed welcome hook.
  IF NOT EXISTS (
    SELECT 1 FROM public.welcome_hooks
     WHERE id = p_welcome_hook_id AND mux_status = 'ready'
  ) THEN
    RAISE EXCEPTION 'welcome_hook % is not ready', p_welcome_hook_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.welcome_hooks SET active = false WHERE active = true;
  UPDATE public.welcome_hooks SET active = true  WHERE id = p_welcome_hook_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.set_active_welcome_hook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_active_welcome_hook(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
