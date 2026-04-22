-- 0049 — voice_build_resume_context RPC
--
-- Days 8–12 plan REV 5, migration 5 of 11.
-- SECURITY DEFINER RPC that reads the last N turns of a prior session and
-- returns them as {role, text} rows to the proxy. Feeds `seedContents` on
-- the Gemini bridge (transcript-replay fallback when native resumption is
-- unavailable or disabled via flag). Ownership-join on user_id — the RPC
-- refuses to return rows for a session the caller doesn't own, even if
-- the service-role caller "passes in" someone else's uid.
--
-- Cap: 2 turns / 1.5k chars (N2-C4 Decision B, halved from REV 3). Newer
-- first — we want "where we left off", not the start of the conversation.

CREATE FUNCTION public.voice_build_resume_context(
  p_session_id     uuid,
  p_caller_user_id uuid
) RETURNS TABLE (
  role       session_turn_role,
  transcript text,
  turn_number int,
  char_count int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner     uuid;
  v_total_chars int := 0;
  v_max_chars  int  := 1500;
  v_max_turns  int  := 2;
  v_row        record;
  v_is_first   boolean := true;
  v_emit_text  text;
  v_emit_cc    int;
BEGIN
  -- Ownership guard (auditor C1 zero-leak contract).
  SELECT s.user_id INTO v_owner
    FROM public.sessions s
   WHERE s.id = p_session_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE = '23503';
  END IF;
  IF v_owner IS DISTINCT FROM p_caller_user_id THEN
    RAISE EXCEPTION 'not owner of session %', p_session_id USING ERRCODE = '42501';
  END IF;

  -- Pull last v_max_turns turns with non-empty transcripts. Reverse-chronological
  -- then we loop and emit in original order (user → assistant → …) so the
  -- proxy can hand them straight to sendClientContent without resorting.
  --
  -- Audit C2: always emit the most-recent turn (newest-first pass's first row).
  -- If that turn alone exceeds v_max_chars, truncate to the tail so the user
  -- sees "where we left off" — a drop right before reconnect is exactly the
  -- case resume exists for, and returning zero rows resumes into a cold
  -- avatar. `right()` preserves the tail (most recent chars within the turn).

  FOR v_row IN
    SELECT t.role, t.transcript, t.turn_number,
           COALESCE(char_length(t.transcript), 0) AS cc
      FROM public.session_turns t
     WHERE t.session_id = p_session_id
       AND t.transcript IS NOT NULL
       AND char_length(t.transcript) > 0
     ORDER BY t.turn_number DESC
     LIMIT v_max_turns
  LOOP
    IF v_is_first THEN
      v_is_first := false;
      IF v_row.cc > v_max_chars THEN
        v_emit_text := right(v_row.transcript, v_max_chars);
        v_emit_cc   := v_max_chars;
      ELSE
        v_emit_text := v_row.transcript;
        v_emit_cc   := v_row.cc;
      END IF;
      v_total_chars := v_total_chars + v_emit_cc;
      RETURN QUERY SELECT v_row.role, v_emit_text, v_row.turn_number, v_emit_cc;
      CONTINUE;
    END IF;

    IF v_total_chars + v_row.cc > v_max_chars THEN
      -- Stop collecting; the partial set we already have is better than nothing.
      EXIT;
    END IF;
    v_total_chars := v_total_chars + v_row.cc;
    RETURN QUERY SELECT v_row.role, v_row.transcript, v_row.turn_number, v_row.cc;
  END LOOP;

  -- NOTE: the RETURN QUERY above emits reverse-chronological rows. Caller
  -- (proxy) sorts by turn_number ASC before handing to seedContents. We keep
  -- that sort on the caller side so this RPC stays a single pass over the
  -- index.
  RETURN;
END;$$;

-- Lock it down: service_role only. Proxy calls via the service-role client.
REVOKE EXECUTE ON FUNCTION public.voice_build_resume_context(uuid, uuid)
  FROM public, anon, authenticated;
