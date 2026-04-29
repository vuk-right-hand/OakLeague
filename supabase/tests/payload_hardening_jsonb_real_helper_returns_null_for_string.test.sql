-- 0504-05 hardening: _jsonb_real returns NULL on string value (no SQLSTATE).
BEGIN;
SELECT plan(4);

SELECT is(
  public._jsonb_real(jsonb_build_object('p', 0.85), 'p'),
  0.85::real,
  '1: numeric value returns real'
);

SELECT is(
  public._jsonb_real(jsonb_build_object('p', '0.85'), 'p'),
  NULL::real,
  '2: string value returns NULL (would have crashed pre-hardening)'
);

SELECT is(
  public._jsonb_real(jsonb_build_object('p', null), 'p'),
  NULL::real,
  '3: null value returns NULL'
);

SELECT is(
  public._jsonb_real('{}'::jsonb, 'p'),
  NULL::real,
  '4: missing key returns NULL'
);

SELECT * FROM finish();
ROLLBACK;
