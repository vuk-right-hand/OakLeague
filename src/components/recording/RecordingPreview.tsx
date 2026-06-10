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
import { saveOnly, shareOrSave, type ShareResult } from '@/lib/recording/share';
import type { RecordingPreview as PreviewBlob } from '@/lib/recording/recording-controller';
import { captureSafe } from '@/lib/posthog-safe-capture';

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
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle');
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

  // Filename id: prefer the referral token plaintext (plan audit M7 — the
  // duration-only id collided across equal-length recordings and carried
  // zero attribution on the desktop save→manual-upload path; the token is
  // public-by-design, it IS the /r/<token> URL burned into the end-card).
  const fileShortId = preview.shareShortId ?? `${Math.round(preview.durationMs / 1000)}s`;

  function onSaveClick(): void {
    if (!preview) return;
    const r = saveOnly({
      blob: preview.blob,
      mimeType: preview.mimeType,
      shortId: fileShortId,
    });
    setSaveState(r.kind === 'downloaded' ? 'saved' : 'failed');
    captureSafe('react_save_clicked', {
      result: r.kind,
      duration_ms: preview.durationMs,
      mime_type: preview.mimeType,
    });
    // Reset to idle so a second tap re-renders "Save" and triggers a fresh
    // download (otherwise the button stays "Saved ✓" forever for the
    // duration of the modal — confusing on repeat).
    setTimeout(() => setSaveState('idle'), 1500);
  }

  async function onShareClick(): Promise<void> {
    if (!preview) return;
    setShareState('sharing');
    captureSafe('react_share_opened', {
      duration_ms: preview.durationMs,
      mime_type: preview.mimeType,
      stop_reason: preview.stopReason,
    });
    const result = await shareOrSave({
      blob: preview.blob,
      mimeType: preview.mimeType,
      shortId: fileShortId,
    });
    setShareState(result.kind);
    captureSafe('react_share_completed', {
      result: result.kind,
      duration_ms: preview.durationMs,
    });
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
      {/* Viewport-fit fix (uncapped rework, founder bug report: 9:16 video at
          480px width ≈ 853px tall + button row pushed the buttons below the
          fold on every laptop). The card is a flex column capped at viewport
          height; the video letterboxes into whatever remains above the
          always-visible button row. svh (NOT vh) is the no-dvh fallback —
          plain 100vh on iOS is the LARGER toolbar-hidden height and would
          re-introduce the exact cutoff this fixes (plan audit M4). React 19
          dedupes the <style> via href+precedence across mounts. */}
      <style href="oakl-recording-preview" precedence="default">{`
.oakl-preview-card { max-height: calc(100vh - 32px); }
@supports (height: 100svh) {
  .oakl-preview-card { max-height: calc(100svh - 32px); }
}
@supports (height: 100dvh) {
  .oakl-preview-card { max-height: calc(100dvh - 32px); }
}
`}</style>
      {/* Inner container stops backdrop click from dismissing */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="oakl-preview-card"
        style={{
          maxWidth: 480,
          width: '100%',
          background: '#0d0d0f',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          // Plan audit M5 — on truly short viewports (landscape PC) the
          // flex math could starve the video to a sliver; the card scrolls
          // instead, keeping the 240px video floor meaningful.
          overflowY: 'auto',
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
            // 9:16 is the PREFERRED size; flex shrink (not grow) lets the
            // viewport-height cap squeeze it, objectFit letterboxes the
            // frames, and the 240px floor stops short landscape windows
            // from pinholing the video (plan audit M5).
            aspectRatio: '9 / 16',
            flex: '0 1 auto',
            minHeight: 240,
            objectFit: 'contain',
            background: '#000',
            display: 'block',
          }}
        />

        <div
          style={{
            padding: 16,
            // iOS home-indicator clearance when the card bottoms out against
            // the viewport edge.
            paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
            display: 'flex',
            gap: 8,
            color: '#fff',
            flexShrink: 0,
          }}
        >
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
            onClick={onSaveClick}
            disabled={shareState === 'sharing'}
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
            {saveState === 'saved' ? 'Saved ✓' : saveState === 'failed' ? 'Save failed' : 'Save'}
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
