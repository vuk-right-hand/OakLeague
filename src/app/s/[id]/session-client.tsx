// Client shell for /s/[id]. Reads the ephemeral envelope from sessionStorage
// (stashed by hook-panel's Ask click), hands it to useSessionPipe, and
// renders the UI. If the envelope is absent (shared URL, page refresh, tab
// restore), the user sees "Session expired — return to feed".
//
// Tokens never appear in the URL. sessionStorage key is scoped by sessionId
// and is removed on consumption to prevent replay.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSessionPipe, type OpenEnvelope } from './use-session-pipe';
import { isValidEnvelope } from '@/lib/avatar/avatar-envelope';
import { shouldShowReconnectOverlay } from './session-reducer';
import { captureSafe } from '@/lib/posthog-safe-capture';
import { ReactButton } from '@/components/recording/ReactButton';
import { RecordingPreview } from '@/components/recording/RecordingPreview';
import { isReactCaptureEnabled } from '@/components/recording/react-button-state';
import {
  useRecordingController,
  type AskDeps,
  type RecordingPreview as RecordingPreviewBlob,
} from '@/lib/recording/recording-controller';

type Props = {
  sessionId: string;
  creatorId: string;
  hookId: string;
  creatorHandle: string;
  creatorDisplayName: string;
  hookTitle: string | null;
  sessionAlreadyEnded: boolean;
};

// Storage key matches what hook-panel writes. Prefix avoids collision with
// any other app-wide sessionStorage usage.
export function envelopeStorageKey(sessionId: string): string {
  return `oak_session_envelope_${sessionId}`;
}

