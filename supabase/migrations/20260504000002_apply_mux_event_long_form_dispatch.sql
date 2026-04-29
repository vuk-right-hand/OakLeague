-- 0504-02 — apply_mux_event extended with a third dispatch branch for
-- videos.long_form_*. Long-form viewer plan §1.2 / Mux dispatch.
--
-- Full rewrite of apply_mux_event mirroring 20260425000006 (the narrowed
-- stale-asset guard) plus a 'video_long_form' branch. Webhook route
-- (src/app/api/webhooks/mux/route.ts) is target-agnostic and unchanged —
-- the dispatch fan-out lives entirely inside this RPC.
--
-- Aspect-ratio enforcement is intentionally NOT done here. We let the
-- asset reach status='ready' so the creator can preview it; the publish
-- gate (publishLongForm server action) is the policy boundary that
-- rejects 9:16 / NULL aspect at publish time. Same with duration —
-- the DB CHECK is loose 60–3600s, the 5–55 min rule lives in publishLongForm.

CREATE OR REPLACE FUNCTION public.apply_mux_event(
  p_event_id text,
  p_type     text,
  p_payload  jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_passthrough uuid;
  v_asset_id    text;
  v_upload_id   text;
  v_playback_id text;
  v_aspect      text;
  v_duration_ms integer;
  v_error       text;
  v_target      text;  -- 'hook' | 'welcome_hook' | 'video_long_form'
  v_row_count   integer;
BEGIN
  INSERT INTO public.mux_webhook_events (id, type, payload)
  VALUES (p_event_id, p_type, p_payload)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count = 0 THEN
    RETURN;
  END IF;

  v_passthrough := NULLIF(COALESCE(
    p_payload #>> '{data,passthrough}',
    p_payload #>> '{data,new_asset_settings,passthrough}'
  ), '')::uuid;

  IF v_passthrough IS NULL THEN
    UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.hooks WHERE mux_passthrough = v_passthrough) THEN
    v_target := 'hook';
  ELSIF EXISTS (SELECT 1 FROM public.welcome_hooks WHERE mux_passthrough = v_passthrough) THEN
    v_target := 'welcome_hook';
  ELSIF EXISTS (SELECT 1 FROM public.videos WHERE long_form_mux_passthrough = v_passthrough) THEN
    v_target := 'video_long_form';
  ELSE
    UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
    RETURN;
  END IF;

  IF p_type LIKE 'video.upload.%' THEN
    v_upload_id := p_payload #>> '{data,id}';
    v_asset_id  := p_payload #>> '{data,asset_id}';
  ELSE
    v_asset_id  := p_payload #>> '{data,id}';
  END IF;

  v_playback_id := p_payload #>> '{data,playback_ids,0,id}';
  v_aspect      := public.normalize_aspect_ratio(p_payload #>> '{data,aspect_ratio}');
  v_duration_ms := CASE
    WHEN p_payload #>> '{data,duration}' IS NOT NULL
    THEN ((p_payload #>> '{data,duration}')::numeric * 1000)::integer
    ELSE NULL END;
  v_error := COALESCE(
    p_payload #>> '{data,errors,messages,0}',
    p_payload #>> '{data,error,messages,0}'
  );

  IF v_target = 'hook' THEN
    UPDATE public.hooks SET
      mux_status = CASE p_type
        WHEN 'video.asset.ready'       THEN 'ready'
        WHEN 'video.asset.errored'     THEN 'failed'
        WHEN 'video.asset.created'     THEN 'processing'
        WHEN 'video.upload.created'    THEN 'uploading'
        WHEN 'video.upload.cancelled'  THEN 'failed'
        WHEN 'video.upload.errored'    THEN 'failed'
        ELSE mux_status END,
      mux_upload_id    = COALESCE(v_upload_id,   mux_upload_id),
      mux_asset_id     = COALESCE(v_asset_id,    mux_asset_id),
      mux_playback_id  = COALESCE(v_playback_id, mux_playback_id),
      mux_aspect_ratio = COALESCE(v_aspect,      mux_aspect_ratio),
      mux_duration_ms  = COALESCE(v_duration_ms, mux_duration_ms),
      duration_seconds = COALESCE(
        CASE WHEN v_duration_ms IS NOT NULL THEN CEIL(v_duration_ms / 1000.0)::int END,
        duration_seconds
      ),
      processing_error = v_error
    WHERE mux_passthrough = v_passthrough
      AND (
        mux_asset_id IS NULL
        OR mux_asset_id = v_asset_id
        OR (v_asset_id IS NULL AND p_type LIKE 'video.upload.%')
      );
  ELSIF v_target = 'welcome_hook' THEN
    UPDATE public.welcome_hooks SET
      mux_status = CASE p_type
        WHEN 'video.asset.ready'       THEN 'ready'
        WHEN 'video.asset.errored'     THEN 'failed'
        WHEN 'video.asset.created'     THEN 'processing'
        WHEN 'video.upload.created'    THEN 'uploading'
        WHEN 'video.upload.cancelled'  THEN 'failed'
        WHEN 'video.upload.errored'    THEN 'failed'
        ELSE mux_status END,
      mux_upload_id    = COALESCE(v_upload_id,   mux_upload_id),
      mux_asset_id     = COALESCE(v_asset_id,    mux_asset_id),
      mux_playback_id  = COALESCE(v_playback_id, mux_playback_id),
      mux_aspect_ratio = COALESCE(v_aspect,      mux_aspect_ratio),
      mux_duration_ms  = COALESCE(v_duration_ms, mux_duration_ms),
      duration_seconds = COALESCE(
        CASE WHEN v_duration_ms IS NOT NULL THEN CEIL(v_duration_ms / 1000.0)::int END,
        duration_seconds
      ),
      processing_error = v_error
    WHERE mux_passthrough = v_passthrough
      AND (
        mux_asset_id IS NULL
        OR mux_asset_id = v_asset_id
        OR (v_asset_id IS NULL AND p_type LIKE 'video.upload.%')
      );
  ELSE  -- 'video_long_form'
    UPDATE public.videos SET
      long_form_mux_status = CASE p_type
        WHEN 'video.asset.ready'       THEN 'ready'
        WHEN 'video.asset.errored'     THEN 'failed'
        WHEN 'video.asset.created'     THEN 'processing'
        WHEN 'video.upload.created'    THEN 'uploading'
        WHEN 'video.upload.cancelled'  THEN 'failed'
        WHEN 'video.upload.errored'    THEN 'failed'
        ELSE long_form_mux_status END,
      long_form_mux_upload_id    = COALESCE(v_upload_id,   long_form_mux_upload_id),
      long_form_mux_asset_id     = COALESCE(v_asset_id,    long_form_mux_asset_id),
      long_form_mux_playback_id  = COALESCE(v_playback_id, long_form_mux_playback_id),
      long_form_mux_aspect_ratio = COALESCE(v_aspect,      long_form_mux_aspect_ratio),
      long_form_mux_duration_ms  = COALESCE(v_duration_ms, long_form_mux_duration_ms),
      long_form_duration_seconds = COALESCE(
        CASE WHEN v_duration_ms IS NOT NULL THEN CEIL(v_duration_ms / 1000.0)::int END,
        long_form_duration_seconds
      ),
      long_form_processing_error = v_error
    WHERE long_form_mux_passthrough = v_passthrough
      AND (
        long_form_mux_asset_id IS NULL
        OR long_form_mux_asset_id = v_asset_id
        OR (v_asset_id IS NULL AND p_type LIKE 'video.upload.%')
      );
  END IF;

  UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_mux_event(text, text, jsonb) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
