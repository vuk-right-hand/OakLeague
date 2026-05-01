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

import { useCallback, useEffect, useReducer, useRef } from 'react';
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
import { selectRecordingMime } from './recording-mime';
import {
  MAX_RECORDING_MS,
  type RecordingPhase,
  type StopReason,
  recordingReducer,
  selectArmedSecondsRemaining,
  selectButtonState,
} from './recording-state-machine';
import type { ReactButtonProps } from '@/components/recording/ReactButton';

export type RecordingMode = 'hook' | 'longform' | 'ask';

export type RecordingPreview = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  stopReason: StopReason;
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
  /** Pre-minted referral URL (Plan R3-M3 — minted at open-check, not finalize,
   *  so the in-video URL == the share URL). */
  referralUrl: string;
  /** Pre-rasterized watermark bitmap. The hook does not own the SVG-to-bitmap
   *  rasterization (Plan §20.12 — caller pre-rasterizes once at module init
   *  to amortize the cost). Pass null to skip the logo blit. */
  watermarkBitmap?: ImageBitmap | HTMLImageElement | null;
  /** Optional. Fires once when STOP completes and a preview blob is ready. */
  onStop?: (preview: RecordingPreview) => void;
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
    watermarkBitmap, onStop,
  } = opts;
  void mode; // 'ask' wiring lands Day 3; 'hook'/'longform' both follow the same path

  // Latest-ref callback for the source <video> getter (audit C1 day-2). The
  // controller reads via getSourceVideoElRef.current() at tap time so a
  // late-arriving ref doesn't lose the source.
  const getSourceVideoElRef = useRef(getSourceVideoEl);
  useEffect(() => { getSourceVideoElRef.current = getSourceVideoEl; }, [getSourceVideoEl]);

  const [phase, dispatchRaw] = useReducer(recordingReducer, { kind: 'idle' as const });

  // Ref to onStop so async recorder.onstop doesn't capture a stale handler.
  const onStopRef = useRef(onStop);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);

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
  const blobChunksRef = useRef<Blob[]>([]);
  const previewRef = useRef<RecordingPreview | null>(null);
  const armRequestSeqRef = useRef(0); // race guard for stale PERMISSION_GRANTED dispatches
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
    try { mixerRef.current?.close(); } catch { /* */ }
    if (camStreamRef.current) {
      try { releaseStream(camStreamRef.current); } catch { /* */ }
    }
    if (camVideoElRef.current) {
      try { camVideoElRef.current.srcObject = null; } catch { /* */ }
      try { camVideoElRef.current.parentNode?.removeChild(camVideoElRef.current); } catch { /* */ }
    }
    if (audioCtxRef.current) {
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
    blobChunksRef.current = [];
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

    // Increment seq BEFORE dispatch so a concurrent reset() between the
    // increment and the TAP dispatch doesn't leave seq stale (audit M8).
    const seq = ++armRequestSeqRef.current;
    dispatch({ type: 'TAP', nowMs: performance.now() });

    // 1) Permission first — gates the whole stack.
    let stream: MediaStream;
    try {
      const result = await requestMediaPermission({ video: true, audio: true });
      if (seq !== armRequestSeqRef.current) {
        // A reset() or unmount intervened during the permission prompt.
        releaseStream(result.stream);
        return;
      }
      stream = result.stream;
    } catch (e) {
      const code = e instanceof RecordingPermissionError ? e.code : 'unknown';
      if (code === 'denied' || code === 'security') {
        dispatch({ type: 'PERMISSION_DENIED', nowMs: performance.now() });
      } else if (code === 'disabled' || code === 'unsupported') {
        dispatch({ type: 'CAP_HIT', reason: code === 'disabled' ? 'feature_disabled' : 'unsupported', nowMs: performance.now() });
      } else {
        dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: String(code) });
      }
      return;
    }
    camStreamRef.current = stream;

    // 2) Watch for mid-session revoke (camera flipped off in OS settings).
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

    // 4) MIME probe.
    const mime = selectRecordingMime();
    if (!mime) {
      dispatch({ type: 'CAP_HIT', reason: 'unsupported', nowMs: performance.now() });
      teardown();
      return;
    }

    // 5) AudioContext lazy-create. Browsers gate construction behind a
    //    user-gesture chain; the click event that triggered this handler
    //    qualifies. resume() if the constructor returns 'suspended'.
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* recording will be silent — surface anyway */ }
    }
    audioCtxRef.current = ctx;

    // 6) Mixer + branches. Mic is the user track; source is the page's
    //    hook/long-form <video> element. Avatar wiring is Day-3.
    const mixer = createAudioMixer({ audioContext: ctx });
    mixerRef.current = mixer;
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

    // 7) Compositor canvas. captureStream() must be called BEFORE start()
    //    per Safari first-paint contract.
    const canvas = document.createElement('canvas');
    canvas.width = COMPOSITE_WIDTH;
    canvas.height = COMPOSITE_HEIGHT;
    canvasRef.current = canvas;
    const compositor = createCompositor({
      canvas,
      cameraVideoEl: camEl,
      sourceVideoEl: sourceVideoEl ?? null,
      watermarkBitmap: watermarkBitmap ?? null,
      referralUrl,
      creatorHandle,
    });
    compositorRef.current = compositor;
    // Prime one frame before captureStream so Safari's first paint isn't black.
    compositor.drawFrame();

    // 8) MediaRecorder. Combine the canvas video stream + mixer audio track.
    const videoStream = canvas.captureStream(30);
    const audioTrack = mixer.recordingStream.getAudioTracks()[0];
    if (audioTrack) videoStream.addTrack(audioTrack);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(videoStream, {
        mimeType: mime.mimeType,
        videoBitsPerSecond: 2_000_000,
        audioBitsPerSecond: 128_000,
      });
    } catch (e) {
      dispatch({ type: 'RECORDER_ERROR', nowMs: performance.now(), message: (e as Error).message });
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
      previewRef.current = { blob, mimeType: mime.mimeType, durationMs, stopReason };
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
    dispatch({ type: 'PERMISSION_GRANTED', nowMs: performance.now() });
    // Schedule the end-card rising edge precisely (audit M2): setTimeout
    // fires within 1-2ms vs the 100ms TIMER_TICK granularity, hitting the
    // Plan §25.4 "1.5s ± 100ms" gate cleanly. Compositor.enableEndCard is
    // idempotent so a late ARMED→STOP race is safe.
    window.setTimeout(() => {
      if (seq !== armRequestSeqRef.current) return;
      compositorRef.current?.enableEndCard();
    }, MAX_RECORDING_MS - END_CARD_MS);
  }, [dispatch, enabled, creatorHandle, referralUrl, watermarkBitmap, teardown]);

  // ── ARMED side effects: cap timer + visibility + end-card ────────────
  useEffect(() => {
    if (phase.kind !== 'armed') return;

    const timerId = window.setInterval(() => {
      dispatch({ type: 'TIMER_TICK', nowMs: performance.now() });
    }, TIMER_TICK_MS);

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
      window.clearInterval(timerId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
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
  // false during ARMED, stop recording immediately. We treat this as a
  // BACKGROUND-class stop since the surface is no longer permitted.
  useEffect(() => {
    if (!enabled && phase.kind === 'armed') {
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
  const armedSecondsRemaining =
    phase.kind === 'armed' ? selectArmedSecondsRemaining(phase, performance.now()) : undefined;

  // Build discriminated-union ReactButtonProps. The button enforces the
  // discriminant at compile time (armed needs armedSecondsRemaining; disabled
  // accepts disabledReason).
  const buttonProps: ReactButtonProps = (() => {
    const common = { onTap: () => { void onTap(); }, creatorHandle };
    if (buttonState.state === 'armed') {
      return {
        ...common,
        state: 'armed' as const,
        armedSecondsRemaining: armedSecondsRemaining ?? MAX_RECORDING_MS / 1000,
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
  };
}

/** Re-export the END_CARD_MS constant so surfaces using the controller
 *  don't need a second import path for the cap math. */
export { END_CARD_MS };