function readEnvelope(sessionId: string): OpenEnvelope | null {
  try {
    const raw = sessionStorage.getItem(envelopeStorageKey(sessionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Consume: remove after read to prevent replay on navigate-back.
    sessionStorage.removeItem(envelopeStorageKey(sessionId));
    // PR-2: stale-shape guard. A pre-deploy tab can write the old
    // envelope shape (gemini.token, nullable voice_ticket); the new
    // build's reader rejects it and falls through to the existing
    // "Session expired" screen.
    if (!isValidEnvelope(parsed)) {
      // Round-2 audit C2 + whole-build audit C1/C2: a stale-shape envelope
      // means the OLD writer already POSTed /api/sessions/open and created
      // a server-side row (sessions_one_active_per_user partial-unique
      // index will block the user's next /open until the reaper runs
      // ~60s later). Free the slot proactively + emit telemetry so the
      // post-deploy stale-tab rate is measurable (plan AC #9).
      const stale = parsed as { session_id?: unknown };
      const staleId = typeof stale?.session_id === 'string' ? stale.session_id : null;
      // /api/sessions/close ALLOWED_USER_END_REASONS only accepts
      // user_ended | user_zombie_cleanup | client_error — pass
      // 'client_error' for the proactive close (a custom string would
      // 400 and leave the orphan open).
      captureSafe('envelope_shape_mismatch', {
        session_id: staleId ?? null,
        had_session_id: staleId !== null,
      });
      if (staleId) {
        try {
          if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
            const blob = new Blob(
              [JSON.stringify({ session_id: staleId, end_reason: 'client_error' })],
              { type: 'application/json' },
            );
            navigator.sendBeacon('/api/sessions/close', blob);
          } else {
            void fetch('/api/sessions/close', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session_id: staleId, end_reason: 'client_error' }),
              keepalive: true,
            }).catch(() => { /* best-effort */ });
          }
        } catch { /* sendBeacon blocked — reaper covers in 60s */ }
      }
      return null;
    }
    if (parsed.session_id !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function SessionClient(props: Props) {
  const [envelope, setEnvelope] = useState<OpenEnvelope | null>(null);
  const [envelopeChecked, setEnvelopeChecked] = useState(false);
  const envelopeReadOnceRef = useRef(false);

  useEffect(() => {
    if (props.sessionAlreadyEnded) {
      setEnvelopeChecked(true);
      return;
    }
    // React 18 strict mode runs effects twice in dev — readEnvelope is
    // destructive (removes from sessionStorage on success), so without this
    // ref guard the second run reads null and overwrites a valid envelope.
    if (envelopeReadOnceRef.current) return;
    envelopeReadOnceRef.current = true;
    const env = readEnvelope(props.sessionId);
    setEnvelope(env);
    setEnvelopeChecked(true);
  }, [props.sessionId, props.sessionAlreadyEnded]);

  if (!envelopeChecked) {
    return <BootingScreen label="Loading…" />;
  }
  if (props.sessionAlreadyEnded) {
    return <ExpiredScreen reason="This session has already ended." />;
  }
  if (!envelope) {
    return <ExpiredScreen reason="Session expired or was opened in another tab." />;
  }

  return (
    <LiveSession
      envelope={envelope}
      creatorId={props.creatorId}
      hookId={props.hookId}
      creatorHandle={props.creatorHandle}
      creatorDisplayName={props.creatorDisplayName}
      hookTitle={props.hookTitle}
    />
  );
}

type LiveProps = Omit<Props, 'sessionId' | 'sessionAlreadyEnded'> & { envelope: OpenEnvelope };

function LiveSession(props: LiveProps) {
  const router = useRouter();
  const rolloverOverrideSeconds = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    const raw = process.env.NEXT_PUBLIC_GEMINI_SESSION_CAP_S;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, []);

  const pipe = useSessionPipe({
    envelope: props.envelope,
    creatorId: props.creatorId,
    hookId: props.hookId,
    rolloverOverrideSeconds,
  });

  useEffect(() => {
    captureSafe('session_open', {
      session_id: props.envelope.session_id,
      tier: props.envelope.tier,
      avatar_status: props.envelope.avatar_status,
      creator_id: props.creatorId,
      hook_id: props.hookId,
    });
  }, [props.envelope.session_id, props.envelope.tier, props.envelope.avatar_status, props.creatorId, props.hookId]);

  useEffect(() => {
    if (pipe.state.phase === 'closed') {
      const t = window.setTimeout(() => router.push('/'), 1500);
      return () => window.clearTimeout(t);
    }
  }, [pipe.state.phase, router]);

  // R4-YC-Day — black-square watcher. The most-likely demo-day failure
  // is iOS PWA autoplay across LTE↔WiFi handoff during Simli mint:
  // prime / rebind play / full-rebind each silently no-op on rejection,
  // so "video has a track but is paused" goes uncaught. This 1Hz check
  // dispatches video_autoplay_lost after 2s of paused-with-track, which
  // surfaces the reconnect overlay (tap = fresh activation = play()).
  useEffect(() => {
    if (pipe.state.phase !== 'ready' && pipe.state.phase !== 'listening' && pipe.state.phase !== 'speaking') {
      return;
    }
    let pausedSinceMs = 0;
    let firedThisRun = false;
    const id = window.setInterval(() => {
      const v = pipe.videoRef.current;
      if (!v || !v.srcObject) {
        pausedSinceMs = 0;
        return;
      }
      if (v.paused) {
        if (pausedSinceMs === 0) pausedSinceMs = Date.now();
        else if (!firedThisRun && Date.now() - pausedSinceMs >= 2000) {
          firedThisRun = true;
          captureSafe('simli_video_paused_with_track', {
            session_id: props.envelope.session_id,
            elapsed_ms: Date.now() - pausedSinceMs,
          });
          // R4-M5 — flip reducer to 'reconnecting' so the existing
          // tap-to-resume overlay surfaces. The retry button calls
          // pipe.retryAfterGesture → bridge.rebindMediaSource (R3-M2).
          pipe.notifyVideoAutoplayLost();
        }
      } else {
        pausedSinceMs = 0;
        firedThisRun = false;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [pipe.state.phase, pipe.videoRef, props.envelope.session_id]);

  const phase = pipe.state.phase;
  const showReconnect = shouldShowReconnectOverlay(pipe.state);
  const isOpening = phase === 'opening';
  const isRollingOver = phase === 'opening' && pipe.state.openedAtMs !== null && pipe.state.brainReady === false && pipe.state.avatarReady === false;

  // ── Recording wiring (Day 3) ──────────────────────────────────────────
  // Mount ReactButton on Ask scene. Kill-switch via NEXT_PUBLIC_REACT_CAPTURE_
  // ENABLED. The controller borrows AudioContext + mic + bridge from the pipe
  // (audit C3/C4/M5 Day 3) — Ask scene owns those lifecycles.
  const reactCaptureOn = isReactCaptureEnabled();
  // Avatar must be ready before ARM — getCurrentTracks() returns nulls
  // otherwise. Phase 'ready'/'listening'/'speaking' all imply avatar_ready=true
  // per session-reducer; 'opening' does not.
  const avatarReady = pipe.state.avatarReady;
  // Build askDeps using the pipe accessors. Stable identity across renders
  // because each function is useCallback-wrapped inside use-session-pipe.
  const askDeps = useMemo<AskDeps | undefined>(() => {
    if (!reactCaptureOn) return undefined;
    if (!avatarReady) return undefined;
    const ctx = pipe.getAudioContext();
    const mic = pipe.getMicStream();
    const bridge = pipe.getBridge();
    if (!ctx || !mic || !bridge) return undefined;
    return {
      audioContext: ctx,
      micStream: mic,
      bridge,
      subscribeTrackUpdates: pipe.subscribeBridgeTrackUpdates,
    };
  }, [
    reactCaptureOn, avatarReady,
    pipe.getAudioContext, pipe.getMicStream, pipe.getBridge,
    pipe.subscribeBridgeTrackUpdates,
  ]);
  const askEnabled = !!askDeps && (phase === 'ready' || phase === 'listening' || phase === 'speaking');
  const onAskStop = useCallback((preview: RecordingPreviewBlob) => {
    captureSafe('react_ask_recording_stop', {
      session_id: props.envelope.session_id,
      stop_reason: preview.stopReason,
      duration_ms: preview.durationMs,
      mime_type: preview.mimeType,
      blob_size: preview.blob.size,
    });
  }, [props.envelope.session_id]);
  const recording = useRecordingController({
    enabled: askEnabled,
    mode: 'ask',
    getSourceVideoEl: () => null, // Ask uses the hidden-video shim from askDeps.bridge
    creatorHandle: props.creatorHandle,
    // Static fallback URL — `oakl.gg` root (audit C2 cross-cutting Day 4:
    // `/<handle>` would be a 404 with no creator-drawer route).
    referralUrl: 'oakl.gg',
    creatorId: props.creatorId,
    clipId: props.hookId,
    askDeps,
    onStop: onAskStop,
  });
  // Audit C1 Day 3 — endSession() is synchronous: it dispatches user_close,
  // closes the bridge, the audio context, the mixer, the gemini WS — all
  // before any phase-watching effect can run. By the time `phase==='closed'`
  // is observed, the avatar tracks are dead and the recording's tail is
  // silent. The recording controller MUST be signaled BEFORE endSession
  // tears anything down. Wrap endSession in a handler that signals first.
  const handleEndSession = useCallback(async (reason: 'user_ended' | 'client_error') => {
    try { recording.signalAskSessionEnded(); } catch { /* not armed */ }
    await pipe.endSession(reason);
  }, [pipe, recording]);
  // Backstop: a fatal_error path or a server-driven close that never goes
  // through the End button still sets phase='closed'. Once-only via ref so
  // re-renders post-close (the 1500ms router.push delay) don't keep firing.
  const askEndedSignaledRef = useRef(false);
  useEffect(() => {
    if (phase === 'closed' && !askEndedSignaledRef.current) {
      askEndedSignaledRef.current = true;
      try { recording.signalAskSessionEnded(); } catch { /* */ }
    }
  }, [phase, recording]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: '#000', color: '#fff',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Video panel */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <video
          ref={pipe.videoRef}
          playsInline
          autoPlay
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {/* R3-S3 — `display:none` causes iOS Safari to deprioritize/pause
            hidden audio after backgrounding. 1×1 in-flow + opacity:0 keeps
            the element layout-active without visible footprint. */}
        <audio
          ref={pipe.audioRef}
          autoPlay
          style={{ width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        />

        {/* Top bar — creator + end */}
        <div
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, padding: 16,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.5), rgba(0,0,0,0))',
            pointerEvents: 'none',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{props.creatorDisplayName}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>@{props.creatorHandle}</div>
          </div>
          <button
            type="button"
            onClick={() => void handleEndSession('user_ended')}
            style={{
              pointerEvents: 'auto',
              background: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.4)',
              color: '#fff', borderRadius: 20, padding: '8px 14px',
              fontSize: 13, fontWeight: 600,
            }}
          >
            End
          </button>
        </div>

        {/* Bottom hook title */}
        {props.hookTitle && (
          <div
            style={{
              position: 'absolute', bottom: 120, left: 16, right: 16,
              fontSize: 14, opacity: 0.85, pointerEvents: 'none',
              textShadow: '0 1px 2px rgba(0,0,0,0.8)',
            }}
          >
            {props.hookTitle}
          </div>
        )}

        {/* Overlays */}
        {isOpening && !isRollingOver && <OverlayCenter label="Connecting…" />}
        {isRollingOver && <OverlayCenter label="Reconnecting…" />}
        {/* R3-Missing-6 — Cartesia-down banner. Avatar pipe stays warm
            (Simli RTC unaffected); user sees a small badge instead of the
            full-screen reconnect overlay. */}
        {pipe.state.cartesiaReconnecting && (
          <div
            style={{
              position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.65)', color: '#fff',
              padding: '6px 12px', borderRadius: 16, fontSize: 12,
              pointerEvents: 'none',
            }}
          >
            Voice catching up…
          </div>
        )}
        {showReconnect && (
          <OverlayCenter
            label="Connection interrupted"
            action={{
              label: 'Tap to reconnect',
              onClick: () => void pipe.retryAfterGesture(),
            }}
          />
        )}
        {phase === 'closed' && (
          <OverlayCenter
            label={friendlyErrorLabel(pipe.state.errorMessage)}
            sublabel="Returning to feed…"
          />
        )}

        {/* React button — Day 3 Ask-mode capture. Mounts only with the
            kill-switch flag on AND avatar ready (so getCurrentTracks has
            something to return). Bottom-right matches hook-panel placement. */}
        {reactCaptureOn && askEnabled && (
          <div style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 2 }}>
            <ReactButton {...recording.buttonProps} />
          </div>
        )}

        <RecordingPreview
          preview={recording.preview}
          onDismiss={recording.dismissPreview}
          onDiscard={recording.discardByUser}
        />
      </div>

      {/* Mic controls */}
      <div style={{ padding: 24, display: 'flex', justifyContent: 'center', background: '#000' }}>
        <MicButton
          phase={phase}
          onPressStart={() => pipe.startMic()}
          onPressEnd={() => pipe.stopMic()}
        />
      </div>
    </div>
  );
}

