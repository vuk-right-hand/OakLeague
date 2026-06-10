// React/duet capture controller hook (Plan §13 file list, §2 state machine).
// Composes the four Day-1 leaves — permission lib, AudioMixer, Compositor,
// AvatarBridge (Day-3 wiring) — into a single ARM/STOP/PREVIEW lifecycle the
// surfaces (hook-panel, /v/[id], /s/[id]) consume via <ReactButton {...buttonProps}/>.
//
// Day 2 scope: hook-mode + long-form mode. Ask-mode wiring (bridge.getCurrentTracks
// consumed mid-recording, sourceGain ramp at swap) lands Day 3.
//
// STOP order (avatar-bridge.ts header is the canonical doc):
//   1. mediaRecorder.stop()       — finalize blob first
//   2. compositor.stop()          — stop drawing into a captureStream'd canvas
//   3. mixer.disconnectAvatar()   — Day-3
//   4. bridge.close()             — Day-3
//   5. mixer.close()
//   6. releaseStream(camStream)   — actually stops getUserMedia tracks
//   7. audioContext.close()       — caller-owned by THIS hook
//
// Lifecycle invariants:
//   - AudioContext is created LAZILY on first ARM (not on mount). Chrome
//     caps at ~6 contexts; mounting the hook on N feed items would break
//     scroll if we eager-created.
//   - Bridge instances + AudioContext are session-scoped (one per ARM/STOP
//     cycle). reset() returns to IDLE; the next TAP creates a fresh stack.
//   - Refs hold all the live machinery so React re-renders don't recreate.

'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  type AudioMixer,
  createAudioMixer,
} from './audio-mixer';
import {
  type Compositor,
  COMPOSITE_HEIGHT,
  COMPOSITE_WIDTH,
  END_CARD_MS,
  createCompositor,
} from './composite-canvas';
import {
  RecordingPermissionError,
  attachRevokeWatcher,
  releaseStream,
  requestMediaPermission,
} from './permission';
import { probeRecording, type RecordingMime } from './recording-mime';
import {
  maxRecordingMsForPlatform,
  type RecordingPhase,
  type StopReason,
  recordingReducer,
  selectArmedSecondsElapsed,
  selectArmedSecondsRemaining,
  selectButtonState,
} from './recording-state-machine';
import type { ReactButtonProps } from '@/components/recording/ReactButton';
import type { AvatarBridge } from '@/lib/avatar/avatar-bridge';
import { captureSafe } from '@/lib/posthog-safe-capture';

export type RecordingMode = 'hook' | 'longform' | 'ask';

/** Ask-mode wiring (Day 3). The Ask scene owns the AudioContext, mic stream,
 *  and avatar bridge — recording is a tap-on observer, not the lifecycle owner.
 *  All four fields are optional at the type level so hook/longform callers
 *  don't need to pass them; the controller throws at ARM time if mode='ask'
 *  and any required Ask deps are missing. */
export type AskDeps = {
  /** Shared AudioContext from useSessionPipe. iOS Safari throttles to one
   *  running context per page; the recording controller MUST reuse this rather
   *  than creating its own (audit C3 Day 3) — a second context is born
   *  suspended and resume() doesn't recover it after the user gesture has
   *  already been consumed by the first. */
  audioContext: AudioContext;
  /** Borrowed mic stream from useSessionPipe (already granted for Gemini Live).
   *  iOS Safari throws NotReadableError on a second getUserMedia({audio:true})
   *  call for the same mic (audit C4 Day 3). The controller wires the existing
   *  audio track into the mixer and only requests video for the selfie cam. */
  micStream: MediaStream;
  /** Live avatar bridge from useSessionPipe. The controller calls
   *  bridge.getCurrentTracks() at ARM and bridge.setLocalPlayback(false) to
   *  avoid double-route echo (audit M3 Day 3). The bridge is NEVER closed
   *  by the recording controller — Ask scene owns the lifecycle (audit M5). */
  bridge: AvatarBridge;
  /** Optional. Subscribe to mid-recording avatar track replacements (LiveKit
   *  renegotiation, ICE restart, WiFi↔LTE handoff). The callback receives the
   *  fresh track set; the controller updates the hidden-video srcObject and
   *  rebinds the mixer's avatar branch. Returns an unsubscribe function. */
  subscribeTrackUpdates?: (
    cb: (tracks: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null }) => void,
    opts?: { replayInitial?: boolean },
  ) => () => void;
};

export type RecordingPreview = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  stopReason: StopReason;
  /** Referral token plaintext from the open-check mint (null when the mint
   *  failed / was skipped). Threaded into the share/save FILENAME (plan
   *  audit M7, uncapped rework) so the desktop save→manual-upload path
   *  keeps an attribution breadcrumb beyond the burned-in end-card — and so
   *  two recordings of equal length stop colliding as `oakleague-42s.mp4`.
   *  The token is already public-by-design (it IS the /r/<token> URL drawn
   *  into the video). */
  shareShortId: string | null;
};

