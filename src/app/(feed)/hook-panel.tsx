'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import MuxVideo from '@mux/mux-video-react';
import type { FeedItem, VideoGroup } from './feed-types';
import { envelopeStorageKey } from '@/app/s/[id]/session-client';
import type { OpenEnvelope } from '@/lib/avatar/avatar-envelope';
import { recordFeedEvent } from '@/lib/feed/client-events';
import { captureSafe } from '@/lib/posthog-safe-capture';
import { useDeviceId } from '@/lib/feed/device-id';
import { AskErrorPill } from '@/lib/feed/ask-error-pill';
import { EnterPrivateRoomOverlay } from '@/components/session/EnterPrivateRoomOverlay';
import { holdEnterRoomBeat } from '@/lib/session/enter-timing';
import { useFeedImpressionTracker } from './feed-impression-context';
import { ReactButton } from '@/components/recording/ReactButton';
import { RecordingPreview } from '@/components/recording/RecordingPreview';
import { useRecordingController } from '@/lib/recording/recording-controller';
import { isReactCaptureEnabled } from '@/components/recording/react-button-state';

// Default wire-form model. Kept in sync with src/lib/voice/model-map.ts.
// If this changes, update isAllowedWireModel() to accept the new string.
const DEFAULT_VOICE_MODEL = 'gemini-3.1-flash-live-preview';

type Props = {
  hook: FeedItem;
  group: VideoGroup;
  shouldMount: boolean;
  shouldPlay: boolean;
  lessonIndex: number;
  totalLessons: number;
  isAuthenticated: boolean;
};

// Session-scoped "user has chosen sound" flag. Set once on the first
// tap-to-unmute. Read on every panel activation so even *fresh-mounted*
// videos (the lesson-0 of a row the user just scrolled to vertically)
// get unmuted right after play() resolves.
//
// Why this is needed even after the TikTok pattern: Chrome's "transient
// user activation" expires ~5s after the last tap/keypress. A fresh
// <video> element mounted past that window is treated as a new
// autoplay-with-sound decision and Chrome SILENTLY mutes the play()
// (promise still resolves; el.muted stays true). Persisting the user's
// preference + re-asserting el.muted = false post-play sidesteps this.
// Browsers permit toggling muted on an already-playing element without
// fresh activation.
function readSoundPreferenceSync(): boolean {
  // SSR: window absent, return false. Client: read sessionStorage
  // synchronously so the very first render sees the right value.
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem('oak_wants_sound') === '1';
  } catch {
    return false;
  }
}

function useSoundPreference(): [boolean, () => void] {
  // useState lazy initializer: runs once on mount, reads sessionStorage
  // synchronously. Eliminates the first-render race the previous
  // useEffect-based version had — the activation effect now sees the
  // correct wantsSound on the very first run, no second-commit catch-up
  // via mute-sync needed for the common "user previously chose sound"
  // path.
  const [wantsSound, setWantsSound] = useState(readSoundPreferenceSync);
  const grant = () => {
    setWantsSound(true);
    try { sessionStorage.setItem('oak_wants_sound', '1'); } catch { /* */ }
  };
  return [wantsSound, grant];
}