function MicButton({
  phase,
  onPressStart,
  onPressEnd,
}: {
  phase: string;
  onPressStart: () => void;
  onPressEnd: () => void;
}) {
  const enabled = phase === 'ready' || phase === 'listening' || phase === 'speaking';
  const active = phase === 'listening';
  return (
    <button
      type="button"
      // 2026-05-12 fix v2: DO NOT use the `disabled` HTML attribute. When phase
      // transitions mid-press to a non-enabled state, the browser disables the
      // button, RELEASES pointer capture, and the pointerup/cancel event never
      // fires. Result: mic state stuck (UI still shows "Listening" or "Hold"
      // depending on phase but no audio flows). Instead, keep the button alive
      // and gate purely inside the handlers — they're already no-ops if phase
      // is wrong (startMic returns early; stopMic uses micActiveRef latch).
      aria-disabled={!enabled}
      // 2026-05-12 fix v1: setPointerCapture keeps pointer events bound to
      // this element until pointerup/cancel regardless of cursor position.
      // Fixes PC mouse hold drifting off the 84px circular target + mobile
      // finger drift.
      onPointerDown={(e) => {
        if (!enabled) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        onPressStart();
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
        onPressEnd();
      }}
      onPointerCancel={(e) => {
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
        onPressEnd();
      }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Hold to speak"
      style={{
        width: 84, height: 84, borderRadius: 42,
        background: active ? '#ef4444' : enabled ? '#fff' : 'rgba(255,255,255,0.2)',
        color: active ? '#fff' : '#000',
        border: 'none',
        fontWeight: 700, fontSize: 13,
        touchAction: 'none',
        transition: 'background-color 120ms ease',
        opacity: enabled ? 1 : 0.5,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {active ? 'Listening' : 'Hold'}
    </button>
  );
}

function OverlayCenter({
  label,
  sublabel,
  action,
}: {
  label: string;
  sublabel?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: sublabel || action ? 8 : 0 }}>
        {label}
      </div>
      {sublabel && <div style={{ fontSize: 13, opacity: 0.75 }}>{sublabel}</div>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            marginTop: 16,
            background: '#fff', color: '#000',
            border: 'none', borderRadius: 24,
            padding: '10px 20px', fontSize: 14, fontWeight: 600,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function BootingScreen({ label }: { label: string }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: '#000', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 15,
      }}
    >
      {label}
    </div>
  );
}

// Phase 0.5 (2026-05-07). Map raw reducer error codes to short, friendly
// labels. The reducer stores e.g. 'mic_failed' or 'avatar: session_ttl_expired';
// surfacing those literally to users is bad UX (and misleading — the TTL
// path is often just a downstream symptom of an earlier mic / TTS failure
// per the iOS investigation). Anything we don't recognize falls through to
// a generic message rather than leaking a snake_case token.
function friendlyErrorLabel(raw: string | null | undefined): string {
  if (!raw) return 'Session ended';
  // Strip the 'avatar: ' / 'proxy: ' prefixes the hook adds before mapping.
  const code = raw.replace(/^(avatar|proxy):\s*/, '');
  switch (code) {
    case 'mic_failed':
      return 'Microphone unavailable';
    case 'session_ttl_expired':
    case 'session_evicted':
      return 'Session ended';
    case 'session_dead':
      return 'Connection lost';
    case 'tts_failed':
    case 'cogs_misconfig':
      return "Voice couldn't connect";
    case 'proxy_connect_failed':
    case 'proxy_swap_failed':
    case 'voice_ticket_mint_failed':
    case 'rollover_502':
    case 'rollover_503':
    case 'rollover_network':
      return "Couldn't reach the assistant";
    default:
      // rollover_${status} covers other server-mapped errors (404, 410,
      // 500). Fall through to the generic copy.
      if (code.startsWith('rollover_')) return "Couldn't reach the assistant";
      return 'Session ended';
  }
}

function ExpiredScreen({ reason }: { reason: string }) {
  const router = useRouter();
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: '#000', color: '#fff',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 24, textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>Session unavailable</div>
      <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 20 }}>{reason}</div>
      <button
        type="button"
        onClick={() => router.push('/')}
        style={{
          background: '#fff', color: '#000',
          border: 'none', borderRadius: 24,
          padding: '10px 20px', fontSize: 14, fontWeight: 600,
        }}
      >
        Back to feed
      </button>
    </div>
  );
}
