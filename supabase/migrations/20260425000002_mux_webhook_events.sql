-- 0043 — Mux webhook idempotency ledger + dispatch RPC.
-- Days 6-7 feed plan §2.2. One insert per Mux event_id (PK). Dispatcher
-- routes by passthrough UUID to hooks or welcome_hooks.
--
-- R3-M1 aspect-ratio normalization lives in normalize_aspect_ratio().
-- R4-M1: passthrough lives at different paths across event families —
--   video.asset.*  → data.passthrough
--   video.upload.* → data.new_asset_settings.passthrough (historically),
--                    sometimes data.passthrough as well.
--   COALESCE covers both.
-- R4-S2: stale-asset guard tolerates NULL on either side (upload.cancelled
--   arrives before asset creation).

CREATE TABLE public.mux_webhook_events (
  id           text        PRIMARY KEY,
  type         text        NOT NULL CHECK (char_length(type) <= 64),
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  payload      jsonb       NOT NULL CHECK (octet_length(payload::text) <= 131072)
);
ALTER TABLE public.mux_webhook_events ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
REVOKE ALL ON public.mux_webhook_events FROM PUBLIC, anon, authenticated;

CREATE INDEX mux_webhook_events_received_idx
  ON public.mux_webhook_events (received_at DESC);

-- Aspect-ratio normalizer. Mux emits raw w:h; we snap to '9:16' / '16:9'
-- if the ratio is within tolerance, otherwise pass through.
CREATE OR REPLACE FUNCTION public.normalize_aspect_ratio(raw text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_w     numeric;
  v_h     numeric;
  v_ratio numeric;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  IF raw !~ '^\d+:\d+$' THEN RETURN raw; END IF;

  v_w := split_part(raw, ':', 1)::numeric;
  v_h := split_part(raw, ':', 2)::numeric;
  IF v_h = 0 THEN RETURN raw; END IF;

  v_ratio := v_w / v_h;
  IF v_ratio BETWEEN 0.55 AND 0.58 THEN RETURN '9:16'; END IF;
  IF v_ratio BETWEEN 1.77 AND 1.78 THEN RETURN '16:9'; END IF;
  RETURN raw;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.normalize_aspect_ratio(text) FROM public;
GRANT  EXECUTE ON FUNCTION public.normalize_aspect_ratio(text) TO service_role;

-- apply_mux_event: idempotent webhook dispatcher. Service-role only.
-- On duplicate event_id, returns immediately (no-op). Otherwise dispatches
-- by mux_passthrough UUID to hooks or welcome_hooks.
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
  v_target      text;  -- 'hook' | 'welcome_hook'
  v_row_count   integer;
BEGIN
  -- Idempotency: one row per event id. ON CONFLICT DO NOTHING reports
  -- ROW_COUNT=0 when the row already existed.
  INSERT INTO public.mux_webhook_events (id, type, payload)
  VALUES (p_event_id, p_type, p_payload)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count = 0 THEN
    RETURN;  -- duplicate event; already processed (or being processed)
  END IF;

  -- Passthrough (bare UUID). Read asset-family path first, fall back to
  -- upload-family nested path.
  v_passthrough := NULLIF(COALESCE(
    p_payload #>> '{data,passthrough}',
    p_payload #>> '{data,new_asset_settings,passthrough}'
  ), '')::uuid;

  IF v_passthrough IS NULL THEN
    UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
    RETURN;  -- event not for us (e.g. signing-key lifecycle events)
  END IF;

  -- Dispatch: hooks first, then welcome_hooks.
  IF EXISTS (SELECT 1 FROM public.hooks WHERE mux_passthrough = v_passthrough) THEN
    v_target := 'hook';
  ELSIF EXISTS (SELECT 1 FROM public.welcome_hooks WHERE mux_passthrough = v_passthrough) THEN
    v_target := 'welcome_hook';
  ELSE
    UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
    RETURN;  -- passthrough unknown (stale / deleted row)
  END IF;

  -- Extract fields. Upload-family events have id at data.id (= upload id);
  -- asset-family events have id at data.id (= asset id). Distinguish by type.
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
        OR v_asset_id IS NULL
        OR mux_asset_id = v_asset_id
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
        OR v_asset_id IS NULL
        OR mux_asset_id = v_asset_id
      );
  END IF;

  UPDATE public.mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_mux_event(text, text, jsonb) FROM PUBLIC;
-- No GRANTs — service-role only; called from the webhook route via supabaseAdmin().

NOTIFY pgrst, 'reload schema';