export type UseRecordingControllerOptions = {
  /** UX gate (parent decides whether the surface itself is permitted to
   *  record). The kill-switch flag is a separate, lower-level gate inside
   *  the permission lib; both must be on for ARM to succeed. */
  enabled: boolean;
  /** 'hook' / 'longform' for Day 2. 'ask' wires bridge.getCurrentTracks Day 3. */
  mode: RecordingMode;
  /** Getter for the source <video> element to capture (hook MP4 / long-form
   *  HLS). MUST have crossOrigin="anonymous" if it's a Mux URL; otherwise
   *  canvas.captureStream() yields a tainted (silent) MediaRecorder blob.
   *  Audit C1 (day-2): pass a getter, not the value, so the controller
   *  reads the latest ref at tap time. Passing `playerRef.current` directly
   *  captures null on first render and React refs don't trigger re-renders
   *  on `.current` mutation, so the closure can lock to null indefinitely
   *  on the long-form viewer (no constant render driver). */
  getSourceVideoEl: () => HTMLVideoElement | null;
  /** "vuk" — pass without leading '@'. */
  creatorHandle: string;
  /** Fallback referral URL drawn into the end-card if the open-check mint
   *  fails (rate-limit hit / network error / kill-switch off). Format:
   *  `oakl.gg/r/<creator-handle>` is a reasonable degrade — points to the
   *  creator's drawer, no attribution. The controller hits
   *  /api/recording/open-check at ARM and PATCHES the compositor with the
   *  real shortUrl when the mint succeeds (Plan R3-M3). */
  referralUrl: string;
  /** UUID — used by /api/recording/open-check to attribute the token to a
   *  creator. Required for token mint to succeed; if omitted, the controller
   *  skips the mint and falls back to the static referralUrl. */
  creatorId?: string;
  /** UUID — hook_id (hook/longform mode) or video_id (Ask mode). Required
   *  alongside creatorId for the mint. */
  clipId?: string;
  /** Pre-rasterized watermark bitmap. The hook does not own the SVG-to-bitmap
   *  rasterization (Plan §20.12 — caller pre-rasterizes once at module init
   *  to amortize the cost). Pass null to skip the logo blit. */
  watermarkBitmap?: ImageBitmap | HTMLImageElement | null;
  /** Optional. Fires once when STOP completes and a preview blob is ready. */
  onStop?: (preview: RecordingPreview) => void;
  /** Required when mode='ask' — see AskDeps. Hook/longform pass undefined. */
  askDeps?: AskDeps;
};

export type RecordingControllerHandle = {
  /** Pass directly: <ReactButton {...buttonProps} />. */
  buttonProps: ReactButtonProps;
  /** Non-null after STOP completes; null otherwise. */
  preview: RecordingPreview | null;
  /** Dismiss the preview and return to IDLE. */
  dismissPreview: () => void;
  /** Force-reset (e.g. surface unmount, error recovery). */
  reset: () => void;
  /** Day 3 — signal that the host Ask session has ended (user_ended / closed).
   *  No-op unless currently armed; if armed, transitions to STOPPED with
   *  stopReason='ask_session_ended' and finalizes the recording. */
  signalAskSessionEnded: () => void;
  /** Day 4 — explicit user-initiated discard (Discard button in the preview
   *  modal). Distinguishes from dismissPreview which also fires on RESET /
   *  unmount / route change (audit C3 Day 4). Calls dismissPreview AND
   *  POSTs /api/recording/discard to revoke the referral token. */
  discardByUser: () => void;
};

const TIMER_TICK_MS = 100; // 100ms cadence is plenty for the cap + end-card

