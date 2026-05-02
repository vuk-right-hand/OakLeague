// React/duet capture audio graph.
//
// Static-gain mix (Plan §20.5 — VAD dropped from v1 after R2 audit found
// browser-side peak-detect ducks constantly under loud playback). Three gain
// branches → MediaStreamDestination for the MediaRecorder track:
//
//     mic       → gainMic    (1.0) ─┐
//     source    → gainSource (0.7) ─┼→ MediaStreamDestination → recording track
//     avatar    → gainAvatar (0.9) ─┘
//
// gainSource and gainAvatar ALSO connect to audioContext.destination so the
// user hears them through the speaker. gainMic does NOT — the user does not
// want to hear their own mic echoed back. Source goes via createMediaElement-
// Source, which steals the default-speaker routing of the <video> element
// (Web Audio gotcha), which is why we MUST re-pipe to ctx.destination.
//
// Avatar caller responsibility: silence the provider's <audio> element via
// AvatarBridge.setLocalPlayback(false) so the AudioContext path is the only
// audible route — otherwise the user hears the avatar twice (Plan §20.5).
//
// ── Lifecycle contracts (READ BEFORE EDITING) ──
//
// 1. **AudioContext ownership.** The caller owns the AudioContext. mixer.close()
//    does NOT close it. A typical React parent will create one ctx per session
//    and explicitly close it on unmount; HMR reload-without-cleanup leaks
//    contexts (Chrome caps at ~6 — six dev refreshes and the page breaks).
//
// 2. **Track lifecycle.** disconnectMic / disconnectAvatar release the
//    Web Audio source node ONLY — they do NOT stop the underlying
//    MediaStreamTrack. The camera/mic LED stays lit until the track owner
//    (recording controller, getUserMedia caller) explicitly calls track.stop().
//
// 3. **Source-video binding is permanent and one-shot.** createMediaElement-
//    Source captures the element forever for the lifetime of the AudioContext
//    — disconnect()'ing the source node silences the element instead of
//    "restoring default routing" (W3C Web Audio §1.8.2). For that reason
//    there is no disconnectSourceVideo; connectSourceVideo can only be
//    called once per mixer instance, and the only teardown path is close()
//    plus a fresh AudioContext for the next session. Mid-session source
//    swaps (hook → avatar per Plan §20.10) are handled by leaving the
//    paused hook element wired (silent because paused) and adding the
//    avatar via connectAvatar() — not by re-binding the source branch.
//
// 4. **AudioContext.state.** If ctx.state === 'suspended' at construction
//    (autoplay policy / backgrounded PWA), the recording stream emits
//    silence until the caller awaits ctx.resume() following a user gesture.
//    The mixer does not auto-resume; that decision belongs to the recording
//    controller alongside its ARM gesture.

export const GAIN_MIC = 1.0;
export const GAIN_SOURCE = 0.7;
export const GAIN_AVATAR = 0.9;

export type AudioMixerOptions = {
  audioContext: AudioContext;
};

export interface AudioMixer {
  /** MediaStream containing exactly one audio track — pipe into MediaRecorder
   *  alongside the canvas video track. The track instance is stable across
   *  connect/disconnect calls; rebinding inputs does NOT replace the track. */
  readonly recordingStream: MediaStream;

  /** Attach the user's microphone track. Replaces existing mic if any.
   *  Idempotent on the same MediaStreamTrack instance OR on tracks that
   *  share a track.id (StrictMode double-invoke + parent re-renders that
   *  recreate the track wrapper would otherwise tear-down + rebuild the
   *  source on every render = audible glitch). NOTE: does NOT stop the
   *  track — caller owns lifecycle (release via track.stop()). */
  connectMic(track: MediaStreamTrack): void;
  disconnectMic(): void;

  /** Attach the source <video> element (hook MP4 / long-form HLS). ONE-SHOT
   *  per mixer instance: the element is bound forever for the lifetime of
   *  the AudioContext and can never be re-bound. Throws if called twice
   *  (even with the same element — calling with the same element is a
   *  no-op explicitly). To switch source mid-session, leave the paused old
   *  element wired and add a different branch (e.g. avatar). */
  connectSourceVideo(videoEl: HTMLMediaElement): void;

