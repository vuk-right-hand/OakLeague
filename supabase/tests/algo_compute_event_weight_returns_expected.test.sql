-- Audit M3 (partial): single source of truth check for compute_event_weight.
-- Once the authenticated rollup trigger (migration 6, D2) calls this same
-- function, drift between anon + authenticated paths is structurally
-- impossible. This test pins the weight table so any future tuning
-- intentionally touches the expected values.
--
-- Full authenticated/anon parity test lands in D2 once the rollup trigger
-- can be fed the same event sequence.
BEGIN;
SELECT plan(15);

-- Base weights.
SELECT ok(
  abs(public.compute_event_weight('hook_impression', '{}'::jsonb) - 0.02) < 1e-6,
  '1: hook_impression = 0.02'
);
SELECT ok(
  abs(public.compute_event_weight('full_video_open', '{}'::jsonb) - 0.6) < 1e-6,
  '2: full_video_open = 0.6'
);
SELECT ok(
  abs(public.compute_event_weight('creator_carousel_open', '{}'::jsonb) - 0.4) < 1e-6,
  '3: creator_carousel_open = 0.4'
);
SELECT ok(
  abs(public.compute_event_weight('creator_carousel_hook_open', '{}'::jsonb) - 0.5) < 1e-6,
  '4: creator_carousel_hook_open = 0.5'
);

-- hook_dwell_end: completion_pct clamped to [-0.3, 1.0].
SELECT ok(
  abs(public.compute_event_weight('hook_dwell_end',
        jsonb_build_object('completion_pct', 0.5)) - 0.5) < 1e-6,
  '5: hook_dwell_end completion_pct=0.5 returns 0.5'
);
SELECT ok(
  abs(public.compute_event_weight('hook_dwell_end',
        jsonb_build_object('completion_pct', 1.5)) - 1.0) < 1e-6,
  '6: hook_dwell_end completion_pct=1.5 clamped to 1.0'
);

-- hook_swipe.
SELECT ok(
  abs(public.compute_event_weight('hook_swipe',
        jsonb_build_object('direction', 'right')) - 0.5) < 1e-6,
  '7: hook_swipe right = 0.5'
);
-- D5 H1: vertical 'up' is a return-scroll, neutral like horizontal 'left'.
-- Only 'down' (intentional next-video) falls into the dead-zone classifier.
SELECT ok(
  abs(public.compute_event_weight('hook_swipe',
        jsonb_build_object('direction', 'down',
          'seconds_to_decision_ms', 800, 'completion_pct', 0.05)) - (-0.3)) < 1e-6,
  '8: hook_swipe fast-dismiss (down, <2s, <20%) = -0.3 dead-zone'
);
SELECT ok(
  abs(public.compute_event_weight('hook_swipe',
        jsonb_build_object('direction', 'down',
          'seconds_to_decision_ms', 5000, 'completion_pct', 0.5)) - (-0.05)) < 1e-6,
  '9: hook_swipe slow dismiss (down) = -0.05 (weak negative)'
);
SELECT ok(
  abs(public.compute_event_weight('hook_swipe',
        jsonb_build_object('direction', 'up',
          'seconds_to_decision_ms', 800, 'completion_pct', 0.05)) - 0.0) < 1e-6,
  '14: hook_swipe up (return-scroll) = 0.0 even when fast — H1 fix'
);
SELECT ok(
  abs(public.compute_event_weight('hook_swipe',
        jsonb_build_object('direction', 'left')) - 0.0) < 1e-6,
  '15: hook_swipe left (horizontal-back) = 0.0 — symmetric to up'
);

-- full_video_quartile.
SELECT ok(
  abs(public.compute_event_weight('full_video_quartile',
        jsonb_build_object('quartile', 100)) - 1.0) < 1e-6,
  '10: full_video_quartile 100 = 1.0'
);
SELECT ok(
  abs(public.compute_event_weight('full_video_quartile',
        jsonb_build_object('quartile', 25)) - 0.2) < 1e-6,
  '11: full_video_quartile 25 = 0.2'
);

-- mic_tap.
SELECT ok(
  abs(public.compute_event_weight('mic_tap',
        jsonb_build_object('mic_tap_outcome', 'session_opened')) - 2.0) < 1e-6,
  '12: mic_tap session_opened = 2.0 (north-star event)'
);
SELECT ok(
  abs(public.compute_event_weight('mic_tap',
        jsonb_build_object('mic_tap_outcome', 'kill_switch_blocked')) - 0.3) < 1e-6,
  '13: mic_tap non-session_opened = 0.3'
);

SELECT * FROM finish();
ROLLBACK;
