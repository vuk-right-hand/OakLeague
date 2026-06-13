-- feed_ranked_page latency benchmark — measures the dominant feed cost (the
-- 3-way retrieval pool blend + dual compute_hook_score scoring + slate
-- diversity re-rank) as the catalog grows. The scalability claim under test:
-- because the candidate pool is capped (120+50+30 = ~200 pre-dedup ceiling)
-- before scoring, per-page latency should grow SUB-LINEARLY with catalog size
-- — the only catalog-linear term is the hook_global_stats LEFT JOIN over the
-- filtered base, which is an index-backed scan.
--
-- Timing runs under SET LOCAL ROLE authenticated so the hooks_public RLS
-- policy (security_invoker) executes exactly as it does for a real request —
-- seeding stays as the superuser caller (the loop toggles role around the
-- measured block only).
--
-- Run (worktree DB, leaves DB untouched — wrapped in BEGIN/ROLLBACK):
--   Get-Content scripts/feed_ranked_page_bench.sql -Raw |
--     docker exec -i supabase_db_oakleague psql -U postgres -d postgres
-- Or against any target: psql "$DATABASE_URL" -f scripts/feed_ranked_page_bench.sql
--
-- Caller is a fresh regime-A user, so BOTH the exploit and explore
-- compute_hook_score passes run per candidate (the real per-page worst case).
-- 5 creators so the diversity interleave is exercised, not the N=1 no-op.

\set ON_ERROR_STOP on
BEGIN;

DO $bench$
DECLARE
  K          constant int := 25;
  v_scales   int[] := ARRAY[100, 300, 600, 1000, 2000];
  v_creators uuid[] := '{}';
  v_cu       uuid;
  v_creator  uuid;
  v_caller   uuid;
  v_video    uuid;
  v_target   int;
  v_seeded   int := 0;
  v_ci       int := 0;
  v_h        int;
  i          int;
  t0         timestamptz;
  t1         timestamptz;
  v_durs     numeric[];
  v_avg      numeric;
  v_p95      numeric;
  v_min      numeric;
  v_max      numeric;
  v_rows     int;
BEGIN
  v_caller := tests.create_auth_user('bench-caller@test');
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_caller)::text, true);

  FOR i IN 1..5 LOOP
    v_cu := tests.create_auth_user('bench-c' || i || '@test');
    UPDATE public.profiles SET handle = 'benchc' || i WHERE id = v_cu;
    INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
      VALUES (v_cu, 'BenchCreator' || i, 'benchc' || i, 'ready', now())
      RETURNING id INTO v_creator;
    INSERT INTO public.creator_topics (creator_id, slug, title)
      VALUES (v_creator, 'cold_outreach', 'Cold Outreach');
    v_creators := v_creators || v_creator;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'feed_ranked_page latency vs catalog (% warm iters/scale, fresh regime-A caller, 5 creators)', K;
  RAISE NOTICE ' catalog |  avg ms |  p95 ms |  min ms |  max ms';
  RAISE NOTICE ' --------+---------+---------+---------+--------';

  FOREACH v_target IN ARRAY v_scales LOOP
    WHILE v_seeded < v_target LOOP
      v_ci := (v_ci % 5) + 1;
      INSERT INTO public.videos (creator_id, title, lesson_count, status)
        VALUES (v_creators[v_ci], 'V' || v_seeded, 5, 'ready')
        RETURNING id INTO v_video;
      FOR v_h IN 1..5 LOOP
        v_seeded := v_seeded + 1;
        INSERT INTO public.hooks
          (video_id, lesson_number, mux_playback_id, duration_seconds,
           topic_tags, mux_status, published_at, created_at)
          -- is_seed_content omitted → DEFAULT false → visible in hooks_public.
          VALUES (v_video, v_h, 'bench_' || v_seeded, 30, ARRAY['cold_outreach'],
                  'ready', now() - (v_seeded || ' seconds')::interval,
                  now() - (v_seeded || ' seconds')::interval);
      END LOOP;
      UPDATE public.videos SET published_at = now() WHERE id = v_video;
    END LOOP;

    -- Measure as the authenticated invoker so hooks_public RLS is in the plan.
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- warm the plan + shared buffers before timing
    PERFORM count(*) FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);

    v_durs := '{}';
    FOR i IN 1..K LOOP
      t0 := clock_timestamp();
      PERFORM count(*) FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);
      t1 := clock_timestamp();
      v_durs := v_durs || (extract(epoch FROM (t1 - t0)) * 1000.0)::numeric;
    END LOOP;

    EXECUTE 'RESET ROLE';   -- back to superuser for the next scale's seeding

    SELECT avg(d), percentile_cont(0.95) WITHIN GROUP (ORDER BY d), min(d), max(d)
      INTO v_avg, v_p95, v_min, v_max
      FROM unnest(v_durs) AS d;

    RAISE NOTICE ' % | % | % | % | %',
      lpad(v_target::text, 7),
      lpad(round(v_avg, 2)::text, 7),
      lpad(round(v_p95, 2)::text, 7),
      lpad(round(v_min, 2)::text, 7),
      lpad(round(v_max, 2)::text, 7);
  END LOOP;

  SELECT count(*) INTO v_rows FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);
  RAISE NOTICE '';
  RAISE NOTICE 'sanity: top-scale page returned % rows (expect 10)', v_rows;
  RAISE NOTICE 'note: local Docker-on-Windows numbers are a lower bound on '
               'speed; prod Postgres on warm indexes is faster. Watch the '
               'SHAPE (sub-linear growth), not the absolute ms.';
END
$bench$;

ROLLBACK;
