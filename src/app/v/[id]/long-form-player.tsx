'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import MuxVideo from '@mux/mux-video-react';
import { recordFeedEvent } from '@/lib/feed/client-events';
import { useDeviceId } from '@/lib/feed/device-id';
import { AskErrorPill } from '@/lib/feed/ask-error-pill';
import { envelopeStorageKey } from '@/app/s/[id]/session-client';
import { ReactButton } from '@/components/recording/ReactButton';
import { RecordingPreview } from '@/components/recording/RecordingPreview';
import { useRecordingController } from '@/lib/recording/recording-controller';
import { isReactCaptureEnabled } from '@/components/recording/react-button-state';
import {
  crossedQuartiles,
  takeBfcacheBaseline,
  shouldFinalizeOnPagehide,
  type Quartile,
} from './quartile-tracker';

const DEFAULT_VOICE_MODEL = 'gemini-3.1-flash-live-preview';

type Props = {
  videoId: string;
  creatorId: string;
  creatorHandle: string;
  creatorName: string;
  creatorAvatar: string | null;
  videoTitle: string;
  videoDescription: string | null;
  muxPlaybackId: string;
  durationSeconds: number | null;
  /** UUID of the hook the user came from (?from=<id>). null if absent or
      cross-video forged. Used as hook_id on full_video_open / quartile
      events for telemetry attribution; Pass B cooldown keys on video_id
      so null is safe. */
  entryHookId: string | null;
  isAuthenticated: boolean;
};

