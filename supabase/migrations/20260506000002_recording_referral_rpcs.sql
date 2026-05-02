-- Day 4 — referral mint / revoke / redeem RPCs.
--
-- Three SECURITY DEFINER service-role-callable RPCs:
--
--   recording_referral_mint(p_user, p_creator, p_clip, p_token_hash)
--     → returns boolean: true if minted, false if daily cap hit.
--     Called from /api/recording/open-check after permission grant (audit C2 Day 4).
--
--   recording_referral_revoke(p_user, p_token_hash)
--     → returns void. Sets expires_at = now(). Idempotent.
--     Called from /api/recording/discard on user-initiated dismiss (audit C3 Day 4).
--
--   recording_referral_redeem_landing(p_token_hash, p_device_fp, p_ip_prefix, p_cookie_set_ok)
--     → returns the (creator_id) tied to the token, or null if invalid/expired.
--     Called from /r/[token]/route.ts after Sec-Fetch-Dest=document gate (audit C1 Day 4).
--     Inserts a referral_redemptions row with credit_event='landing'. Idempotent
--     on (token_hash, device_fp) for anon visitors (partial unique index).
--
-- WHY SECURITY DEFINER: the route handlers run with the service-role client
-- but the explicit definer + revoke pattern documents intent + makes the
-- mint cap CHECK transactional with the count UPDATE.

-- ── recording_referral_mint -----------------------------------------------
-- Atomic: cap-check + mint INSERT + counter UPSERT in one statement.
-- Returns true on mint, false on cap hit. Caller (route handler) translates
-- false → HTTP 429 with daily_share_cap reason for ReactButton's degrade UX.

CREATE OR REPLACE FUNCTION public.recording_referral_mint(
  p_user        uuid,
  p_creator     uuid,
  p_clip        uuid,
  p_token_hash  text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_cap        int;
  v_today      date := (now() AT TIME ZONE 'UTC')::date;
  v_count      int;
BEGIN
  -- Read the per-user cap. Profile MUST exist; service-role caller is
  -- expected to have authenticated the user before calling.
  SELECT recording_share_daily_cap INTO v_cap
    FROM public.profiles WHERE id = p_user;
  IF v_cap IS NULL THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = '42704';
  END IF;

  -- Audit C1 Day-4-fix: cap=0 admin-set must block the very first mint of
  -- the day. Without this, the bare INSERT VALUES(...,1) bypasses the WHERE
  -- clause (which only fires on conflict). Bail early.
  IF v_cap <= 0 THEN
    RETURN false;
  END IF;

  -- Increment-or-init counter; check cap atomically. UPSERT pattern.
  INSERT INTO public.recording_token_mints_daily (user_id, day, count)
    VALUES (p_user, v_today, 1)
    ON CONFLICT (user_id, day) DO UPDATE
      SET count = recording_token_mints_daily.count + 1
      WHERE recording_token_mints_daily.count < v_cap
    RETURNING count INTO v_count;

  IF v_count IS NULL THEN
    -- WHERE clause failed → cap already at limit. UPSERT was a no-op.
    RETURN false;
  END IF;

  -- Mint the token row. Conflict on token_hash should never happen (caller
  -- generated 96-bit random plaintext) but a duplicate mint is a programmer
  -- error worth surfacing rather than silently swallowing.
  INSERT INTO public.referral_tokens (token_hash, user_id, creator_id, clip_id)
    VALUES (p_token_hash, p_user, p_creator, p_clip);

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text) IS
  'Mints a referral token if user is under daily cap. Returns false on cap hit. Service-role only.';

-- ── recording_referral_revoke ---------------------------------------------
-- Sets expires_at = now() so the token can no longer redeem. Idempotent —
-- safe to call multiple times. Owner-checked: only the minting user can revoke.

CREATE OR REPLACE FUNCTION public.recording_referral_revoke(
  p_user        uuid,
  p_token_hash  text
) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  UPDATE public.referral_tokens
     SET expires_at = now()
   WHERE token_hash = p_token_hash
     AND user_id    = p_user
     AND expires_at > now();
