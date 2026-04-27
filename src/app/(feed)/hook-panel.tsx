'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import MuxPlayer from '@mux/mux-player-react';
import type { FeedItem, VideoGroup } from './feed-types';
import { envelopeStorageKey } from '@/app/s/[id]/session-client';
import { recordFeedEvent } from '@/lib/feed/client-events';
import { useFeedImpressionTracker } from './feed-impression-context';

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
};

// Session-scoped unmute preference. First tap unmutes for the whole session.
function useUnmutePreference(): [boolean, () => void] {
  const [unmuted, setUnmuted] = useState<boolean>(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('oak_unmuted') === '1') setUnmuted(true);
    } catch {
      // sessionStorage blocked — stay muted.
    }
  }, []);

  const unmute = () => {
    setUnmuted(true);
    try {
      sessionStorage.setItem('oak_unmuted', '1');
    } catch {
      /* noop */
    }
  };
  return [unmuted, unmute];
}

// Audit S9: stable per-device id so Mux Data can bucket QoE by viewer
// instead of lumping every anon viewer into one id. Persists across
// sessions; scope is the browser profile.
function useDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    try {
      let existing = localStorage.getItem('oak_device_id');
      if (!existing) {
        existing = `anon_${crypto.randomUUID()}`;
        localStorage.setItem('oak_device_id', existing);
      }
      setId(existing);
    } catch {
      setId(null);
    }
  }, []);
  return id;
}

export function HookPanel({
  hook,
  group,
  shouldMount,
  shouldPlay,
  lessonIndex,
  totalLessons,
}: Props) {
  const [unmuted, unmute] = useUnmutePreference();
  const deviceId = useDeviceId();
  const viewStartFiredRef = useRef(false);
  const impressionTracker = useFeedImpressionTracker();
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // Audit S2: tap-to-pause after the unmute gesture (TikTok expectation).
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);

  // D5: keep the most recent (currentTime, duration) so dwell_end has a
  // completion_pct even if the MuxPlayer has already unmounted by the time
  // the cleanup runs (shouldMount window narrows to ±1 lesson, so a
  // 2-step horizontal swipe blanks the player before deactivation fires).
  // M1: also push the latest pct into the container-scope tracker so
  // VideoRow / FeedContainer can read it when emitting hook_swipe payloads
  // (otherwise the dead-zone classifier sees completion_pct=0 and misfires).
  const lastTimeRef = useRef<{ time: number; duration: number } | null>(null);
  const handleTimeUpdate = useCallback(() => {
    const el = playerRef.current;
    if (!el) return;
    const duration = Number.isFinite(el.duration) ? el.duration : 0;
    if (duration > 0) {
      lastTimeRef.current = { time: el.currentTime, duration };
      impressionTracker.recordCompletion(hook.hook_id, el.currentTime / duration);
    }
  }, [impressionTracker, hook.hook_id]);

  // Audit M4: if the viewer prefers reduced motion, don't autoplay.
  // Require an explicit tap to start the video.
  const reduceMotionRef = useRef(false);
  useEffect(() => {
    reduceMotionRef.current =
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const autoPlayValue: 'muted' | false =
    shouldPlay && !reduceMotionRef.current ? 'muted' : false;

  useEffect(() => {
    if (!shouldPlay || viewStartFiredRef.current) return;
    viewStartFiredRef.current = true;
    // PostHog capture deferred to a dedicated client helper — stubbed here.
    // See plan §7 observability (hook_view_start).
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).posthog?.capture?.('hook_view_start', {
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
      const completionPct = cached && cached.duration > 0
        ? Math.max(0, Math.min(1, cached.time / cached.duration))
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
    if (!unmuted) {
      // Imperative unmute: flip the element's `muted` property directly
      // INSIDE the click handler so the audio change happens within the
      // user-gesture window the browser autoplay policy requires. Setting
      // the React `muted` prop alone is unreliable here — MuxPlayer can
      // treat its `muted` prop as a one-shot at mount, and React's render
      // batching can defer the flush until after the gesture has expired,
      // so audio never actually unmutes.
      if (el) {
        el.muted = false;
        // Best-effort resume. If the player was already playing, this is
        // a no-op; if Mux paused on the muted-prop change, this restores.
        void el.play?.().catch(() => {});
      }
      unmute();
      setPaused(false);
      return;
    }
    // Audit S2: after the unmute gesture has landed, tap toggles play/pause.
    if (!el) return;
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
      {shouldMount ? (
        <MuxPlayer
          key={hook.hook_id}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={playerRef as any}
          playbackId={hook.mux_playback_id}
          streamType="on-demand"
          autoPlay={autoPlayValue}
          muted={!unmuted}
          loop
          playsInline
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({ metadata: {
            video_id: hook.video_id,
            video_title: hook.video_title,
            player_name: 'oakleague-feed',
            viewer_user_id: deviceId,
          } } as any)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          onClick={handleTap}
          onTimeUpdate={handleTimeUpdate}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', background: '#111' }} />
      )}

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

      {/* Ask button — opens a voice session and routes to /s/[id].
          router.push() is correct per CLAUDE.md: the hard-rule requirement
          for window.location.href applies to login/signup/role/tier change;
          session creation is none of those. (R3-S9) */}
      <button
        type="button"
        disabled={asking}
        onClick={async (e) => {
          e.stopPropagation();
          if (asking) return;
          setAsking(true);
          setAskError(null);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).posthog?.capture?.('hook_ask_clicked', {
              hook_id: hook.hook_id,
              creator_id: hook.creator_id,
            });
          } catch { /* noop */ }
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
              // Map response.body.error → mic_tap_outcome enum (migration
              // 0503-01). Fire BEFORE the /login redirect so an
              // auth_required outcome lands in the rollup too — otherwise
              // every signed-out tap on Ask is invisible to the algo.
              const outcome =
                body?.error === 'creator_not_ready' ? 'creator_not_ready'
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
              if (r.status === 401) { router.push('/login'); return; }
              setAskError(body?.error ?? `error_${r.status}`);
              return;
            }
            const env = (await r.json()) as {
              session_id: string;
              tier: string;
              avatar: unknown;
              avatar_status: string;
              gemini: { token: string; model: string };
              max_duration_s: number;
              max_session_s: number;
            };
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
            router.push(`/s/${env.session_id}`);
          } catch {
            setAskError('network');
          } finally {
            setAsking(false);
          }
        }}
        style={{
          position: 'absolute',
          right: 16,
          bottom: 90,
          width: 56,
          height: 56,
          borderRadius: 28,
          background: 'rgba(255,255,255,0.15)',
          border: '1px solid rgba(255,255,255,0.4)',
          color: '#fff',
          fontSize: 12,
          fontWeight: 600,
          opacity: asking ? 0.6 : 1,
        }}
        aria-label="Ask this creator"
      >
        {asking ? '…' : 'Ask'}
      </button>
      {askError && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            right: 16,
            bottom: 156,
            background: 'rgba(255,255,255,0.95)',
            color: '#111',
            fontSize: 11,
            padding: '6px 10px',
            borderRadius: 10,
            maxWidth: 200,
          }}
        >
          Couldn&apos;t start session: {askError === 'kill_switch_fired' ? 'Daily limit reached' : askError}
        </div>
      )}

      {/* Unmute hint */}
      {!unmuted && shouldPlay && (
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
          Tap to unmute
        </div>
      )}

      {/* Pause indicator — visible only when user has explicitly paused. */}
      {paused && unmuted && shouldPlay && (
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
