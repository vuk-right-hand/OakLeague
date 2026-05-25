-- comment_link_block (20260525000009). Anti-scam link gate in post_comment.
-- Split focus: (A) the _comment_contains_link truth table — precision over
-- recall, no false-positive on a sentence break; (B) the post_comment gate —
-- ordinary viewers blocked, the video's creator + admins exempt, reply path
-- equally gated.
BEGIN;
SELECT plan(30);

-- privilege: helper is internal (REVOKE ALL), not callable by clients.
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_comment_contains_link'
   AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
   '0: authenticated has NO EXECUTE on _comment_contains_link');

-- ── (A) truth table ────────────────────────────────────────────────────────
-- positives
SELECT ok(public._comment_contains_link('http://x.com'),                 '1: http scheme');
SELECT ok(public._comment_contains_link('see https://foo.bar/path here'),'2: https scheme');
SELECT ok(public._comment_contains_link('visit www.scam.io now'),        '3: www host');
SELECT ok(public._comment_contains_link('go to scam.com please'),        '4: bare domain.com');
SELECT ok(public._comment_contains_link('reach me scam dot com'),        '5: worded "dot com"');
SELECT ok(public._comment_contains_link('it is scam(dot)com trust'),     '6: "(dot)" obfuscation');
SELECT ok(public._comment_contains_link('free at bit.ly/abc'),           '7: bit.ly shortener (ly not in TLD set)');
SELECT ok(public._comment_contains_link('join discord.gg/xyz'),          '8: discord.gg invite');
SELECT ok(public._comment_contains_link('dm t.me/scammer'),              '9: telegram t.me');
SELECT ok(public._comment_contains_link('sc' || chr(8203) || 'am.com'),  '10: zero-width-split domain');
-- negatives (must NOT trip)
SELECT ok(NOT public._comment_contains_link('Great video, learned a lot!'),         '11: plain praise');
SELECT ok(NOT public._comment_contains_link('Best book ever. Org meeting tomorrow'),'12: sentence break before "Org" is not a domain');
SELECT ok(NOT public._comment_contains_link('I rated it 9.5 out of 10'),            '13: decimal number');
SELECT ok(NOT public._comment_contains_link('e.g. this approach works'),            '14: "e.g." abbreviation');
SELECT ok(NOT public._comment_contains_link('connect the dot product idea'),        '15: worded "dot" not followed by a TLD');
SELECT ok(NOT public._comment_contains_link('see you a.m. tomorrow'),               '16: "a.m." abbreviation');
SELECT ok(NOT public._comment_contains_link(NULL),                                  '17: NULL body is not a link');
-- recall additions (audit C2/C3)
SELECT ok(public._comment_contains_link('grab it at freecoaching.online now'), '18: .online TLD (curated-set expansion, C2)');
SELECT ok(public._comment_contains_link('go to scamdotcom today'),             '19: tightly-embedded "scamdotcom" (C3)');
SELECT ok(public._comment_contains_link('reach ' || 'scam' || chr(183) || 'com'),'20: middle-dot glyph "scam·com" (C3)');
SELECT ok(public._comment_contains_link('email coachmike@gmail.com please'),   '21: bare email on a curated TLD');
-- precision guards for the new rules (must NOT trip)
SELECT ok(NOT public._comment_contains_link('remember the dotcom bubble crash'),'22: "dotcom" the word is NOT a domain (regression guard for rule-19)');
SELECT ok(NOT public._comment_contains_link('i love node.js for servers'),     '23: "node.js" (js not a TLD)');
-- documented ACCEPTED RESIDUAL: spaced literal dot is indistinguishable from a
-- sentence break, so it is intentionally NOT blocked (moderation/report backstop).
SELECT ok(NOT public._comment_contains_link('reach me at scam . com'),         '24: spaced-literal-dot is a documented known-miss (precision-first)');

-- ── (B) post_comment gate ────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_cu uuid := tests.create_auth_user('lk-creator@test');     -- owns the creator (moderator, exempt)
  v_cm uuid := tests.create_auth_user('lk-commenter@test');   -- ordinary viewer (gated)
  v_ad uuid := tests.create_auth_user('lk-admin@test');       -- admin (exempt)
  v_cid uuid; v_v1 uuid; v_top uuid; v_new uuid;
BEGIN
  PERFORM tests.reset_role();
  INSERT INTO public.admin_roles (user_id, email, role) VALUES (v_ad, 'lk-admin@test', 'superadmin');
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
    VALUES (v_cu, 'C', 'lkc', 'ready', 'v', 'f', 'x', now()) RETURNING id INTO v_cid;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_cid, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status) VALUES (v_cid, 'V1', 1, 'ready') RETURNING id INTO v_v1;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
    VALUES (v_v1, 1, 'mux_lk1', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_v1;

  -- 25. ordinary viewer posting a link → rejected.
  PERFORM tests.set_authenticated(v_cm);
  RETURN NEXT throws_like(format('SELECT public.post_comment(%L, %L)', v_v1, 'check bit.ly/scam'),
    '%link_not_allowed%', '25: ordinary viewer link rejected');

  -- 26. ordinary viewer clean comment → ok (returns a uuid).
  v_top := public.post_comment(v_v1, 'this lesson was genuinely helpful');
  RETURN NEXT ok(v_top IS NOT NULL, '26: ordinary viewer clean comment posts');

  -- 27. creator (moderator) may post a link in their own video.
  PERFORM tests.set_authenticated(v_cu);
  v_new := public.post_comment(v_v1, 'grab my course at mycourse.com');
  RETURN NEXT ok(v_new IS NOT NULL, '27: creator is exempt — link allowed');

  -- 28. admin is exempt too.
  PERFORM tests.set_authenticated(v_ad);
  v_new := public.post_comment(v_v1, 'official link: https://oakleague.com');
  RETURN NEXT ok(v_new IS NOT NULL, '28: admin is exempt — link allowed');

  -- 29. ordinary viewer reply containing a link → equally rejected (reply path).
  PERFORM tests.set_authenticated(v_cm);
  RETURN NEXT throws_like(format('SELECT public.post_comment(%L, %L, %L)', v_v1, 'dm me t.me/x', v_top),
    '%link_not_allowed%', '29: reply with a link rejected');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
