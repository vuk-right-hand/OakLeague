-- 0504-05 hardening: _jsonb_int returns NULL on string value (no SQLSTATE).
BEGIN;
SELECT plan(4);

SELECT is(
  public._jsonb_int(jsonb_build_object('q', 100), 'q'),
  100,
  '1: numeric value returns int'
);

SELECT is(
  public._jsonb_int(jsonb_build_object('q', '100'), 'q'),
  NULL::int,
  '2: string value returns NULL (would have crashed pre-hardening)'
);

SELECT is(
  public._jsonb_int(jsonb_build_object('q', null), 'q'),
  NULL::int,
  '3: null value returns NULL'
);

SELECT is(
  public._jsonb_int('{}'::jsonb, 'q'),
  NULL::int,
  '4: missing key returns NULL'
);

SELECT * FROM finish();
ROLLBACK;
