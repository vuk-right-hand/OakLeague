'use client';

import { useEffect, useRef, useState } from 'react';
import MuxPlayer from '@mux/mux-player-react';
import type { WelcomeHook } from './feed-types';
import { captureSafe } from '@/lib/posthog-safe-capture';

type Props = {
  welcome: WelcomeHook;
  onVisibilityChange?: (visible: boolean) => void;
};

export function WelcomeOverlay({ welcome, onVisibilityChange }: Props) {
  const storageKey = `oak_welcome_seen:${welcome.id}`;
  const [visible, setVisible] = useState(false);
  const [unmuted, setUnmuted] = useState(false);
  const notifyRef = useRef(onVisibilityChange);
  notifyRef.current = onVisibilityChange;

  useEffect(() => {
    try {
      if (localStorage.getItem(storageKey) !== '1') {
        setVisible(true);
      } else {
        notifyRef.current?.(false);
      }
    } catch {
      setVisible(true);
    }
  }, [storageKey]);

  useEffect(() => {
    notifyRef.current?.(visible);
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      /* noop */
    }
    captureSafe('welcome_dismissed', { welcome_id: welcome.id });
  };

  // Audit M4: if the viewer prefers reduced motion, don't autoplay — wait
  // for an explicit tap. Otherwise start muted (Safari requirement) and
  // let a tap unmute. Audit S3: muted={!unmuted} matches autoPlay='muted'.
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  return (
    <div
      role="dialog"
      aria-label="Welcome"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{ position: 'relative', width: '100vw', height: '100svh' }}
        onClick={() => {
          if (!unmuted) setUnmuted(true);
        }}
      >
        <MuxPlayer
          playbackId={welcome.mux_playback_id}
          streamType="on-demand"
          autoPlay={reduceMotion ? false : 'muted'}
          muted={!unmuted}
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onEnded={dismiss}
        />
        {!unmuted && (
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
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            background: 'rgba(0,0,0,0.5)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.3)',
            padding: '8px 14px',
            borderRadius: 16,
            fontSize: 13,
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