$$;

REVOKE EXECUTE ON FUNCTION public.recording_referral_revoke(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recording_referral_revoke(uuid, text)
  TO service_role;

-- ── recording_referral_redeem_landing -------------------------------------
-- Validates a token hash + records a 'landing' redemption. Returns the
-- token's creator_id for the post-redirect creator-drawer hint (Day 5).
-- Returns NULL if token is invalid / expired (let caller 404 vs 410 vs
-- silent-redirect; route handler decides UX).

CREATE OR REPLACE FUNCTION public.recording_referral_redeem_landing(
  p_token_hash    text,
  p_device_fp     text,
  p_ip_prefix     text,
  p_cookie_set_ok boolean
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_creator_id    uuid;
  v_inserted_rows int;
BEGIN
  -- Validate token. expires_at > now() AND row exists.
  SELECT creator_id INTO v_creator_id
    FROM public.referral_tokens
   WHERE token_hash = p_token_hash
     AND expires_at > now();

  IF NOT FOUND THEN
    RETURN NULL;  -- token invalid or expired
  END IF;

  -- Record the redemption. ON CONFLICT DO NOTHING for the anon-landing
  -- (partial unique on token_hash + device_fp where new_user_id IS NULL).
  INSERT INTO public.referral_redemptions
    (token_hash, new_user_id, device_fp, ip_prefix, credit_event, cookie_set_ok)
    VALUES (p_token_hash, NULL, p_device_fp, p_ip_prefix, 'landing', p_cookie_set_ok)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;

  -- Bump redeemed_count + last_redeemed_at ONLY on a fresh insert (audit
  -- Small Day-4-fix: a refreshed bot pulling /r/<token> 10000 times shouldn't
  -- inflate the popularity metric).
  IF v_inserted_rows > 0 THEN
    UPDATE public.referral_tokens
       SET redeemed_count   = redeemed_count + 1,
           last_redeemed_at = now()
     WHERE token_hash = p_token_hash;
  END IF;

  RETURN v_creator_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recording_referral_redeem_landing(text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recording_referral_redeem_landing(text, text, text, boolean)
  TO service_role;

-- ── recording_referral_credit_first_session -------------------------------
-- Called from /api/sessions/open via post-response waitUntil (audit C4 Day
-- 4). Promotes a 'landing' to 'first_session' if user matches a redemption
-- row that was anon at landing-time, OR creates a fresh 'first_session' row
-- if cookie + token survived but no landing row exists (no-Sec-Fetch-Dest
-- browser path). Idempotent on (token_hash, new_user_id, credit_event).

CREATE OR REPLACE FUNCTION public.recording_referral_credit_first_session(
  p_token_hash text,
  p_new_user   uuid,
  p_device_fp  text,
  p_ip_prefix  text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_token_valid boolean;
  v_already_credited int;
BEGIN
  -- Token still valid?
  SELECT (expires_at > now()) INTO v_token_valid
    FROM public.referral_tokens
   WHERE token_hash = p_token_hash;
  IF v_token_valid IS NULL OR NOT v_token_valid THEN
    RETURN false;
  END IF;

  -- Has this user already received first_session credit on this token?
  SELECT count(*) INTO v_already_credited
    FROM public.referral_redemptions
   WHERE token_hash   = p_token_hash
     AND new_user_id  = p_new_user
     AND credit_event = 'first_session';
  IF v_already_credited > 0 THEN
    RETURN false;
  END IF;

  -- Insert. Conflict-tolerant for the (token_hash, new_user_id, 'first_session')
  -- constraint — defensive even though we just checked.
  INSERT INTO public.referral_redemptions
    (token_hash, new_user_id, device_fp, ip_prefix, credit_event)
    VALUES (p_token_hash, p_new_user, p_device_fp, p_ip_prefix, 'first_session')
    ON CONFLICT DO NOTHING;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recording_referral_credit_first_session(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recording_referral_credit_first_session(text, uuid, text, text)
  TO service_role;