  /** Attach the avatar audio track from the provider's WebRTC pipe. Caller
   *  MUST also silence the provider's <audio> element via
   *  AvatarBridge.setLocalPlayback(false) to prevent double-route echo.
   *  Idempotent on the same track. NOTE: does NOT stop the track. */
  connectAvatar(track: MediaStreamTrack): void;
  disconnectAvatar(): void;

  /** Ramp the source-video gain to a target value over `durationMs`.
   *  Pass 0 to silence (e.g. mid-recording Ask-swap: the visual crossfade
   *  in composite-canvas runs 300ms; call setSourceGain(0, 300) at the
   *  same wall-clock moment so audio + video swap together). Pass back to
   *  GAIN_SOURCE (0.7) to restore. durationMs<=0 is an instant set.
   *  Audit C1 (integration) — without this, an Ask-swap leaves 300ms of
   *  overlapping hook + avatar audio in the recording. */
  setSourceGain(value: number, durationMs?: number): void;

  /** Ramp the avatar gain — symmetric with setSourceGain. Used to duck the
   *  avatar in the recording during user barge-in (the live audio at the
   *  bridge level is already paused; this only affects what's captured into
   *  the file). Pass 0.05 / 80ms for a typical duck; restore to GAIN_AVATAR
   *  on resume. Audit M4 (Day 3 plan) — the same cancel-scheduled-values
   *  treatment that setSourceGain has. */
  setAvatarGain(value: number, durationMs?: number): void;

  /** Tear down all gain nodes + sources. AudioContext lifecycle is the
   *  caller's — close() does NOT call audioContext.close(). */
  close(): void;
}

type Branch = {
  gain: GainNode;
  /** The active source node, if any. */
  source: AudioNode | null;
  /** For mic/avatar: the underlying track we're sourced from (identity for
   *  idempotence checks). For source-video: the videoEl. */
  inputId: MediaStreamTrack | HTMLMediaElement | null;
  /** track.id snapshot — secondary key for idempotence when a parent
   *  recreates the MediaStreamTrack wrapper but the underlying track id
   *  is unchanged. */
  inputTrackId: string | null;
  /** Whether gain is wired to ctx.destination (speaker). False for mic. */
  audible: boolean;
};

