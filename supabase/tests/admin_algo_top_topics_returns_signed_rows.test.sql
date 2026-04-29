-- top_topics returns sign='positive'|'neutral'|'negative' based on
-- affinity_score sign. Negative-affinity row appears with sign='negative'.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-sign-admin@test');
  v_user  uuid := tests.create_auth_user('algo-sign-user@test');
  v_pos_sign text;
  v_neg_sign text;
  v_zero_sign text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-sign-admin@test', 'superadmin');

  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'cold_outreach', 1.5),
           (v_user, 'saas_pricing', -0.3),
           (v_user, 'misc',          0);

  PERFORM tests.set_authenticated(v_admin);

  SELECT sign INTO v_pos_sign  FROM public.admin_algo_top_topics(v_user, 5)
   WHERE topic_slug = 'cold_outreach';
  SELECT sign INTO v_neg_sign  FROM public.admin_algo_top_topics(v_user, 5)
   WHERE topic_slug = 'saas_pricing';
  SELECT sign INTO v_zero_sign FROM public.admin_algo_top_topics(v_user, 5)
   WHERE topic_slug = 'misc';

  RETURN NEXT is(v_pos_sign,  'positive', '1: positive affinity → positive');
  RETURN NEXT is(v_neg_sign,  'negative', '2: negative affinity → negative');
  RETURN NEXT is(v_zero_sign, 'neutral',  '3: zero affinity → neutral');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
