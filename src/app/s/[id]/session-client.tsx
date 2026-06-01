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

// P0-1 — after this long in 'thinking', show the soft "still thinking…" caption
// under the dots (purely cosmetic; the hard dead-turn cutover is TURN_DEAD_MS in
// the pipe). Below the ~8s mark covers a typical slow turn before a failover.
const THINKING_CAPTION_MS = 8_000;

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

  // P0-1 — soft "still thinking…" caption. Client-local (no reducer state): when
  // we've sat in 'thinking' past THINKING_CAPTION_MS, add a faint reassurance
  // line under the dots so an 8–29s Haiku failover doesn't feel dead. Cleared
  // the instant we leave 'thinking'. The hard turn-dead → reconnecting safety
  // net lives in the pipe (TURN_DEAD_MS); this is purely cosmetic.
  const [thinkingStalled, setThinkingStalled] = useState(false);
  useEffect(() => {
    if (phase !== 'thinking') {
      setThinkingStalled(false);
      return;
    }
    const t = window.setTimeout(() => setThinkingStalled(true), THINKING_CAPTION_MS);
    return () => window.clearTimeout(t);
  }, [phase]);
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
        {/* P0-1 — pre-answer thinking indicator. Shown only while the brain is
            working (mic stopped, no audio yet). Clears the instant the first
            audio_out flips phase → speaking, or turn_complete → ready. */}
        {phase === 'thinking' && <ThinkingDots stalled={thinkingStalled} />}
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
          micActive={pipe.micActive}
          onPressStart={() => pipe.startMic()}
          onPressEnd={() => pipe.stopMic()}
        />
      </div>
    </div>
  );
}

function MicButton({
  phase,
  micActive,
  onPressStart,
  onPressEnd,
}: {
  phase: string;
  micActive: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
}) {
  // Mic is enabled in ready/listening/speaking — deliberately NOT in 'thinking'
  // (P0-1: the mic is inert while the brain works; the dots carry the feedback,
  // and barge resumes the instant the answer is 'speaking').
  const enabled = phase === 'ready' || phase === 'listening' || phase === 'speaking';
  // 2026-05-13 — `active` derives from the physical mic state (pipe.micActive),
  // NOT phase === 'listening'. We run MANUAL VAD, so the user's turn ends when
  // `stopMic` fires `mic_stopped` (phase → 'thinking'); the mic can be
  // physically off while phase still says 'thinking'/'speaking'. We always want
  // the button label to match what the mic is doing, not what the model is
  // doing — `stopMic` sets micActive=false the instant the turn ends, so the
  // button flips out of "Stop" the moment the user's turn closes.
  const active = micActive;

  // 2026-05-12 fix v4: tap-to-toggle (was hold-to-talk; the hold pattern was
  // fragile across browsers — setPointerCapture + React reconciliation hell).
  //
  // 2026-05-13: auto-stop is silence-detection-driven from use-session-pipe
  // (RMS in the AudioWorklet → 7s silence threshold → stop). The fixed 30s
  // cap that used to live here was awful UX (cuts mid-sentence at 30s, leaves
  // mic open 26s after a 4s utterance). Button just handles user tap intent;
  // pipe owns the auto-stop policy.
  const activeRef = useRef(false);
  const onPressStartRef = useRef(onPressStart);
  const onPressEndRef = useRef(onPressEnd);
  onPressStartRef.current = onPressStart;
  onPressEndRef.current = onPressEnd;
  // Keep activeRef in sync with the actual phase, so an externally-driven
  // phase transition (e.g., model started speaking, fatal error, silence
  // auto-stop) flips us back to "not active" without a user tap.
  activeRef.current = active;

  // Defensive cleanup if the component unmounts while listening.
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        try { onPressEndRef.current(); } catch {}
      }
    };
  }, []);

  const handleTap = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    e.preventDefault();
    if (activeRef.current) {
      try { onPressEndRef.current(); } catch {}
    } else {
      try { onPressStartRef.current(); } catch {}
    }
  };

  return (
    <button
      type="button"
      aria-disabled={!enabled}
      onPointerDown={handleTap}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={active ? 'Tap to stop' : 'Tap to talk'}
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
      {active ? 'Stop' : 'Tap'}
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

// P0-1 — the pre-answer indicator. Three pulsing dots centered low over the
// avatar (above the mic). The fade-in stays at opacity 0 for the first ~250ms
// (keyframe 0–55%) so a sub-300ms turn that mounts-then-unmounts never flashes.
// `aria-live="polite"` + the visually-hidden "Thinking…" text gives screen
// readers the same signal sighted users get. `stalled` adds the soft caption.
function ThinkingDots({ stalled }: { stalled: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute', left: '50%', bottom: 140,
        transform: 'translateX(-50%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        pointerEvents: 'none',
        animation: 'oakThinkingIn 450ms ease-out both',
      }}
    >
      <style>{`
        @keyframes oakThinkingIn { 0%, 55% { opacity: 0 } 100% { opacity: 1 } }
        @keyframes oakThinkingDot {
          0%, 80%, 100% { opacity: 0.25; transform: translateY(0) }
          40% { opacity: 1; transform: translateY(-3px) }
        }
      `}</style>
      <div style={{ display: 'flex', gap: 6 }} aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 8, height: 8, borderRadius: 4, background: '#fff',
              animation: `oakThinkingDot 1.2s ${i * 0.16}s infinite ease-in-out`,
            }}
          />
        ))}
      </div>
      {stalled && (
        // Decorative — the visually-hidden span below is the single SR source,
        // so this caption stays aria-hidden to avoid a double announce.
        <div aria-hidden="true" style={{ fontSize: 12, opacity: 0.7, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
          still thinking…
        </div>
      )}
      <span
        style={{
          position: 'absolute', width: 1, height: 1,
          overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
        }}
      >
        Thinking…
      </span>
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