export function createAudioMixer(opts: AudioMixerOptions): AudioMixer {
  const ctx = opts.audioContext;
  const dest = ctx.createMediaStreamDestination();

  function makeBranch(gainValue: number, audible: boolean): Branch {
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    gain.connect(dest);
    if (audible) gain.connect(ctx.destination);
    return { gain, source: null, inputId: null, inputTrackId: null, audible };
  }

  const micBranch    = makeBranch(GAIN_MIC,    /*audible*/ false);
  const sourceBranch = makeBranch(GAIN_SOURCE, /*audible*/ true);
  const avatarBranch = makeBranch(GAIN_AVATAR, /*audible*/ true);

  // Track-input idempotence: rebinding the same MediaStreamTrack — by
  // identity OR by track.id — is a no-op. Identity covers stable refs;
  // track.id covers React StrictMode double-invoke / parent re-renders
  // that wrap the track in a new object but expose the same underlying id.
  function bindTrack(branch: Branch, track: MediaStreamTrack, defaultGain?: number): void {
    if (branch.inputId === track) return;
    if (track.id && branch.inputTrackId === track.id) {
      branch.inputId = track; // refresh ref, keep node
      return;
    }
    if (branch.source) {
      try { branch.source.disconnect(); } catch { /* already disconnected */ }
    }
    const stream = new MediaStream([track]);
    const node = ctx.createMediaStreamSource(stream);
    node.connect(branch.gain);
    branch.source = node;
    branch.inputId = track;
    branch.inputTrackId = track.id || null;
    // Audit M4 (Day 3): if a duck-ramp was in flight on this branch's gain
    // when LiveKit replaced the track, the GainNode persists with whatever
    // partial value the ramp had reached (e.g. 0.4). Cancel any scheduled
    // ramp and snap back to the branch default so the new track plays at
    // expected volume rather than leaking the duck across the renegotiation.
    if (defaultGain !== undefined) {
      const param = branch.gain.gain;
      try { param.cancelScheduledValues(ctx.currentTime); } catch { /* spec-tolerant */ }
      param.value = defaultGain;
    }
  }

  function unbind(branch: Branch): void {
    if (branch.source) {
      try { branch.source.disconnect(); } catch { /* already disconnected */ }
    }
    branch.source = null;
    branch.inputId = null;
    branch.inputTrackId = null;
  }

  let closed = false;
  function ensureOpen(): void {
    if (closed) throw new Error('AudioMixer: method called after close()');
  }

  // Shared ramp helper for setSourceGain / setAvatarGain. Linear ramp with a
  // setValueAtTime anchor so chained ramps don't ramp from a future scheduled
  // value. Sub-render-quantum chained ramps may produce a single-sample step;
  // acceptable for human-time (80–300ms) duck/swap use cases.
  function rampGain(param: AudioParam, value: number, durationMs?: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    if (!durationMs || durationMs <= 0) {
      try { param.cancelScheduledValues(ctx.currentTime); } catch { /* spec-tolerant */ }
      param.value = clamped;
      return;
    }
    const t0 = ctx.currentTime;
    try { param.cancelScheduledValues(t0); } catch { /* spec-tolerant */ }
    param.setValueAtTime(param.value, t0);
    param.linearRampToValueAtTime(clamped, t0 + durationMs / 1000);
  }

  return {
    recordingStream: dest.stream,

    connectMic(track: MediaStreamTrack): void {
      ensureOpen();
      bindTrack(micBranch, track);
    },
    disconnectMic(): void {
      ensureOpen();
      unbind(micBranch);
    },

    connectSourceVideo(videoEl: HTMLMediaElement): void {
      ensureOpen();
      if (sourceBranch.inputId === videoEl) return;
      if (sourceBranch.inputId !== null) {
        // One-shot: createMediaElementSource captures the element forever
        // for the lifetime of the AudioContext. disconnect()ing the source
        // node would silence the OLD element instead of restoring its
        // default speaker route — the W3C-spec'd behavior, not a quirk.
        // Throw so the caller knows to spin up a fresh AudioContext + mixer.
        throw new Error(
          'AudioMixer.connectSourceVideo: already bound to a different element. ' +
          'createMediaElementSource is permanent per AudioContext — recreate the mixer.',
        );
      }
      const node = ctx.createMediaElementSource(videoEl);
      node.connect(sourceBranch.gain);
      sourceBranch.source = node;
      sourceBranch.inputId = videoEl;
    },

    connectAvatar(track: MediaStreamTrack): void {
      ensureOpen();
      // Pass GAIN_AVATAR so a retrack mid-duck restores expected loudness.
      bindTrack(avatarBranch, track, GAIN_AVATAR);
    },
    disconnectAvatar(): void {
      ensureOpen();
      // Audit C2 (integration): Safari (WebKit bug 217983) throws
      // InvalidStateError on disconnect() when the underlying track is
      // readyState='ended'. Defensively skip disconnect on a dead track —
      // the gain node is GC'd by close() anyway. Preferred caller order
      // is mixer.disconnectAvatar() BEFORE bridge.close(), but this guard
      // makes the inverse safe too.
      //
      // The cast assumes inputId on the avatar branch is a MediaStreamTrack
      // (only bindTrack writes there). The type union also permits
      // HTMLMediaElement to satisfy connectSourceVideo, but the avatar
      // branch never receives one. We duck-type via `'readyState' in x`
      // rather than `instanceof MediaStreamTrack` because Node test env
      // uses plain object stubs that don't extend the DOM constructor.
      const candidate = avatarBranch.inputId;
      const track =
        candidate && typeof candidate === 'object' && 'readyState' in candidate
          ? (candidate as MediaStreamTrack)
          : null;
      if (track && track.readyState === 'ended') {
        avatarBranch.source = null;
        avatarBranch.inputId = null;
        avatarBranch.inputTrackId = null;
        return;
      }
      unbind(avatarBranch);
    },

    setSourceGain(value: number, durationMs?: number): void {
      ensureOpen();
      rampGain(sourceBranch.gain.gain, value, durationMs);
    },

    setAvatarGain(value: number, durationMs?: number): void {
      ensureOpen();
      rampGain(avatarBranch.gain.gain, value, durationMs);
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const branch of [micBranch, sourceBranch, avatarBranch]) {
        if (branch.source) {
          try { branch.source.disconnect(); } catch { /* */ }
        }
        try { branch.gain.disconnect(); } catch { /* */ }
        branch.source = null;
        branch.inputId = null;
        branch.inputTrackId = null;
      }
    },
  };
}
