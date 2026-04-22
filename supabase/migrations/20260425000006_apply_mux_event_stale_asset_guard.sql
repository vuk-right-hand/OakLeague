-- 0047 — narrow apply_mux_event stale-asset guard (audit S6).
--
-- The prior guard was:
--   mux_asset_id IS NULL OR v_asset_id IS NULL OR mux_asset_id = v_asset_id
--
-- The OR v_asset_id IS NULL branch tolerates upload.cancelled (which
-- arrives with no asset id), but it also lets a retried upload.cancelled
-- flip a row that ALREADY has a ready asset_id back to 'failed'. Narrow
-- it: a NULL v_asset_id is only accepted while the event belongs to the
-- video.upload.* family — never for video.asset.* retries.

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
  v_target      text;
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
  ELSE
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
  END IF;

  UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_mux_event(text, text, jsonb) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
