-- Seed rows == helper hardcoded fallback, key for key (audit M-R2-3 drift
-- guard). Expectations are DERIVED: capture the seeded table, empty it, and
-- compare against _feed_algo_weights_jsonb()'s fallback output — never a
-- third hardcoded list. (0613-01)
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_seeded   jsonb;
  v_fallback jsonb;
  v_key      text;
  v_mismatch text := '';
BEGIN
  SELECT jsonb_object_agg(weight_key, weight_value)
    INTO v_seeded FROM public.feed_algo_weights;

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.feed_algo_weights), 11,
    '1: exactly 11 seeded weight rows'
  );

  DELETE FROM public.feed_algo_weights;
  v_fallback := public._feed_algo_weights_jsonb();

  RETURN NEXT is(
    (SELECT count(*)::int FROM jsonb_object_keys(v_fallback)), 11,
    '2: helper fallback exposes exactly 11 keys'
  );

  FOR v_key IN SELECT jsonb_object_keys(v_fallback) LOOP
    IF v_seeded->>v_key IS NULL
       OR abs((v_seeded->>v_key)::real - (v_fallback->>v_key)::real) > 1e-6 THEN
      v_mismatch := v_mismatch || v_key || ' ';
    END IF;
  END LOOP;

  RETURN NEXT is(
    v_mismatch, '',
    '3: every helper fallback value matches its seeded row (drift = ' || v_mismatch || ')'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
