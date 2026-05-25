-- 20260525000009 — block links / contact-info in comments (anti-scam)
--
-- Scam links in comments ("DM me 👉 bit.ly/free-coaching") are the fastest way
-- a young creator platform earns a trust problem, and the click lands on OUR
-- domain. The wall lives server-side in post_comment — the single write
-- chokepoint for BOTH top-level comments and replies. A tested SQL helper flags
-- real links + deliberate obfuscation; post_comment hard-rejects with
-- 'link_not_allowed' UNLESS the caller is the video's creator or an admin
-- (_is_video_moderator) — they may link their own course.
--
-- Detection biases toward PRECISION over recall: a literal dot must be
-- space-tight (so "Best book ever. Org meeting tomorrow" is NOT a link), only a
-- curated TLD set counts, and only EXPLICIT obfuscation ("scam dot com",
-- "scamdotcom", "scam(dot)com", "scam·com", zero-width-split) is normalized to
-- a literal dot before matching. Anything that still slips can be hidden by a
-- moderator or reported.
--
-- ACCEPTED RESIDUAL RISK (deliberate, precision-first — moderation/report is the
-- backstop): (a) a spaced literal dot "scam . com" is NOT blocked — it is
-- byte-for-byte indistinguishable from a sentence break like "...ever. Org
-- meeting", so blocking it would false-positive real comments; (b) a bare IPv4
-- with no scheme ("192.168.0.1/x") — not a realistic scam CTA; (c) homoglyph
-- domains (cyrillic lookalikes) — out of scope for v1.

CREATE OR REPLACE FUNCTION public._comment_contains_link(p_body text)
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$  -- STABLE not IMMUTABLE: lower() is collation-dependent; we never index on this
DECLARE
  v_low  text;
  v_norm text;
BEGIN
  IF p_body IS NULL THEN RETURN false; END IF;
  v_low := lower(p_body);

  -- 1) URI scheme — fastest, unambiguous (http/https/ftp/ws/mailto/tel/...).
  IF v_low ~ '(https?|ftps?|sftp|rtsp|wss?|mailto|tel):' THEN
    RETURN true;
  END IF;

  -- 2) www. host.
  IF v_low ~ '(^|[^a-z0-9])www\.[a-z0-9-]' THEN
    RETURN true;
  END IF;

  -- Normalize for the bare-domain pass. We deliberately do NOT collapse
  -- whitespace around an ordinary '.', so a sentence break ("ends. New para")
  -- never becomes a domain. Order matters: strip invisibles, glyph-dots, then
  -- worded "dot" — spaced and tightly-embedded as separate rules so the legit
  -- word "dotcom" (space BEFORE "dot") is never mangled into "the.com".
  --   • zero-width chars (8203 ZWSP, 8204 ZWNJ, 8205 ZWJ, 65279 BOM): "sc<zwsp>am.com"
  --   • dot-like glyphs (183 ·, 8226 •, 8231 ‧): "scam·com"
  v_norm := regexp_replace(v_low,
              '[' || chr(8203) || chr(8204) || chr(8205) || chr(65279) || ']', '', 'g');
  v_norm := regexp_replace(v_norm,
              '[' || chr(183) || chr(8226) || chr(8231) || ']', '.', 'g');
  v_norm := regexp_replace(v_norm, '[\(\[\{]\s*(dot|\.)\s*[\)\]\}]', '.', 'g'); -- (dot) [dot] (.) [.]
  v_norm := regexp_replace(v_norm, '\s+dot\s+', '.', 'g');                       -- "scam dot com"
  -- tightly-embedded "dot" with alnum on BOTH sides → "scamdotcom"; the alnum
  -- prefix is what distinguishes it from the standalone word "dotcom" (a space
  -- precedes the "d" there, so this rule cannot fire on "the dotcom bubble").
  -- Misfires on real words (anecdote → "anec.e") are harmless: the TLD filter
  -- below rejects the non-TLD result.
  v_norm := regexp_replace(v_norm, '([a-z0-9])dot([a-z0-9])', '\1.\2', 'g');

  -- 3) bare domain.tld, space-tight dot, over a curated (precision-first) TLD
  --    set. Deliberately EXCLUDES word-like TLDs that collide with prose when
  --    space-tight is the only guard would be risky — these chosen ones rarely
  --    appear as "word.word" in real comments. Excludes file exts (js, pdf, png)
  --    and abbreviation tails (g in "e.g.", m in "a.m.").
  IF v_norm ~ '(^|[^a-z0-9])[a-z0-9][a-z0-9-]{0,61}\.(com|net|org|io|co|gg|me|app|dev|info|biz|xyz|link|online|site|store|shop|live|top|click|vip|club|space|fun|cc|to|ws|tk|ml|ga|cf|gq|ru|cn)([^a-z0-9-]|$)' THEN
    RETURN true;
  END IF;

  -- 4) well-known shorteners / link-in-bio / chat invites whose TLD is not in
  --    the rule-3 set (ly, gd, gy, ee, bio, ai, gl, be, ...).
  IF v_norm ~ '(^|[^a-z0-9])(bit\.ly|tinyurl\.com|goo\.gl|rb\.gy|is\.gd|buff\.ly|ow\.ly|cutt\.ly|rebrand\.ly|linktr\.ee|lnk\.bio|beacons\.ai|discord\.gg|t\.me|wa\.me|telegram\.me|youtu\.be)([^a-z0-9]|$)' THEN
    RETURN true;
  END IF;

  RETURN false;
END;$$;

REVOKE ALL ON FUNCTION public._comment_contains_link(text) FROM public, anon, authenticated;

-- post_comment — re-defined to add the anti-scam gate. Body is otherwise
-- identical to 20260525000008 (video-available + dual rate caps + depth-guard
-- via trigger). The link gate sits AFTER body validation and AFTER the
-- video-available check (so a blocked link on an unavailable video still
-- reports the more fundamental error), and BEFORE rate-limit consumption (so a
-- rejected link does not burn the caller's per-minute budget). The moderator
-- exemption is only evaluated WHEN a link is present (cheap common path).
CREATE OR REPLACE FUNCTION public.post_comment(p_video_id uuid, p_body text, p_parent_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  IF p_body IS NULL OR char_length(btrim(p_body)) = 0 OR char_length(p_body) > 2000 THEN
    RAISE EXCEPTION 'bad_body' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.videos v JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = p_video_id AND v.published_at IS NOT NULL AND c.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'video_not_available' USING ERRCODE = 'P0001';
  END IF;

  -- Anti-scam: ordinary viewers cannot post links / contact-info. The video's
  -- creator and admins are exempt (they may link their own course). The
  -- moderator check only runs when a link is actually detected.
  IF public._comment_contains_link(p_body) THEN
    IF NOT public._is_video_moderator(p_video_id, v_uid) THEN
      RAISE EXCEPTION 'link_not_allowed' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Per-caller + per-video caps (audit M6: blunt brigading of one video).
  IF NOT public.rate_limit_hit('comment_post', v_uid::text, interval '1 minute', 10) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.rate_limit_hit('comment_video', p_video_id::text, interval '1 minute', 120) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.video_comments (video_id, user_id, parent_id, body)
  VALUES (p_video_id, v_uid, p_parent_id, btrim(p_body))  -- depth guard trigger validates parent
  RETURNING id INTO v_id;
  RETURN v_id;
END;$$;

REVOKE ALL   ON FUNCTION public.post_comment(uuid, text, uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.post_comment(uuid, text, uuid) TO authenticated;
