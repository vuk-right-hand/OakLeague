'use client';

// Demo loop for /waitlist. Uses the existing `welcome_hooks` Mux asset if
// one is published; otherwise renders a static placeholder tile. Capped at
// 720p via MuxPlayer's `maxResolution` prop to control bandwidth — Mux
// data / COGS rollup for the welcome clip is deferred to 2026-05-10 per
// R4-S3. Revisit if Mux Data reports elevated egress at launch.

import MuxPlayer from '@mux/mux-player-react';

type Props = {
  playbackId: string | null;
  aspectRatio?: string | null;
};

export function DemoLoop({ playbackId, aspectRatio }: Props) {
  if (!playbackId) {
    return (
      <div
        style={{
          width: '100%',
          aspectRatio: '9 / 16',
          background: 'linear-gradient(180deg, #0a0a0a, #1a1a1a)',
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 13,
          opacity: 0.6,
        }}
        aria-hidden="true"
      >
        Demo coming soon
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        aspectRatio: aspectRatio ?? '9 / 16',
        maxWidth: 360,
        margin: '0 auto',
        borderRadius: 20,
        overflow: 'hidden',
        background: '#000',
      }}
    >
      <MuxPlayer
        playbackId={playbackId}
        streamType="on-demand"
        autoPlay="muted"
        muted
        loop
        playsInline
        maxResolution="720p"
        style={{ width: '100%', height: '100%', ['--media-object-fit' as string]: 'cover' }}
      />
    </div>
  );
}
