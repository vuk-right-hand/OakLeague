'use client';

import { useEffect, useRef, useState } from 'react';
import MuxPlayer from '@mux/mux-player-react';
import type { FeedItem, VideoGroup } from './feed-types';

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
  // Audit S2: tap-to-pause after the unmute gesture (TikTok expectation).
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);

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
  }, [shouldPlay, hook.hook_id, hook.video_id, hook.creator_id, hook.lesson_number]);

  const handleTap = () => {
    if (!unmuted) {
      unmute();
      return;
    }
    // Audit S2: after the unmute gesture has landed, tap toggles play/pause.
    const el = playerRef.current;
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

      {/* Ask button (stubbed — real voice session lands Day 8) */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).posthog?.capture?.('hook_ask_clicked', {
              hook_id: hook.hook_id,
              creator_id: hook.creator_id,
            });
          } catch {
            /* noop */
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
        }}
        aria-label="Ask this creator"
      >
        Ask
      </button>

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