export function LongFormPlayer({
  videoId,
  creatorId,
  creatorHandle,
  creatorName,
  creatorAvatar,
  videoTitle,
  muxPlaybackId,
  durationSeconds,
  entryHookId,
  isAuthenticated,
}: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const deviceId = useDeviceId();

  // "Tap for sound" overlay state — closes the C5 audit watch-point.
  // The activation effect tries unmuted play(); on NotAllowedError
  // (iOS Safari without a fresh gesture, or autoplay-restricted Chrome)
  // we fall back to el.muted=true and surface this overlay. A tap on
  // the overlay re-asserts el.muted=false and play(); the overlay then
  // dismisses. Without this, the muted-fallback would silently keep the
  // user on a silent video forever.
  const [needsSoundTap, setNeedsSoundTap] = useState(false);

  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  // Long-form duet capture. Same pipeline as hook-mode; the source video
  // is the long-form HLS stream. Only mounts when the user is authed +
  // the kill-switch is on (button null-renders otherwise).
  const recording = useRecordingController({
    enabled: isAuthenticated,
    mode: 'longform',
    // Ref-callback so the controller reads videoRef.current at tap time
    // (audit C1 day-2 — long-form viewer has no constant-rerender driver
    // and the controller's onTap closure could otherwise lock to null).
    getSourceVideoEl: () => videoRef.current,
    creatorHandle,
    // Static fallback URL — controller patches with the real shortUrl from
    // /api/recording/open-check on successful mint (Day 4).
    referralUrl: `oakl.gg/${creatorHandle}`,
    creatorId,
    clipId: videoId,
  });

  // Quartile tracker (audit M3 + M5).
  // - firedRef: which quartiles have already been emitted in this mount.
  // - lastSampleRef: previous timeupdate currentTime; null on first tick.
  // - bfcacheBaselineRef: true once we've pre-marked passed quartiles on
  //   bfcache restore (or a route-stack-pop landing mid-video). Phantom
  //   emits are suppressed; the user's prior session already emitted real
  //   quartile events so the cooldown record exists.
  const firedRef = useRef<Set<Quartile>>(new Set());
  const lastSampleRef = useRef<number | null>(null);
  const bfcacheBaselineRef = useRef<boolean>(false);

  const fireQuartile = useCallback(
    (q: Quartile) => {
      if (firedRef.current.has(q)) return;
      firedRef.current.add(q);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).posthog?.capture?.('long_form_quartile', {
          video_id: videoId,
          quartile: q,
        });
      } catch { /* noop */ }
      recordFeedEvent({
        event_name: 'full_video_quartile',
        hook_id: entryHookId ?? undefined,
        video_id: videoId,
        creator_id: creatorId,
        payload: { quartile: q, source: 'pill' },
      });
    },
    [videoId, creatorId, entryHookId],
  );

  // Mount-once: full_video_open. Fires exactly once per mount; the dep
  // array is intentionally [] — re-firing on a navigation revisit is the
  // right semantic (each visit is a fresh "open" event).
  useEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).posthog?.capture?.('long_form_open', {
        video_id: videoId,
        entry_hook_id: entryHookId,
      });
    } catch { /* noop */ }
    recordFeedEvent({
      event_name: 'full_video_open',
      hook_id: entryHookId ?? undefined,
      video_id: videoId,
      creator_id: creatorId,
      payload: { source: 'pill' },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Activation effect (audit C5). Mount-once. NO shouldPlay-flip handling
  // (long-form is single-instance). NO currentTime reset (would destroy
  // user scrub on bfcache-restore or route-stack-pop). NO read of
  // 'oak_wants_sound' (feed-only flag; pill-tap is a deliberate
  // tap-through and should default unmuted).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let cancelled = false;

    el.muted = false;
    const tryPlay = async () => {
      try {
        await el.play();
        if (!cancelled) setNeedsSoundTap(false);
      } catch (err) {
        if (cancelled) return;
        const name = (err as { name?: string })?.name;
        if (name === 'AbortError') return;
        // NotAllowedError (or any other autoplay-policy refusal):
        // fall back to muted, retry play(), surface the "Tap for sound"
        // overlay so the user can recover. Without this overlay, iOS
        // Safari users would watch silently forever.
        el.muted = true;
        try {
          await el.play();
          if (!cancelled) setNeedsSoundTap(true);
        } catch (e) {
          if (cancelled) return;
          Sentry.captureException(e, {
            extra: { op: 'long_form_player_play_failed_muted', video_id: videoId },
          });
        }
      }
    };
    void tryPlay();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Quartile tracker. Crossing + baseline logic lives in pure helpers
  // (./quartile-tracker.ts) so the gates are unit-testable without jsdom.
  const onTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const curr = el.currentTime;
    const prev = lastSampleRef.current;
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    if (prev === null && !bfcacheBaselineRef.current) {
      const baseline = takeBfcacheBaseline({ duration, curr });
      for (const q of baseline) firedRef.current.add(q);
      bfcacheBaselineRef.current = true;
      lastSampleRef.current = curr;
      return;
    }

    if (prev !== null) {
      const crosses = crossedQuartiles({
        duration,
        prev,
        curr,
        fired: firedRef.current,
      });
      for (const q of crosses) fireQuartile(q);
    }
    lastSampleRef.current = curr;
  }, [fireQuartile]);

  const onEnded = useCallback(() => {
    setEnded(true);
    if (!firedRef.current.has(100)) fireQuartile(100);
  }, [fireQuartile]);

  // Pagehide / visibilitychange backstop (audit M6). Closes the iOS gap
  // where `ended` doesn't fire if the user closes the tab in the last
  // few seconds of a 55-min lesson. We register listeners with explicit
  // cleanup so route-stack-pop doesn't leak handlers.
  useEffect(() => {
    const fire = () => {
      const el = videoRef.current;
      if (!el) return;
      if (
        shouldFinalizeOnPagehide({
          duration: el.duration,
          curr: el.currentTime,
          fired: firedRef.current,
        })
      ) {
        fireQuartile(100);
      }
    };
    const onPagehide = () => fire();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') fire();
    };
    window.addEventListener('pagehide', onPagehide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPagehide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fireQuartile]);

  // Tap-to-unmute. Re-asserts el.muted = false + play() inside the user
  // gesture so iOS Safari accepts it. On success, dismisses the overlay.
  const onTapForSound = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = false;
    void el.play().catch(() => {
      // Still refused — leave the overlay up; user can try again.
    });
    setNeedsSoundTap(false);
  }, []);

  // Ask CTA. Mirrors hook-panel:
  //   • anon → record auth_required mic_tap → window.location.href = '/login'
  //   • auth → POST /api/sessions/open → on 401 window.location.href, else
  //     persist envelope + router.push('/s/[id]') (session route is not
  //     auth-affecting). Pause the long-form on click and resume on
  //     non-2xx (audit M7).
  const onAsk = useCallback(async () => {
    if (asking) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).posthog?.capture?.('long_form_ask_clicked', {
        video_id: videoId,
        creator_id: creatorId,
        authenticated: isAuthenticated,
      });
    } catch { /* noop */ }

    if (!isAuthenticated) {
      recordFeedEvent({
        event_name: 'mic_tap',
        hook_id: entryHookId ?? undefined,
        video_id: videoId,
        creator_id: creatorId,
        payload: { mic_tap_outcome: 'auth_required' },
      });
      window.location.href = '/login';
      return;
    }

    const el = videoRef.current;
    const wasPlaying = !!el && !el.paused;
    el?.pause();
    setAsking(true);
    setAskError(null);

    try {
      const r = await fetch('/api/sessions/open', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          creator_id: creatorId,
          // Use entry hook for context if we have one; otherwise omit.
          ...(entryHookId ? { hook_id: entryHookId } : {}),
          model: DEFAULT_VOICE_MODEL,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        const outcome =
          body?.error === 'creator_not_ready' ? 'creator_not_ready'
          : body?.error === 'rate_limited' || r.status === 429 ? 'kill_switch_blocked'
          : body?.error === 'unauthorized' || r.status === 401 ? 'auth_required'
          : 'unknown_error';
        recordFeedEvent({
          event_name: 'mic_tap',
          hook_id: entryHookId ?? undefined,
          video_id: videoId,
          creator_id: creatorId,
          payload: { mic_tap_outcome: outcome },
        });
        if (r.status === 401) { window.location.href = '/login'; return; }
        // Audit M7: resume play on non-auth failure so the user isn't
        // stuck on a paused frame staring at an error pill.
        if (wasPlaying) void el?.play();
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
        hook_id: entryHookId ?? undefined,
        video_id: videoId,
        creator_id: creatorId,
        session_id_if_opened: env.session_id,
        payload: { mic_tap_outcome: 'session_opened' },
      });
      try {
        sessionStorage.setItem(envelopeStorageKey(env.session_id), JSON.stringify(env));
      } catch { /* sessionStorage blocked — next page shows "expired" */ }
      router.push(`/s/${env.session_id}`);
    } catch {
      if (wasPlaying) void el?.play();
      setAskError('network');
    } finally {
      setAsking(false);
    }
  }, [asking, isAuthenticated, entryHookId, videoId, creatorId, router]);

  const onBack = useCallback(() => {
    if (typeof document !== 'undefined' && document.referrer) {
      try {
        const ref = new URL(document.referrer);
        if (ref.origin === window.location.origin) {
          router.back();
          return;
        }
      } catch { /* */ }
    }
    router.push('/');
  }, [router]);

  return (
    <main
      style={{
        height: '100vh',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ height: '100svh' } as any),
        width: '100vw',
        background: '#000',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          overflow: 'hidden',
        }}
      >
        <MuxVideo
          ref={videoRef}
          playbackId={muxPlaybackId}
          streamType="on-demand"
          controls
          playsInline
          preload="auto"
          // Required for canvas.captureStream() to read pixels without
          // tainting the canvas (Plan §4a). Flag-gated to match the
          // hook-panel staged-rollout pattern.
          crossOrigin={
            isReactCaptureEnabled() ? ('anonymous' as const) : undefined
          }
          metadata={{
            video_id: videoId,
            video_title: videoTitle,
            player_name: 'oakleague-longform',
            viewer_user_id: deviceId ?? undefined,
          }}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          style={{
            width: '100%',
            height: '100%',
            // 16:9 long-form letterboxes on portrait viewports; cover would
            // crop to the center horizontal band.
            objectFit: 'contain',
            background: '#000',
          }}
        />

        {/* "Tap for sound" overlay — only when the muted-fallback fired
            (audit C5). Click captures the gesture and re-asserts unmuted
            playback inside the same call stack so iOS Safari accepts it. */}
        {needsSoundTap && (
          <button
            type="button"
            onClick={onTapForSound}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              padding: '12px 20px',
              borderRadius: 24,
              background: 'rgba(0,0,0,0.7)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 500,
              border: '1px solid rgba(255,255,255,0.4)',
              cursor: 'pointer',
              zIndex: 3,
            }}
            aria-label="Tap for sound"
          >
            Tap for sound
          </button>
        )}

        {/* Floating Ask button while playback is in progress. Hides once
            ended === true; the end-of-video overlay shows a larger primary
            CTA in its place. */}
        {!ended && (
          <button
            type="button"
            onClick={onAsk}
            disabled={asking}
            style={{
              position: 'absolute',
              right: 16,
              bottom: 80,
              padding: '12px 18px',
              borderRadius: 22,
              background: 'rgba(255,255,255,0.18)',
              border: '1px solid rgba(255,255,255,0.45)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              opacity: asking ? 0.6 : 1,
              zIndex: 2,
              cursor: 'pointer',
            }}
            aria-label={
              isAuthenticated
                ? `Chat with @${creatorHandle}`
                : `Sign up to chat with @${creatorHandle}`
            }
          >
            {asking
              ? '…'
              : isAuthenticated
                ? `Chat with @${creatorHandle}`
                : `Sign up to chat with @${creatorHandle}`}
          </button>
        )}

        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 144,
            zIndex: 3,
          }}
        >
          <AskErrorPill error={askError} />
        </div>

        {/* React/duet capture — long-form mode. The source is the HLS
            long-form video, mirrored across the bottom half of the
            recording's 9:16 canvas. Null-renders when the kill-switch
            is off; gated on isAuthenticated to match the hook-panel
            pattern (audit M2 day-2). */}
        {isAuthenticated && (
          <div
            style={{
              position: 'absolute',
              right: 84,
              bottom: 90,
              zIndex: 3,
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


        {/* Back button — top-left, always visible. */}
        <button
          type="button"
          onClick={onBack}
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
            padding: '8px 12px',
            borderRadius: 16,
            background: 'rgba(0,0,0,0.45)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            fontSize: 13,
            cursor: 'pointer',
            zIndex: 3,
          }}
          aria-label="Back"
        >
          ‹ Back
        </button>

        {/* End-of-video overlay (audit M6 / §6.7 spec). After q=100 fires,
            pause the player and show the primary Ask CTA + a Back fallback. */}
        {ended && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.85)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
              zIndex: 4,
              padding: 24,
            }}
          >
            {creatorAvatar && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={creatorAvatar}
                alt={`@${creatorHandle}`}
                style={{ width: 64, height: 64, borderRadius: 32, objectFit: 'cover' }}
              />
            )}
            <div style={{ fontSize: 18, fontWeight: 600, textAlign: 'center', maxWidth: 480 }}>
              {videoTitle}
            </div>
            <div style={{ fontSize: 14, opacity: 0.7 }}>@{creatorHandle} · {creatorName}</div>
            <button
              type="button"
              onClick={onAsk}
              disabled={asking}
              style={{
                marginTop: 8,
                padding: '14px 22px',
                borderRadius: 24,
                background: '#2e6bff',
                color: '#fff',
                border: 'none',
                fontSize: 15,
                fontWeight: 600,
                opacity: asking ? 0.6 : 1,
                cursor: 'pointer',
              }}
            >
              {asking
                ? '…'
                : isAuthenticated
                  ? `Chat with @${creatorHandle}`
                  : `Sign up to chat with @${creatorHandle}`}
            </button>
            <button
              type="button"
              onClick={onBack}
              style={{
                padding: '10px 18px',
                borderRadius: 20,
                background: 'transparent',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.4)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Back
            </button>
          </div>
        )}
      </div>

      {/* Footer-ish description band — minimal v1; no chapter markers. */}
      {durationSeconds != null && (
        <div
          style={{
            padding: '8px 16px',
            fontSize: 12,
            opacity: 0.55,
            background: '#000',
            borderTop: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          {Math.floor(durationSeconds / 60)}:{Math.floor(durationSeconds % 60).toString().padStart(2, '0')} · @{creatorHandle}
        </div>
      )}
    </main>
  );
}