export function useRecordingController(
  opts: UseRecordingControllerOptions,
): RecordingControllerHandle {
  // Destructure options into stable values so callback dependencies don't
  // pull in the entire opts object (audit M7 — opts changes identity every
  // parent render, which would rebuild onTap and re-render ReactButton on
  // every long-form viewer playback time tick).
  const {
    enabled, mode, getSourceVideoEl, creatorHandle, referralUrl,
    creatorId, clipId, watermarkBitmap, onStop, askDeps,
  } = opts;

  // Latest-ref callback for the source <video> getter (audit C1 day-2). The
  // controller reads via getSourceVideoElRef.current() at tap time so a
  // late-arriving ref doesn't lose the source.
  const getSourceVideoElRef = useRef(getSourceVideoEl);
  useEffect(() => { getSourceVideoElRef.current = getSourceVideoEl; }, [getSourceVideoEl]);

  const [phase, dispatchRaw] = useReducer(recordingReducer, { kind: 'idle' as const });

  // Tick state forces a re-render every TIMER_TICK so the armed countdown
  // updates visibly. Without this, the reducer returns the same phase
  // reference when endCardArmed is unchanged (idempotent), so React skips
  // the render and selectArmedSecondsRemaining stays frozen at its last
  // value until the user causes some other state change.
  const [, setTick] = useState(0);

  // Ref to onStop so async recorder.onstop doesn't capture a stale handler.
  const onStopRef = useRef(onStop);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);

  // Ref to askDeps so the onTap callback always reads the latest bridge /
  // audioContext / micStream without listing the whole opts in deps. The
  // useSessionPipe parent re-renders whenever pipe.state changes, but the
  // underlying refs (audioContext, micStream, bridge) are stable.
  const askDepsRef = useRef<AskDeps | undefined>(askDeps);
  useEffect(() => { askDepsRef.current = askDeps; }, [askDeps]);

  // Ref to the latest dispatch so async callbacks (track.onended, recorder.onstop)
  // don't capture a stale reference if the component unmounts mid-flight.
  const dispatchRef = useRef(dispatchRaw);
  useEffect(() => { dispatchRef.current = dispatchRaw; }, [dispatchRaw]);
  const dispatch = useCallback((ev: Parameters<typeof dispatchRaw>[0]): void => {
    dispatchRef.current(ev);
  }, []);

  // Live machinery — refs so re-renders don't tear down active recordings.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mixerRef = useRef<AudioMixer | null>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const camVideoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detachWatcherRef = useRef<(() => void) | null>(null);
  const detachMicWatcherRef = useRef<(() => void) | null>(null); // Ask-mode borrowed mic (audit M2 Day 3)
  const blobChunksRef = useRef<Blob[]>([]);
  const previewRef = useRef<RecordingPreview | null>(null);
  const armRequestSeqRef = useRef(0); // race guard for stale PERMISSION_GRANTED dispatches

  // ── Ask-mode session refs ──────────────────────────────────────────────
  // Each ARM cycle records its mode + which deps it borrowed so teardown can
  // safely skip closing them (Ask scene owns audioContext + micStream + bridge
  // lifecycle; recording is a tap-on observer per audit M5/M6 Day 3).
  const sessionModeRef = useRef<RecordingMode>('hook');
  const borrowedAudioContextRef = useRef(false); // true → teardown does NOT close ctx
  const borrowedMicStreamRef = useRef(false);    // true → teardown does NOT releaseStream
  const borrowedBridgeRef = useRef<AvatarBridge | null>(null); // bridge we attached avatar audio FROM (never closed by us)
  const hiddenAvatarVideoElRef = useRef<HTMLVideoElement | null>(null);
  const hiddenAvatarStreamRef = useRef<MediaStream | null>(null);
  const detachTrackUpdatesRef = useRef<(() => void) | null>(null);

  // Day 4 — referral token plaintext, populated by the open-check fetch
  // post-permission-grant. Used by discardByUser to call /api/recording/discard.
  const activeTokenPlaintextRef = useRef<string | null>(null);
  const phaseRef = useRef<RecordingPhase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Teardown ──────────────────────────────────────────────────────────
  // Idempotent. Call from dismissPreview, RESET, and unmount.
  // NOT called in the STOPPED→PREVIEW window — recorder.onstop must finalize
  // the blob first; calling teardown synchronously in the STOP useEffect
  // would close the audio context out from under the recorder's
  // moov-atom finalization on Safari.
  const teardown = useCallback((): void => {
    const r = recorderRef.current;
    // Use state !== 'inactive' (audit M5) so a future paused-by-iOS-bg path
    // also stops cleanly.
    if (r && r.state !== 'inactive') {
      try { r.stop(); } catch { /* recorder already finalized */ }
    }
    try { compositorRef.current?.stop(); } catch { /* */ }
    try { detachWatcherRef.current?.(); } catch { /* */ }
    detachWatcherRef.current = null;
    try { detachMicWatcherRef.current?.(); } catch { /* */ }
    detachMicWatcherRef.current = null;
    try { detachTrackUpdatesRef.current?.(); } catch { /* */ }
    detachTrackUpdatesRef.current = null;
    // Restore avatar audible playback BEFORE closing the mixer (audit M3 Day 3
    // — we silenced it on ARM to prevent double-route echo). Idempotent on
    // bridge side, safe to call after close.
    if (borrowedBridgeRef.current) {
      try { borrowedBridgeRef.current.setLocalPlayback(true); } catch { /* */ }
    }
    try { mixerRef.current?.close(); } catch { /* */ }
    // camStreamRef always holds a stream the controller acquired itself
    // (hook/longform: video+audio; Ask: video-only — mic is borrowed via
    // askDepsNow.micStream and never assigned to camStreamRef). Always
    // safe to release. Audit M6 Day 3.
    if (camStreamRef.current) {
      try { releaseStream(camStreamRef.current); } catch { /* */ }
    }
    // Hidden avatar <video> shim (Ask mode). srcObject=null first so the
    // referenced MediaStream tracks can be GC'd. The TRACKS themselves are
    // bridge-owned — we don't stop() them.
    if (hiddenAvatarVideoElRef.current) {
      try { hiddenAvatarVideoElRef.current.srcObject = null; } catch { /* */ }
      try { hiddenAvatarVideoElRef.current.parentNode?.removeChild(hiddenAvatarVideoElRef.current); } catch { /* */ }
    }
    hiddenAvatarVideoElRef.current = null;
    hiddenAvatarStreamRef.current = null;
    if (camVideoElRef.current) {
      try { camVideoElRef.current.srcObject = null; } catch { /* */ }
      try { camVideoElRef.current.parentNode?.removeChild(camVideoElRef.current); } catch { /* */ }
    }
    // Audit C3 Day 3 — only close the AudioContext if we OWN it. Ask mode
    // borrows from useSessionPipe; closing it would kill the live conversation.
    if (audioCtxRef.current && !borrowedAudioContextRef.current) {
      // close() rejects on already-closed contexts (Firefox InvalidState);
      // the void + .catch swallows the rejection. iOS Safari may hang on a
      // suspended-by-policy context — acceptable for v1; user navigation
      // unblocks it.
      try { audioCtxRef.current.close().catch(() => {}); } catch { /* */ }
    }
    recorderRef.current = null;
    compositorRef.current = null;
    mixerRef.current = null;
    camStreamRef.current = null;
    camVideoElRef.current = null;
    canvasRef.current = null;
    audioCtxRef.current = null;
    borrowedAudioContextRef.current = false;
    borrowedMicStreamRef.current = false;
    borrowedBridgeRef.current = null;
    blobChunksRef.current = [];
    // Day 4: clear the token plaintext on teardown. discardByUser revokes
    // the token via /api/recording/discard BEFORE calling teardown — once
    // teardown clears the ref, that path is gone. RESET / unmount intentionally
    // leak the token (90-day expiry; recording finalize at Day 5 will bind it).
    activeTokenPlaintextRef.current = null;
  }, []);

  // ── ARM effect: run side effects on idle→priming→armed transition ────
  // We trigger the actual permission request + ARM machinery from inside
  // the TAP handler (not in a useEffect on phase) because the user-gesture
  // chain matters for getUserMedia + AudioContext.resume() autoplay policy.
  const onTap = useCallback(async (): Promise<void> => {
    const current = phaseRef.current;
    if (current.kind === 'armed') {
      dispatch({ type: 'TAP', nowMs: performance.now() });
      return;
    }
    if (current.kind !== 'idle') return; // priming/stopped/preview/disabled — no-op

    if (!enabled) {
      // Surface-level gate. Permission lib's flag check is the final guard.
      dispatch({ type: 'CAP_HIT', reason: 'feature_disabled', nowMs: performance.now() });
      return;
    }

    // Ask mode REQUIRES audioContext + micStream + bridge from useSessionPipe.
    // Surface as recorder_error if missing — caller bug, not a runtime denial.
    const isAsk = mode === 'ask';
    const askDepsNow = isAsk ? askDepsRef.current : undefined;
    if (isAsk && !askDepsNow) {
      dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: 'ask mode requires askDeps (audioContext + micStream + bridge)' });
      return;
    }

    // Increment seq BEFORE dispatch so a concurrent reset() between the
    // increment and the TAP dispatch doesn't leave seq stale (audit M8).
    const seq = ++armRequestSeqRef.current;
    const tapAtMs = performance.now();
    dispatch({ type: 'TAP', nowMs: tapAtMs });
    sessionModeRef.current = mode;

    // Probe at TAP so `platform` is available for ALL telemetry below
    // (permission_denied / capture_error / armed / stopped). Pure function;
    // no side effects, safe to call before permission grant.
    const { platform, mimes: supportedMimes } = probeRecording();
    captureSafe('react_tap', { mode, platform });

    // 1) Permission. Hook/longform: video+audio. Ask: video only — mic is
    //    borrowed from the Ask scene (audit C4 Day 3). Camera is still ours
    //    so we always request video.
    let stream: MediaStream;
    try {
      const result = await requestMediaPermission({
        video: true,
        audio: !isAsk, // Ask borrows mic; only request video.
      });
      if (seq !== armRequestSeqRef.current) {
        // A reset() or unmount intervened during the permission prompt.
        releaseStream(result.stream);
        return;
      }
      stream = result.stream;
    } catch (e) {
      const code = e instanceof RecordingPermissionError ? e.code : 'unknown';
      if (code === 'denied' || code === 'security') {
        captureSafe('react_permission_denied', { mode, reason: code, platform });
        dispatch({ type: 'PERMISSION_DENIED', nowMs: performance.now() });
      } else if (code === 'disabled' || code === 'unsupported') {
        dispatch({ type: 'CAP_HIT', reason: code === 'disabled' ? 'feature_disabled' : 'unsupported', nowMs: performance.now() });
      } else {
        captureSafe('react_capture_error', { mode, code, platform });
        dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: String(code) });
      }
      return;
    }
    camStreamRef.current = stream;

    // 2) Watch for mid-session revoke (camera flipped off in OS settings).
    //    Ask mode: also watch the borrowed mic so a Settings revoke surfaces
    //    here too (Ask scene has its own watcher; both firing is fine — the
    //    reducer dedupes via the phase guard).
    detachWatcherRef.current = attachRevokeWatcher(stream, () => {
      dispatch({ type: 'PERMISSION_REVOKED', nowMs: performance.now() });
    });

    // 3) Cam <video> element (off-screen sink). Compositor reads videoWidth/
    //    videoHeight + drawImage from this element. iOS requires playsInline
    //    + muted on autoplay-without-user-gesture; this element is muted-by-
    //    default since the audio path goes through the mixer.
    const camEl = document.createElement('video');
    camEl.playsInline = true;
    camEl.muted = true;
    camEl.autoplay = true;
    Object.assign(camEl.style, {
      position: 'fixed', opacity: '0', width: '1px', height: '1px',
      pointerEvents: 'none', top: '0', left: '0',
    });
    document.body.appendChild(camEl);
    camEl.srcObject = stream;
    // play() rejection is expected on iOS Safari without a fresh user
    // gesture — frames still flow through srcObject regardless of the
    // play state, so the recording proceeds.
    try { await camEl.play(); } catch { /* expected — see above */ }
    camVideoElRef.current = camEl;

    // 4) MIME probe (already done at TAP — see `supportedMimes` above).
    if (supportedMimes.length === 0) {
      dispatch({ type: 'CAP_HIT', reason: 'unsupported', nowMs: performance.now() });
      teardown();
      return;
    }

    // 4b) Day 4 — referral token mint AFTER permission grant, BEFORE
    //     compositor.start() so the end-card draws the real shortUrl
    //     (Plan R3-M3, audit C2 Day 4). Mint failure is non-fatal: the
    //     compositor falls back to the static referralUrl prop. Cap-hit
    //     (429) and network errors degrade silently.
    let resolvedReferralUrl = referralUrl;
    activeTokenPlaintextRef.current = null;
    if (creatorId && clipId && process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED === '1') {
      try {
        const res = await fetch('/api/recording/open-check', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ creator_id: creatorId, clip_id: clipId }),
        });
        if (seq !== armRequestSeqRef.current) { teardown(); return; }
        if (res.ok) {
          const j = (await res.json()) as { token?: string; short_url?: string };
          if (typeof j.short_url === 'string' && j.short_url.length > 0) {
            resolvedReferralUrl = j.short_url;
          }
          if (typeof j.token === 'string' && j.token.length > 0) {
            activeTokenPlaintextRef.current = j.token;
          }
        }
        // Non-OK (429 cap, 401, 500): degrade silently, keep static URL.
      } catch {
        // Network error / aborted — degrade silently.
      }
    }

    // 5) AudioContext. Hook/longform: lazy-create one per ARM (Chrome 6-cap
    //    handled by teardown). Ask: BORROW from useSessionPipe (audit C3 Day 3
    //    — iOS Safari throttles to one running ctx per page; a second ctx is
    //    born suspended and resume() doesn't recover it after the user gesture
    //    has been consumed by the first).
    let ctx: AudioContext;
    if (isAsk && askDepsNow) {
      ctx = askDepsNow.audioContext;
      borrowedAudioContextRef.current = true;
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* */ }
      }
    } else {
      ctx = new AudioContext();
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* recording will be silent — surface anyway */ }
      }
    }
    audioCtxRef.current = ctx;

    // 6) Mixer + branches.
    const mixer = createAudioMixer({ audioContext: ctx });
    mixerRef.current = mixer;

    if (isAsk && askDepsNow) {
      // Ask branch wiring:
      //   • mic ← borrowed from Ask scene (audit C4 Day 3)
      //   • avatar ← bridge.getCurrentTracks().audio (audit C3 Day 3)
      //   • source video <video> branch ← left empty (no MP4/HLS source)
      const askMicTrack = askDepsNow.micStream.getAudioTracks()[0];
      if (askMicTrack) mixer.connectMic(askMicTrack);
      borrowedMicStreamRef.current = true;
      // Audit M2 Day 3 — borrowed mic revoke is invisible to the camera-only
      // watcher. Attach a separate watcher so OS-settings revoke surfaces
      // here too (Ask scene has its own watcher; firing both is fine — the
      // reducer's PERMISSION_REVOKED transition is idempotent from 'armed').
      detachMicWatcherRef.current = attachRevokeWatcher(askDepsNow.micStream, () => {
        dispatch({ type: 'PERMISSION_REVOKED', nowMs: performance.now() });
      });

      const initialTracks = askDepsNow.bridge.getCurrentTracks();
      // Avatar audio → mixer. Track liveness guard per avatar-bridge.ts §175-182.
      if (initialTracks.audio && initialTracks.audio.readyState === 'live') {
        mixer.connectAvatar(initialTracks.audio);
      }
      // Audit M3 Day 3 — silence the bridge's <audio> route so the
      // AudioContext destination is the only audible path. Restored on STOP.
      try { askDepsNow.bridge.setLocalPlayback(false); } catch { /* */ }
      borrowedBridgeRef.current = askDepsNow.bridge;
    } else {
      // Hook/longform path — controller-owned mic.
      const micTrack = stream.getAudioTracks()[0];
      if (micTrack) mixer.connectMic(micTrack);
      // Read the source <video> via the ref-callback NOW, not at hook-call
      // time (audit C1 day-2 — playerRef.current was null on first render
      // for the long-form viewer's no-constant-rerender path).
      const sourceVideoEl = getSourceVideoElRef.current();
      if (sourceVideoEl) {
        try { mixer.connectSourceVideo(sourceVideoEl); }
        catch (e) {
          // Likely cross-origin tainted (Mux without crossOrigin="anonymous")
          // OR a one-shot re-bind on the same element across ARM cycles
          // (createMediaElementSource is permanent per element, NOT per
          // AudioContext — Plan §4a / audit M7 day-2). Recording proceeds
          // without source audio. Surface in non-prod so the bug isn't silent.
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[recording-controller] mixer.connectSourceVideo failed — recording continues without source audio:', e);
          }
        }
      }
    }

    // 7) Compositor canvas. captureStream() must be called BEFORE start()
    //    per Safari first-paint contract.
    const canvas = document.createElement('canvas');
    canvas.width = COMPOSITE_WIDTH;
    canvas.height = COMPOSITE_HEIGHT;
    canvasRef.current = canvas;

    // Source for the compositor:
    //   • hook/longform: getSourceVideoElRef.current() — the page's <video>.
    //   • ask: hidden <video srcObject={MediaStream({avatar video track})}>.
    //     Audit C2 Day 3 — must await loadedmetadata before recording starts
    //     so the bottom half of the duet isn't black for the first 50–200ms.
    let compositorSourceEl: HTMLVideoElement | null;
    if (isAsk && askDepsNow) {
      const initialAvatarVideo = askDepsNow.bridge.getCurrentTracks().video;
      const hiddenStream = new MediaStream(
        initialAvatarVideo && initialAvatarVideo.readyState === 'live' ? [initialAvatarVideo] : [],
      );
      hiddenAvatarStreamRef.current = hiddenStream;
      const hiddenEl = document.createElement('video');
      hiddenEl.playsInline = true;
      hiddenEl.muted = true; // visual frames only — audio path is via mixer.connectAvatar
      hiddenEl.autoplay = true;
      Object.assign(hiddenEl.style, {
        position: 'fixed', opacity: '0', width: '1px', height: '1px',
        pointerEvents: 'none', top: '0', left: '0',
      });
      document.body.appendChild(hiddenEl);
      hiddenEl.srcObject = hiddenStream;
      try { await hiddenEl.play(); } catch { /* iOS may reject without gesture; frames still flow via srcObject */ }
      hiddenAvatarVideoElRef.current = hiddenEl;
      compositorSourceEl = hiddenEl;

      // Wait for first-frame readiness. ASK_OPEN_TIMEOUT after 1s if metadata
      // never arrives (audit C2 Day 3 — bound the wait, surface clean stop).
      if (initialAvatarVideo && hiddenEl.readyState < 2 /* HAVE_CURRENT_DATA */) {
        const ready = await new Promise<boolean>((resolve) => {
          const onLoaded = (): void => { cleanup(); resolve(true); };
          const onTimeout = (): void => { cleanup(); resolve(false); };
          const cleanup = (): void => {
            hiddenEl.removeEventListener('loadedmetadata', onLoaded);
            hiddenEl.removeEventListener('canplay', onLoaded);
            window.clearTimeout(timeoutId);
          };
          const timeoutId = window.setTimeout(onTimeout, 1000);
          hiddenEl.addEventListener('loadedmetadata', onLoaded, { once: true });
          hiddenEl.addEventListener('canplay', onLoaded, { once: true });
        });
        if (seq !== armRequestSeqRef.current) {
          // A reset / unmount / signalAskSessionEnded fired during the
          // loadedmetadata wait. PERMISSION_GRANTED hasn't been dispatched
          // yet, so the reducer is still in 'priming' — dispatch RESET so
          // the surface doesn't get stuck (audit Small Day 3).
          dispatch({ type: 'RESET', nowMs: performance.now() });
          teardown();
          return;
        }
        if (!ready) {
          dispatch({ type: 'ASK_OPEN_TIMEOUT', nowMs: performance.now() });
          teardown();
          return;
        }
      }

      // Subscribe to mid-recording track replacements (LiveKit renegotiation).
      // Reuses the SAME hidden <video> element — never re-creates it (audit C1
      // Day 3 — connectSourceVideo is one-shot per AudioContext but we use
      // MediaStream srcObject which is mutate-only; for video tracks we just
      // replace tracks on the existing MediaStream).
      //
      // Pass replayInitial:false (audit C2/C3 Day 3) — we already consumed
      // the current tracks via bridge.getCurrentTracks() above. Without this
      // opt-out, the synchronous sub.replay would fire (removeTrack(t);
      // addTrack(t)) on the freshly-built stream and orphan the only frame
      // source for ~1 microtask, producing a black first frame on Safari.
      if (askDepsNow.subscribeTrackUpdates) {
        detachTrackUpdatesRef.current = askDepsNow.subscribeTrackUpdates((tracks) => {
          // Video: swap track on the same MediaStream → same <video> srcObject
          // → same DOM element → compositor's draw loop continues seamlessly.
          const stream = hiddenAvatarStreamRef.current;
          if (stream) {
            for (const t of stream.getVideoTracks()) {
              try { stream.removeTrack(t); } catch { /* */ }
            }
            if (tracks.video && tracks.video.readyState === 'live') {
              try { stream.addTrack(tracks.video); } catch { /* */ }
            }
          }
          // Audio: rebind mixer's avatar branch. bindTrack's M4 reset-on-id-change
          // cancels any in-flight duck-ramp on retrack.
          const mx = mixerRef.current;
          if (mx) {
            if (tracks.audio && tracks.audio.readyState === 'live') {
              try { mx.connectAvatar(tracks.audio); } catch { /* mixer closed mid-update */ }
            } else {
              try { mx.disconnectAvatar(); } catch { /* */ }
            }
          }
        }, { replayInitial: false });
      }
    } else {
      compositorSourceEl = getSourceVideoElRef.current();
    }

    const compositor = createCompositor({
      canvas,
      cameraVideoEl: camEl,
      sourceVideoEl: compositorSourceEl ?? null,
      watermarkBitmap: watermarkBitmap ?? null,
      referralUrl: resolvedReferralUrl,
      creatorHandle,
    });
    compositorRef.current = compositor;
    // Prime one frame before captureStream so Safari's first paint isn't black.
    compositor.drawFrame();

    // 8) MediaRecorder. Combine the canvas video stream + mixer audio track.
    const videoStream = canvas.captureStream(30);
    const audioTrack = mixer.recordingStream.getAudioTracks()[0];
    if (audioTrack) videoStream.addTrack(audioTrack);

    // Constructor fallback (audit M3 2026-05-08): some Android Chrome forks
    // return true from `MediaRecorder.isTypeSupported(<mp4 with codec params>)`
    // but throw NotSupportedError from the constructor for the same string.
    // Walk the supported list until one constructs successfully; only fail if
    // every candidate throws.
    let recorder: MediaRecorder | null = null;
    let mime: RecordingMime | null = null;
    let lastErr: unknown = null;
    for (const candidate of supportedMimes) {
      try {
        recorder = new MediaRecorder(videoStream, {
          mimeType: candidate.mimeType,
          videoBitsPerSecond: 2_000_000,
          audioBitsPerSecond: 128_000,
        });
        mime = candidate;
        break;
      } catch (e) {
        lastErr = e;
        captureSafe('react_recorder_construct_failed', {
          mode,
          platform,
          attempted_mime: candidate.mimeType,
          error: (e as Error)?.message ?? 'unknown',
        });
      }
    }
    if (!recorder || !mime) {
      dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: (lastErr as Error)?.message ?? 'no candidate constructible' });
      teardown();
      return;
    }
    recorderRef.current = recorder;
    blobChunksRef.current = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) blobChunksRef.current.push(e.data);
    };
    recorder.onerror = (e: Event) => {
      dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: (e as Event & { error?: { message?: string } }).error?.message ?? 'recorder error' });
    };
    recorder.onstop = () => {
      // Seq guard (audit C3): if reset() bumped the seq during the recorder
      // finalization window, drop the preview rather than populating a stale
      // ref or dispatching into the wrong reducer state.
      if (seq !== armRequestSeqRef.current) return;
      const blob = new Blob(blobChunksRef.current, { type: mime.mimeType });
      const cur = phaseRef.current;
      // stopReason fallback fix (audit M1): use the last-known reason from
      // the stopped/preview phase; only if neither (controller bug) do we
      // synthesize 'recorder_error'. This prevents over-counting that code
      // in PostHog telemetry.
      const armedAt = cur.kind === 'stopped' ? cur.armedAtMs : (cur.kind === 'preview' ? cur.armedAtMs : 0);
      const stoppedAt = cur.kind === 'stopped' ? cur.stoppedAtMs : performance.now();
      const stopReason: StopReason =
        cur.kind === 'stopped' ? cur.stopReason :
        cur.kind === 'preview' ? cur.stopReason : 'recorder_error';
      const durationMs = Math.max(0, stoppedAt - armedAt);
      previewRef.current = {
        blob,
        mimeType: mime.mimeType,
        durationMs,
        stopReason,
        shareShortId: activeTokenPlaintextRef.current,
      };
      captureSafe('react_stopped', {
        mode,
        // duration_ms is wall-clock armed→stopped and now INCLUDES the 1.5s
        // user-stop outro (it matches the blob's real length). outro_ms makes
        // the discontinuity explicit so pre/post-rework dashboards can
        // subtract it instead of seeing a phantom +1.5s shift (plan audit M1).
        duration_ms: durationMs,
        outro_ms: stopReason === 'user' ? END_CARD_MS : 0,
        stop_reason: stopReason,
        blob_size: blob.size,
        mime_type: mime.mimeType,
        container: mime.container,
        platform,
      });
      dispatch({ type: 'PREVIEW_ARRIVED', nowMs: performance.now(), durationMs });
      try { onStopRef.current?.(previewRef.current); } catch (e) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[recording-controller] onStop host callback threw:', e);
        }
      }
    };

    // 9) Start everything in order. start() AFTER captureStream + recorder.
    compositor.start();
    try {
      // 100ms timeslice so a mid-session crash still produces a useful blob.
      recorder.start(100);
    } catch (e) {
      dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: (e as Error).message });
      teardown();
      return;
    }

    if (seq !== armRequestSeqRef.current) {
      // Race: reset() during await chain. Bail.
      teardown();
      return;
    }
    const armedAtMs = performance.now();
    // Platform-branched SAFETY ceiling (uncapped rework — see the constant's
    // doc block: this is a client-RAM bound, not a cost bound).
    const capMs = maxRecordingMsForPlatform(platform);
    captureSafe('react_armed', {
      mode,
      ms_to_arm: Math.round(armedAtMs - tapAtMs),
      cap_ms: capMs,
      mime_type: mime.mimeType,
      container: mime.container,
      platform,
    });
    dispatch({ type: 'PERMISSION_GRANTED', nowMs: armedAtMs, capMs });
    // Uncapped rework: no fixed end-card setTimeout anymore. The end-card
    // now rises from TWO paths: (a) the user-tap 'stopping' outro effect
    // below, (b) the safety-cap endCardArmed TIMER_TICK backstop in the
    // reducer (final 1.5s before capDeadlineMs). enableEndCard is idempotent.
  }, [dispatch, enabled, mode, creatorHandle, referralUrl, creatorId, clipId, watermarkBitmap, teardown]);

  // ── ARMED side effects: safety-cap timer (armed ONLY) ────────────────
  // Plan audit M6 (uncapped rework): the tick interval and the background
  // listeners have different lifetimes — the interval drives the count-up
  // label + safety-cap check and must NOT run during the 'stopping' outro
  // (the reducer ignores TIMER_TICK there; ticking would only waste
  // renders), while the visibility/pagehide listeners MUST keep covering
  // 'stopping' so backgrounding mid-outro still stops immediately. Split
  // into two effects.
  useEffect(() => {
    if (phase.kind !== 'armed') return;

    const timerId = window.setInterval(() => {
      dispatch({ type: 'TIMER_TICK', nowMs: performance.now() });
      setTick((n) => n + 1);
    }, TIMER_TICK_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [phase.kind, dispatch]);

  // ── ARMED + STOPPING: visibility/pagehide → immediate stop ───────────
  useEffect(() => {
    if (phase.kind !== 'armed' && phase.kind !== 'stopping') return;

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        dispatch({ type: 'BACKGROUND', nowMs: performance.now() });
      }
    };
    const onPageHide = (): void => {
      dispatch({ type: 'BACKGROUND', nowMs: performance.now() });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [phase.kind, dispatch]);

  // ── STOPPING: outro — draw the end-card into the tail, then finalize ──
  // Uncapped rework: a user-tap stop enters 'stopping' for END_CARD_MS so
  // the referral end-card (the share CTA) is burned into the recording's
  // final 1.5s — pre-rework it only rendered on cap-stop, so user-stopped
  // recordings shipped without it. The compositor RAF loop is still alive
  // here (compositor.stop() only runs in teardown, after preview), and in
  // Ask mode the avatar bridge keeps streaming (stopping the RECORDING does
  // not touch the SESSION — interrupts like ASK_SESSION_ENDED abort the
  // outro via the reducer if the session dies mid-outro). The timeout is
  // cleared on phase exit, and the reducer ignores OUTRO_DONE outside
  // 'stopping', so a stale timer can't corrupt a later phase.
  useEffect(() => {
    if (phase.kind !== 'stopping') return;
    compositorRef.current?.enableEndCard();
    const outroId = window.setTimeout(() => {
      dispatch({ type: 'OUTRO_DONE', nowMs: performance.now() });
    }, END_CARD_MS);
    return () => {
      window.clearTimeout(outroId);
    };
  }, [phase.kind, dispatch]);

  // End-card rising-edge effect: kept as a backstop for the setTimeout
  // path (audit M2) — if the system clock is slow / suspended (mobile
  // backgrounding flow that doesn't trigger BACKGROUND), the reducer's
  // TIMER_TICK still flips endCardArmed. Compositor.enableEndCard is
  // idempotent so calling it from both places is safe.
  useEffect(() => {
    if (phase.kind === 'armed' && phase.endCardArmed) {
      compositorRef.current?.enableEndCard();
    }
  }, [phase]);

  // Mid-recording 'enabled' toggle (audit M6): if parent flips the flag
  // false during ARMED (or the 'stopping' outro), stop recording immediately.
  // We treat this as a BACKGROUND-class stop since the surface is no longer
  // permitted.
  useEffect(() => {
    if (!enabled && (phase.kind === 'armed' || phase.kind === 'stopping')) {
      dispatch({ type: 'BACKGROUND', nowMs: performance.now() });
    }
  }, [enabled, phase, dispatch]);

  // ── STOP transition: finalize the recorder + tear down ───────────────
  // The reducer transitions to 'stopped' synchronously. recorder.stop() is
  // async (onstop fires after a final dataavailable). We invoke stop() here;
  // the onstop wired in the ARM effect will dispatch PREVIEW_ARRIVED.
  useEffect(() => {
    if (phase.kind !== 'stopped') return;
    const r = recorderRef.current;
    // state !== 'inactive' so a future paused-by-iOS-bg state also stops
    // (audit M5).
    if (r && r.state !== 'inactive') {
      // requestData() before stop() so Safari's MP4 moov atom finalizes
      // with the in-flight chunks (Plan §6 — Safari sometimes emits a
      // partial-incomplete blob without this).
      try { r.requestData(); } catch { /* unsupported on Safari < 14 */ }
      try { r.stop(); } catch { /* recorder already stopped */ }
    } else if (!r) {
      // No recorder — synthesize PREVIEW_ARRIVED with 0 duration so the
      // surface doesn't get stuck in STOPPED.
      dispatch({ type: 'PREVIEW_ARRIVED', nowMs: performance.now(), durationMs: 0 });
    }
    // Compositor + mixer + cam-stream cleanup happens in dismissPreview/reset
    // — we keep the canvas + cam <video> alive during STOPPED→PREVIEW so the
    // preview UI can grab a thumbnail or display the captured stream.
  }, [phase, dispatch]);

  // ── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => {
      armRequestSeqRef.current += 1; // invalidate any in-flight permission/grant
      teardown();
      previewRef.current = null;
    };
  }, [teardown]);

  // ── Public handle ────────────────────────────────────────────────────

  const reset = useCallback((): void => {
    armRequestSeqRef.current += 1;
    teardown();
    previewRef.current = null;
    dispatch({ type: 'RESET', nowMs: performance.now() });
  }, [dispatch, teardown]);

  const signalAskSessionEnded = useCallback((): void => {
    // Audit M1 Day 3 — bump the seq so an in-flight priming arm (mic permission
    // prompt open when the Ask scene closes) bails on resume. Without this,
    // the post-permission code wires mic into an already-closed AudioContext
    // borrowed from the dead pipe and bubbles an unhandled rejection.
    armRequestSeqRef.current += 1;
    dispatch({ type: 'ASK_SESSION_ENDED', nowMs: performance.now() });
  }, [dispatch]);

  const discardByUser = useCallback((): void => {
    // Audit C3 Day 4 — explicit user-initiated Discard (preview modal button).
    // Revokes the referral token BEFORE teardown clears the plaintext ref.
    // Fire-and-forget POST: failure shouldn't block the UX (the token will
    // expire naturally at 90d if the revoke route is unreachable).
    const tokenToRevoke = activeTokenPlaintextRef.current;
    if (tokenToRevoke && process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED === '1') {
      // No await — controller proceeds with dismissPreview teardown immediately.
      // keepalive:true (audit C3 cross-cutting Day 4) so the request survives
      // a tab close right after Discard. Without it, the browser cancels the
      // in-flight fetch and the token never gets revoked → 90-day-valid
      // token in the wild that the user thought they killed.
      void fetch('/api/recording/discard', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: tokenToRevoke }),
        keepalive: true,
      }).catch(() => { /* non-fatal */ });
    }
    armRequestSeqRef.current += 1;
    teardown();
    previewRef.current = null;
    dispatch({ type: 'PREVIEW_DISMISSED', nowMs: performance.now() });
  }, [dispatch, teardown]);

  const dismissPreview = useCallback((): void => {
    // Audit C2 (day-2): the camStream + AudioContext + canvas + watcher
    // were being kept alive deliberately during STOPPED→PREVIEW so the
    // preview UI could grab a thumbnail or display the captured stream.
    // Once the user dismisses, those resources MUST be released — the
    // record→preview→dismiss happy path was leaking the mic/camera LED,
    // an AudioContext (Chrome's 6-cap), and the off-screen <video>.
    armRequestSeqRef.current += 1;
    teardown();
    previewRef.current = null;
    dispatch({ type: 'PREVIEW_DISMISSED', nowMs: performance.now() });
  }, [dispatch, teardown]);

  const buttonState = selectButtonState(phase);
  const nowMs = performance.now();
  const armedSecondsElapsed =
    phase.kind === 'armed' ? selectArmedSecondsElapsed(phase, nowMs) : undefined;
  const armedSecondsRemaining =
    phase.kind === 'armed' ? selectArmedSecondsRemaining(phase, nowMs) : undefined;

  // Build discriminated-union ReactButtonProps. The button enforces the
  // discriminant at compile time (armed needs elapsed + remaining; disabled
  // accepts disabledReason).
  const buttonProps: ReactButtonProps = (() => {
    const common = { onTap: () => { void onTap(); }, creatorHandle };
    if (buttonState.state === 'armed') {
      return {
        ...common,
        state: 'armed' as const,
        // Count-UP display (uncapped rework). Fallback 0 — a count-up that
        // starts at 0:00 is the truthful "just armed" render; the old
        // full-cap fallback was wrong magnitude AND direction (plan audit M2).
        armedSecondsElapsed: armedSecondsElapsed ?? 0,
        // Safety-ceiling heads-up: the button surfaces this only in the
        // final 30s (plan audit M3). Infinity when unknowable → never warns.
        armedSecondsRemaining: armedSecondsRemaining ?? Number.POSITIVE_INFINITY,
      };
    }
    if (buttonState.state === 'disabled') {
      return {
        ...common,
        state: 'disabled' as const,
        disabledReason: buttonState.disabledReason,
      };
    }
    return { ...common, state: buttonState.state };
  })();

  return {
    buttonProps,
    preview: phase.kind === 'preview' ? previewRef.current : null,
    dismissPreview,
    reset,
    signalAskSessionEnded,
    discardByUser,
  };
}

/** Re-export the END_CARD_MS constant so surfaces using the controller
 *  don't need a second import path for the cap math. */
export { END_CARD_MS };