export function HookPanel({
  hook,
  group,
  shouldMount,
  shouldPlay,
  lessonIndex,
  totalLessons,
  isAuthenticated,
}: Props) {
  // Local UI state for the muted indicator. Starts true (every panel
  // mounts muted-autoplay-friendly), flips false once unmuted play()
  // succeeds. Drives the "Tap for sound" hint and nothing else.
  const [muted, setMuted] = useState(true);
  const [wantsSound, grantSound] = useSoundPreference();
  const deviceId = useDeviceId();
  const viewStartFiredRef = useRef(false);
  const impressionTracker = useFeedImpressionTracker();
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // Feature A — room mask, true from Ask-tap until /s/[id] navigation. Not reset
  // on success (route change unmounts it → no flash of the paused hook).
  const [entering, setEntering] = useState(false);
  // Audit S2: tap-to-pause after the unmute gesture (TikTok expectation).
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);

  // React/duet capture controller. Recording is gated by the flag at multiple
  // layers (button null-renders, permission lib throws 'disabled'). Active
  // surface only — `enabled` ties to shouldPlay so swiping away tears down.
  // Hook mode = the bottom-half source is THIS hook's <video> ref. Long-form
  // mode lives in long-form-player.tsx.
  const recording = useRecordingController({
    enabled: shouldPlay && shouldMount,
    mode: 'hook',
    // Ref-callback: controller reads at tap time (audit C1 day-2).
    getSourceVideoEl: () => playerRef.current,
    creatorHandle: group.creator.handle,
    // Static fallback URL — `oakl.gg` root (audit C2 cross-cutting Day 4:
    // `/<handle>` would be a 404 since no creator-drawer route exists yet).
    // Day 4: controller hits /api/recording/open-check and PATCHES with the
    // real shortUrl when the mint succeeds. Fallback only fires on cap-hit
    // / network error.
    referralUrl: 'oakl.gg',
    creatorId: group.creator.id,
    clipId: hook.hook_id,
  });

  // D5+: track played-seconds, not snapshot position.
  //
  // Earlier version computed completion_pct = currentTime / duration at the
  // moment of dwell-end. That gives wrong answers for two real cases:
  //   (a) Looped playback. User watches the whole 30s hook, then 6s into
  //       loop 2 swipes away. currentTime=6, duration=30 → 20% — but they
  //       actually watched 120% of the video. Loop replay is a strong
  //       satisfaction signal that was being thrown away.
  //   (b) Doorbell-pause case. dwell_ms keeps ticking while the panel is
  //       active, but if the user paused or the tab was backgrounded,
  //       no progress was made. Snapshot completion_pct under-reads.
  //
  // Fix: sum forward time-deltas while the video is actually playing.
  // Backwards jumps (loop boundary, manual scrub) reset the diff window
  // but don't double-count what we've already credited. Pauses don't
  // accumulate. Result: played_seconds / duration can exceed 1.0 for
  // repeat watches; rollup clamps in compute_event_weight, cooldown
  // logic (>= 0.8 → 3-day) routes loops correctly.
  const lastTimeRef = useRef<{ time: number; duration: number } | null>(null);
  const playedSecondsRef = useRef(0);
  const lastSampleTimeRef = useRef<number | null>(null);
  const handleTimeUpdate = useCallback(() => {
    const el = playerRef.current;
    if (!el) return;
    const t = el.currentTime;
    const duration = Number.isFinite(el.duration) ? el.duration : 0;
    if (duration > 0) {
      lastTimeRef.current = { time: t, duration };
    }
    const last = lastSampleTimeRef.current;
    // Accumulate only on a small forward step while playing. Cap at 1.5s
    // delta to ignore loop-jumps (currentTime resets near 0) and seek-jumps.
    if (last !== null && !el.paused && t > last && t - last < 1.5) {
      playedSecondsRef.current += t - last;
    }
    lastSampleTimeRef.current = t;
    if (duration > 0) {
      impressionTracker.recordCompletion(
        hook.hook_id,
        playedSecondsRef.current / duration,
      );
    }
  }, [impressionTracker, hook.hook_id]);

  // prefers-reduced-motion is for ANIMATION accessibility (page
  // transitions, smooth scrolling). It is NOT a signal to disable video
  // autoplay — TikTok / Instagram Reels / YouTube Shorts all autoplay
  // regardless. The earlier audit's "no autoplay on reduce-motion" was
  // wrong and broke the feed for any user who has the OS setting on.
  // Where it DOES apply (smooth-scroll → instant-scroll on arrow nav),
  // those callsites still consult window.matchMedia inline.

  // Activation lifecycle (per Mux's "Autoplay Considered Harmful" blog).
  //
  // Pattern: video element ALWAYS starts muted via the `muted` attribute
  // (rendered hardcoded in JSX below — never bound to React state). On
  // activation, call play() in a useEffect; the muted-autoplay path is
  // universally allowed by every browser. If the user has previously
  // unmuted this session, flip muted=false imperatively on the next frame
  // — the prior tap counts as page-level user activation, so this is
  // permitted. On deactivation, pause.
  //
  // We do NOT track muted in React state because:
  //   (a) The JSX `muted` attribute is set ONCE at mount; React never
  //       re-applies it because it never changes. No prop-vs-imperative
  //       race.
  //   (b) Visible UI ("Tap to unmute" overlay) is driven by the
  //       sessionStorage-backed `unmuted` preference, not the player's
  //       current mute state.
  //   (c) Without media-chrome (we use MuxVideo, not MuxPlayer), nothing
  //       else can change the mute state behind our back.
  // Read wantsSound through a ref inside the activation effect so the
  // effect doesn't depend on it (audit P1-B). Without this split, the
  // first tap-to-unmute (which calls grantSound) caused wantsSound to
  // flip true, which re-ran the activation effect, which reset
  // currentTime to 0 — visibly rewinding the video. Also caused two
  // hook_view_start fires per panel skewing Mux Data QoE.
  const wantsSoundRef = useRef(wantsSound);
  useEffect(() => {
    wantsSoundRef.current = wantsSound;
  }, [wantsSound]);

  // Activation effect: play/pause + currentTime reset. Reads wantsSound
  // via the ref, so it does NOT re-run on preference change.
  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    if (!shouldPlay) {
      el.pause?.();
      setPaused(false);
      return;
    }
    let cancelled = false;

    try { el.currentTime = 0; } catch { /* metadata not loaded yet */ }
    el.muted = !wantsSoundRef.current;

    const start = async () => {
      try {
        await el.play?.();
        if (cancelled) return;
        if (wantsSoundRef.current && el.muted) {
          el.muted = false;
        }
        if (!cancelled) setMuted(el.muted);
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'AbortError' || cancelled) return;
        el.muted = true;
        try {
          await el.play?.();
          if (!cancelled) setMuted(true);
        } catch (e) {
          if (cancelled) return;
          Sentry.captureException(e, {
            extra: {
              op: 'hook_panel_play_failed_muted',
              hook_id: hook.hook_id,
            },
          });
          // eslint-disable-next-line no-console
          console.warn('[hook-panel] play() failed even muted', {
            hook_id: hook.hook_id,
            error: String(e),
          });
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
  }, [shouldPlay, hook.hook_id]);

  // Mute-sync effect (audit P1-B). When `wantsSound` flips true while a
  // panel is already playing (handleTap → grantSound, or sessionStorage
  // hydration on first paint), unmute imperatively WITHOUT touching
  // currentTime. The activation effect doesn't see this dep, so the
  // video keeps playing from where it was.
  useEffect(() => {
    if (!shouldPlay || !wantsSound) return;
    const el = playerRef.current;
    if (!el || !el.muted) return;
    el.muted = false;
    setMuted(false);
  }, [wantsSound, shouldPlay]);

  useEffect(() => {
    if (!shouldPlay || viewStartFiredRef.current) return;
    viewStartFiredRef.current = true;
    // PostHog capture deferred to a dedicated client helper — stubbed here.
    // See plan §7 observability (hook_view_start).
    try {
      captureSafe('hook_view_start', {
        hook_id: hook.hook_id,
        video_id: hook.video_id,
        creator_id: hook.creator_id,
        lesson_number: hook.lesson_number,
      });
    } catch {
      /* noop */
    }
    // Feed event — one hook_impression per hook becoming the active lesson.
    // viewStartFiredRef guards within the HookPanel instance; the container-
    // level tracker (N1) guards against remount-and-refire if React
    // reconciliation blows the instance away mid-scroll. The RPC's
    // (user_id, event_name, idempotency_key) UNIQUE is the last safety net.
    if (impressionTracker.markIfNew(hook.hook_id)) {
      recordFeedEvent({
        event_name: 'hook_impression',
        hook_id: hook.hook_id,
        video_id: hook.video_id,
        creator_id: hook.creator_id,
        payload: { served_rank: hook.served_rank, lesson_number: hook.lesson_number },
      });
    }
    // D5: stamp activation time so a subsequent hook_swipe (fired from
    // VideoRow / FeedContainer when nav happens) can compute
    // seconds_to_decision_ms — needed for the dead-zone classifier.
    impressionTracker.markActivated(hook.hook_id);
    // Fresh activation = fresh played-seconds counter. Same instance can
    // reactivate (e.g., user swipes left back to a previous lesson).
    playedSecondsRef.current = 0;
    lastSampleTimeRef.current = null;
  }, [
    shouldPlay,
    hook.hook_id,
    hook.video_id,
    hook.creator_id,
    hook.lesson_number,
    hook.served_rank,
    impressionTracker,
  ]);

  // D5: hook_dwell_end on deactivation. Fires symmetrically to the
  // impression effect — once when shouldPlay flips back to false (or the
  // panel unmounts entirely). Reads completion_pct from the cached
  // (currentTime, duration) so a fast horizontal swipe past this lesson
  // (which can blank the player before the cleanup runs) still emits
  // a usable signal.
  //
  // Tab-close path (D5 prod-verify finding): React unmount cleanup is
  // unreliable when the browser kills the page on tab close — the
  // useEffect cleanup never runs and dwell_end is lost. The pagehide /
  // visibilitychange listeners below close that gap by firing the same
  // event synchronously into the queue, which client-events.ts then
  // flushes via sendBeacon before the page dies.
  const dwellFiredRef = useRef(false);
  useEffect(() => {
    if (!shouldPlay) return;
    dwellFiredRef.current = false;
    const startMs = Date.now();
    const fireDwellEnd = () => {
      if (dwellFiredRef.current) return;
      dwellFiredRef.current = true;
      const cached = lastTimeRef.current;
      // S1: lastTimeRef is null if MuxPlayer never fired onTimeUpdate (user
      // fast-scrolled past before the player buffered). completion_pct=0 is
      // the right answer there — they didn't dwell — and the rollup weight
      // for hook_dwell_end is COALESCE(...,0), which yields 0.0 (no
      // affinity move). No correctness issue.
      //
      // played-seconds-based completion. Can exceed 1.0 for loop replays
      // (e.g. 1.4 = watched 1.4× the video). compute_event_weight clamps
      // at 1.0 in the rollup, but we keep the raw value here so future
      // tuning + analytics see the real signal.
      const completionPct = cached && cached.duration > 0
        ? Math.max(0, playedSecondsRef.current / cached.duration)
        : 0;
      // C1: dwell_ms is the field the rollup trigger reads — not
      // seconds_visible. Without it, user_topic_affinity.dwell_ms_total
      // increments by 0 forever.
      recordFeedEvent({
        event_name: 'hook_dwell_end',
        hook_id: hook.hook_id,
        video_id: hook.video_id,
        creator_id: hook.creator_id,
        payload: {
          completion_pct: Number(completionPct.toFixed(3)),
          dwell_ms: Date.now() - startMs,
          lesson_number: hook.lesson_number,
        },
      });
    };
    const handlePageHide = () => fireDwellEnd();
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') fireDwellEnd();
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibility);
      // Normal React unmount path (lesson nav, row nav). Idempotent via
      // dwellFiredRef so we never double-emit if pagehide already fired.
      fireDwellEnd();
    };
  }, [shouldPlay, hook.hook_id, hook.video_id, hook.creator_id, hook.lesson_number]);

  const handleTap = () => {
    const el = playerRef.current;
    if (!el) return;
    // First tap on a muted panel: unmute current + persist preference so
    // every future activation (even fresh-mounted vertical-swipe panels)
    // automatically unmutes after their muted-autoplay bootstrap.
    if (el.muted) {
      el.muted = false;
      void el.play?.().catch(() => {});
      setMuted(false);
      setPaused(false);
      grantSound();
      return;
    }
    // Already unmuted: toggle play/pause (TikTok body-tap behavior).
    if (el.paused) {
      void el.play();
      setPaused(false);
    } else {
      el.pause();
      setPaused(true);
    }
  };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      <EnterPrivateRoomOverlay visible={entering} />
      {shouldMount ? (
        <MuxVideo
          key={hook.hook_id}
          ref={playerRef}
          playbackId={hook.mux_playback_id}
          streamType="on-demand"
          // Required for canvas.captureStream() to read pixels from the
          // <video> without tainting the canvas. Mux's stream.mux.com
          // serves CORS headers; without this attribute the duet recorder
          // would produce a silent / black blob (Plan §4a). Flag-gated
          // to match the Day-0 staged-rollout pattern.
          crossOrigin={
            isReactCaptureEnabled() ? ('anonymous' as const) : undefined
          }
          // No `autoPlay` attribute. Why: the HTML autoplay attribute
          // fires the moment the <video> element mounts, BEFORE our
          // activation effect can run pause() on a non-active panel
          // (shouldPlay=false). On Android Chrome we observed inactive
          // pre-mounted lessons quietly playing in the background for
          // 4-5 seconds before our pause() landed, leading to "first
          // swipe right → next lesson starts mid-playback." We drive
          // play() entirely from the activation effect now, so autoplay
          // is redundant for active panels and harmful for inactive ones.
          muted
          loop
          playsInline
          metadata={{
            video_id: hook.video_id,
            video_title: hook.video_title,
            player_name: 'oakleague-feed',
            viewer_user_id: deviceId ?? undefined,
          }}
          style={{
            width: '100%',
            height: '100%',
            // `contain` letterboxes when the viewport aspect-ratio doesn't
            // match the video (PC is 16:9 wide, hooks are 9:16 portrait,
            // so cover would crop ~70% of the frame and feel zoomed-in).
            // Mobile portrait viewers see the full frame; desktop sees
            // pillarboxed video centered on a black background, which is
            // the TikTok-on-PC norm.
            objectFit: 'contain',
            background: '#000',
          }}
          onTimeUpdate={handleTimeUpdate}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', background: '#111' }} />
      )}

      {/* Click-capture overlay. Plain <video> via MuxVideo has no shadow
          DOM controls fighting us, so this overlay's onClick reliably
          catches every tap. Ask button + askError pill at zIndex 2 stay
          tappable above this. Decorative overlays use pointerEvents:'none'. */}
      <div
        onClick={handleTap}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          background: 'transparent',
          cursor: 'pointer',
        }}
      />

      {/* Caption overlay */}
      {hook.hook_caption && (
        <div
          style={{
            position: 'absolute',
            bottom: 140,
            left: 16,
            right: 72,
            color: '#fff',
            fontSize: 15,
            lineHeight: 1.35,
            textShadow: '0 1px 2px rgba(0,0,0,0.8)',
            pointerEvents: 'none',
          }}
        >
          {hook.hook_caption}
        </div>
      )}

      {/* Creator + title */}
      <div
        style={{
          position: 'absolute',
          bottom: 90,
          left: 16,
          right: 72,
          pointerEvents: 'none',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
          @{group.creator.handle}
        </div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>{hook.video_title}</div>
      </div>

      {/* Lesson pager */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          right: 16,
          display: 'flex',
          gap: 4,
          pointerEvents: 'none',
        }}
      >
        {Array.from({ length: totalLessons }).map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 2,
              background: i === lessonIndex ? '#fff' : 'rgba(255,255,255,0.35)',
              borderRadius: 1,
            }}
          />
        ))}
      </div>

      {/* Long-form pill — only renders when the parent video has a ready +
          published long-form asset (long_form_available is computed in
          feed_ranked_page from videos.long_form_*). Hook-only videos
          never show the pill. router.push() is correct: this is in-app
          navigation, not an auth-affecting transition. */}
      {hook.long_form_available && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/v/${hook.video_id}?from=${hook.hook_id}`);
          }}
          style={{
            position: 'absolute',
            right: 16,
            bottom: 156,
            padding: '8px 12px',
            borderRadius: 16,
            background: 'rgba(255,255,255,0.12)',
            border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 500,
            zIndex: 2,
            cursor: 'pointer',
          }}
          aria-label={`Chat with @${group.creator.handle} — full lesson`}
        >
          Chat with @{group.creator.handle}
        </button>
      )}

      {/* Ask button — opens a voice session and routes to /s/[id].
          Hidden when anon AND long_form_available: the long-form pill
          above ("Chat with @handle") is the singular CTA in that state,
          and conversion to /login happens inside the long-form viewer's
          own Ask. For anon WITHOUT long-form, this button shows "Sign up
          to chat with @handle" → window.location.href = '/login' (no API
          round-trip). For auth, this hits /api/sessions/open; on 401 we
          use window.location.href (CLAUDE.md hard rule). The /s/[id]
          success path stays on router.push (not auth-affecting). */}
      {(isAuthenticated || !hook.long_form_available) && (
      <button
        type="button"
        disabled={asking}
        onClick={async (e) => {
          e.stopPropagation();
          if (asking) return;
          captureSafe('hook_ask_clicked', {
            hook_id: hook.hook_id,
            creator_id: hook.creator_id,
            authenticated: isAuthenticated,
          });

          // Anon path: skip the API entirely. Record the auth_required
          // mic_tap so the algo sees signed-out interest, then full-page
          // reload to /login (hard-rule).
          if (!isAuthenticated) {
            recordFeedEvent({
              event_name: 'mic_tap',
              hook_id: hook.hook_id,
              video_id: hook.video_id,
              creator_id: hook.creator_id,
              payload: { mic_tap_outcome: 'auth_required' },
            });
            window.location.href = '/login';
            return;
          }

          setAsking(true);
          setAskError(null);
          setEntering(true); // show the room mask immediately on tap
          // Freeze the hook behind the mask — audio must not keep playing
          // under the "private room" overlay (audit M5). Resumed on failure.
          const hookWasPlaying = !!playerRef.current && !playerRef.current.paused;
          try { playerRef.current?.pause(); } catch { /* */ }
          const enterStartedAt = performance.now();
          try {
            const r = await fetch('/api/sessions/open', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                creator_id: hook.creator_id,
                hook_id: hook.hook_id,
                model: DEFAULT_VOICE_MODEL,
              }),
            });
            if (!r.ok) {
              const body = (await r.json().catch(() => ({}))) as { error?: string };
              const outcome =
                body?.error === 'creator_voice_not_trained' ? 'creator_voice_not_trained'
                : body?.error === 'creator_not_ready' ? 'creator_not_ready'
                : body?.error === 'rate_limited' || r.status === 429 ? 'kill_switch_blocked'
                : body?.error === 'unauthorized' || r.status === 401 ? 'auth_required'
                : 'unknown_error';
              recordFeedEvent({
                event_name: 'mic_tap',
                hook_id: hook.hook_id,
                video_id: hook.video_id,
                creator_id: hook.creator_id,
                payload: { mic_tap_outcome: outcome },
              });
              // Phase C B1.4: cap-hit funnel signal (cap → /upgrade). Fires
              // ONLY for the new HTTP-429 'daily_cap_hit' surface introduced
              // by the rewire's pre-mint cap RPC — distinct from the 5-live-
              // tickets `rate_limited` 429 (which is abuse-rate-limit, not
              // cap exhaustion). Funnel measurement is on PostHog where the
              // upgrade conversion is tracked; recordFeedEvent above stays
              // for feed-side analytics.
              if (body?.error === 'daily_cap_hit') {
                captureSafe('daily_cap_hit', {
                  surface: 'hook',
                  creator_id: hook.creator_id,
                  hook_id: hook.hook_id,
                });
              }
              // CLAUDE.md hard rule: auth-affecting nav must full-page reload.
              // Cookie state can be stale post-login otherwise.
              if (r.status === 401) { window.location.href = '/login'; return; }
              setEntering(false); // drop the room mask so the error pill shows
              if (hookWasPlaying) { try { void playerRef.current?.play(); } catch { /* */ } }
              setAskError(body?.error ?? `error_${r.status}`);
              return;
            }
            const env = (await r.json()) as OpenEnvelope;
            recordFeedEvent({
              event_name: 'mic_tap',
              hook_id: hook.hook_id,
              video_id: hook.video_id,
              creator_id: hook.creator_id,
              session_id_if_opened: env.session_id,
              payload: { mic_tap_outcome: 'session_opened' },
            });
            try {
              sessionStorage.setItem(envelopeStorageKey(env.session_id), JSON.stringify(env));
            } catch { /* sessionStorage blocked — next page shows "expired" */ }
            // Hold the room mask for the minimum beat, then navigate; the route
            // change unmounts the overlay (intentionally not cleared here).
            await holdEnterRoomBeat(enterStartedAt);
            router.push(`/s/${env.session_id}`);
          } catch {
            setEntering(false);
            if (hookWasPlaying) { try { void playerRef.current?.play(); } catch { /* */ } }
            setAskError('network');
          } finally {
            setAsking(false);
          }
        }}
        style={{
          position: 'absolute',
          right: 16,
          bottom: 90,
          width: isAuthenticated ? 56 : undefined,
          height: 56,
          minWidth: isAuthenticated ? undefined : 0,
          padding: isAuthenticated ? 0 : '0 16px',
          borderRadius: 28,
          background: 'rgba(255,255,255,0.15)',
          border: '1px solid rgba(255,255,255,0.4)',
          color: '#fff',
          fontSize: isAuthenticated ? 12 : 13,
          fontWeight: 600,
          opacity: asking ? 0.6 : 1,
          zIndex: 2,
          whiteSpace: 'nowrap',
        }}
        aria-label={
          isAuthenticated
            ? 'Ask this creator'
            : `Sign up to chat with @${group.creator.handle}`
        }
      >
        {asking ? '…' : isAuthenticated ? 'Ask' : `Sign up to chat with @${group.creator.handle}`}
      </button>
      )}

      {/* React/duet capture button. Null-renders when the kill-switch
          (NEXT_PUBLIC_REACT_CAPTURE_ENABLED) is off. Positioned to the
          left of Ask; same vertical band so the two siblings read as a
          pair of CTAs. Gated on shouldPlay && shouldMount (audit C3
          day-2) so off-screen scrolled-past panels don't render extra
          tappable buttons that an event-delegation harness could trigger.
          The controller's `enabled` watcher also handles swipe→TEARDOWN. */}
      {isAuthenticated && shouldPlay && shouldMount && (
        <div
          style={{
            position: 'absolute',
            right: 76,
            bottom: 100,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <ReactButton {...recording.buttonProps} />
        </div>
      )}

      <RecordingPreview
        preview={recording.preview}
        onDismiss={recording.dismissPreview}
        onDiscard={recording.discardByUser}
      />


      <div
        style={{
          position: 'absolute',
          right: 16,
          bottom: hook.long_form_available ? 200 : 156,
          zIndex: 2,
        }}
      >
        <AskErrorPill error={askError} />
      </div>

      {/* "Tap for sound" hint. Only shown when the browser refused
          unmuted autoplay (typically just the very first panel before
          any user interaction). Once `muted` flips false on a successful
          unmuted play(), the hint disappears for good. */}
      {muted && shouldPlay && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 20,
            fontSize: 13,
            pointerEvents: 'none',
          }}
        >
          Tap for sound
        </div>
      )}

      {/* Pause indicator — visible only when user has explicitly paused. */}
      {paused && !muted && shouldPlay && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            padding: '10px 16px',
            borderRadius: 24,
            fontSize: 14,
            pointerEvents: 'none',
          }}
          aria-live="polite"
        >
          Paused
        </div>
      )}
    </div>
  );
}
