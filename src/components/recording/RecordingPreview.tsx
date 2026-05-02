// Day 4 — RecordingPreview modal.
//
// Mounted on hook-panel, long-form-player, and /s/[id] session-client. Shows
// the captured blob with native scrub controls + Share / Save / Discard.
//
// Audit M6 Day 4: URL.createObjectURL must be revoked. Cleanup runs on
// unmount AND when the blob identity changes (defensive — preview controller
// only emits one blob per ARM cycle, but defensive avoids leaks if the
// component is re-used across cycles).
//
// Audit C3 Day 4: Discard fires controller.discardByUser() — distinct from
// the close (X) / backdrop dismiss which fires controller.dismissPreview().
// User-intent discard revokes the referral token; window-close does not
// (the user might've meant "I'll revisit this later" — Day 5 will gate this
// behind an actual draft system. For Day 4, dismissPreview also returns
// the controller to IDLE, so the visual UX is identical; only the token
// fate differs).

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { shareOrSave, type ShareResult } from '@/lib/recording/share';
import type { RecordingPreview as PreviewBlob } from '@/lib/recording/recording-controller';

type Props = {
  preview: PreviewBlob | null;
  onDismiss: () => void;          // X / backdrop / ESC — user might revisit
  onDiscard: () => void;           // explicit Discard button — revoke token
};

export function RecordingPreview({ preview, onDismiss, onDiscard }: Props) {
  // Stable blob URL per blob instance. Revoked on unmount / blob change.
  const blobUrl = useMemo(
    () => (preview && typeof URL !== 'undefined' ? URL.createObjectURL(preview.blob) : null),
    [preview],
  );
  useEffect(() => {
    return () => {
      if (blobUrl && typeof URL !== 'undefined') {
        try { URL.revokeObjectURL(blobUrl); } catch { /* */ }
      }
    };
  }, [blobUrl]);

  const [shareState, setShareState] = useState<'idle' | 'sharing' | ShareResult['kind']>('idle');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ESC + backdrop dismiss. Document keydown so the listener works regardless
  // of focus.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview, onDismiss]);

  if (!preview || !blobUrl) return null;

  async function onShareClick(): Promise<void> {
    if (!preview) return;
    setShareState('sharing');
    const result = await shareOrSave({
      blob: preview.blob,
      mimeType: preview.mimeType,
      // Use first 8 chars of mimeType + duration as the filename short id
      // until Day 5 wires the real share token plaintext into the preview.
      shortId: `${Math.round(preview.durationMs / 1000)}s`,
    });
    setShareState(result.kind);
    // Auto-dismiss only on a successful share — keep the modal open on
    // download (user may want to inspect or share again) and on
    // cancellation (user explicitly backed out of the share sheet).
    if (result.kind === 'shared') {
      setTimeout(onDismiss, 600);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recording preview"
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      {/* Inner container stops backdrop click from dismissing */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 480,
          width: '100%',
          background: '#0d0d0f',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close preview"
          style={{
            position: 'absolute',
            top: 8, right: 8, zIndex: 2,
            width: 32, height: 32, borderRadius: 16,
            background: 'rgba(0,0,0,0.55)',
            color: '#fff', border: 'none',
            fontSize: 18, lineHeight: '32px', textAlign: 'center',
            cursor: 'pointer',
          }}
        >
          ×
        </button>

        <video
          ref={videoRef}
          src={blobUrl}
          controls
          playsInline
          style={{
            width: '100%',
            aspectRatio: '9 / 16',
            objectFit: 'contain',
            background: '#000',
            display: 'block',
          }}
        />

        <div style={{ padding: 16, display: 'flex', gap: 8, color: '#fff' }}>
          <button
            type="button"
            onClick={onDiscard}
            disabled={shareState === 'sharing'}
            // Audit M4 Day-4-fix: prevent revoke-while-share-sheet-open
            // race. User taps Share → OS sheet opens with the file → user
            // taps Discard → token revoked → recipient lands at /r/[token]
            // and the redemption silently fails. Block Discard until share
            // completes (success / cancel / fail).
            style={{
              flex: 1, height: 44, borderRadius: 22,
              background: 'transparent',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)',
              fontSize: 14, fontWeight: 600,
              cursor: shareState === 'sharing' ? 'not-allowed' : 'pointer',
              opacity: shareState === 'sharing' ? 0.5 : 1,
            }}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void onShareClick()}
            disabled={shareState === 'sharing'}
            style={{
              flex: 2, height: 44, borderRadius: 22,
              background: '#fff', color: '#000',
              border: 'none',
              fontSize: 14, fontWeight: 700,
              cursor: shareState === 'sharing' ? 'wait' : 'pointer',
              opacity: shareState === 'sharing' ? 0.7 : 1,
            }}
          >
            {labelForState(shareState)}
          </button>
        </div>
      </div>
    </div>
  );
}

function labelForState(s: 'idle' | 'sharing' | ShareResult['kind']): string {
  switch (s) {
    case 'sharing':    return 'Opening…';
    case 'shared':     return 'Shared ✓';
    case 'downloaded': return 'Saved ✓';
    case 'cancelled':  return 'Share';
    case 'failed':     return 'Try again';
    case 'idle':
    default:           return 'Share';
  }
}
