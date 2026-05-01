// Camera + mic permission lifecycle for the React/duet capture feature.
// Wraps getUserMedia with a small structured error taxonomy, a localStorage
// memory of last-seen state (so subsequent React taps don't re-prompt
// when the browser already has the grant), and a track-revocation watcher
// for the mid-session-pulled-permission case.
//
// SSR-safe via typeof guards — NO 'use client' directive (audit R2 M3):
// adding one would force this leaf module into the client bundle of any
// server component that imports a TYPE from it (e.g. RecordingPermissionCode
// for a prop signature). The consuming client component carries 'use client'.
//
// Why localStorage and not IDB: the cached value is a tiny JSON blob
// ({granted, ts}); IDB's async API and quota machinery buy nothing here.
// This matches the existing oak_device_id pattern in src/lib/feed/device-id.ts.
//
// Surfaces consumed: REACT_DUET_PLAN.md §5 (permission choreography),
// §13 (file list).

const STORAGE_KEY = 'oak_recording_perm_v1';

// 30 days — a heuristic: the value is advisory ("did the browser grant
// us last time?"), not authoritative. Browsers can revoke any time.
// Stale-but-positive cache means the next requestMediaPermission call
// will optimistically getUserMedia; if the browser actually revoked,
// the call rejects and we map to 'denied'. No data loss either way.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export const RECORDING_PERMISSION_CODES = [
  'denied',         // NotAllowedError — user clicked No or dismissed prompt
  'no_device',      // NotFoundError — no camera or no mic on the device
  'in_use',         // NotReadableError — device is busy (another tab / app)
  'overconstrained',// OverconstrainedError — requested constraints unsatisfiable
  'unsupported',    // navigator.mediaDevices.getUserMedia missing
  'aborted',        // AbortError — page navigation, user gesture interrupted
  'security',       // SecurityError — origin not trusted (insecure context)
  'disabled',       // synthesized by requestMediaPermission only — the
                    // NEXT_PUBLIC_REACT_CAPTURE_ENABLED kill-switch is off.
                    // Never produced by mapMediaError (no DOMException maps
                    // to this code).
  'unknown',
] as const;

export type RecordingPermissionCode = (typeof RECORDING_PERMISSION_CODES)[number];

export class RecordingPermissionError extends Error {
  readonly code: RecordingPermissionCode;
  readonly cause?: unknown;
  constructor(code: RecordingPermissionCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'RecordingPermissionError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

// Pure helper. Exported for unit tests; consumers should not call directly.
export function mapMediaError(err: unknown): RecordingPermissionError {
  // DOMException is what getUserMedia rejects with. Match by name; the
  // .message text is browser-localized and not safe to depend on.
  const name = (err as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError': // legacy Chromium alias
      return new RecordingPermissionError('denied', 'permission denied or prompt dismissed', err);
    case 'NotFoundError':
    case 'DevicesNotFoundError':  // legacy
      return new RecordingPermissionError('no_device', 'no camera or microphone available', err);
    case 'NotReadableError':
    case 'TrackStartError':       // legacy
      return new RecordingPermissionError('in_use', 'camera or mic in use by another application', err);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new RecordingPermissionError('overconstrained', 'requested capture constraints unsatisfiable', err);
    case 'AbortError':
      return new RecordingPermissionError('aborted', 'permission request aborted', err);
    case 'SecurityError':
      return new RecordingPermissionError('security', 'capture requires a secure context (https)', err);
    default:
      return new RecordingPermissionError('unknown', `getUserMedia rejected: ${String(name ?? 'unknown')}`, err);
  }
}

// localStorage memory — best-effort. Storage exceptions (Safari private
// mode, disabled cookies) are swallowed; the lib falls back to "always
// prompt" behavior, which is correct in those environments.
type CacheValue = { granted: boolean; ts: number };

function readCache(): CacheValue | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheValue>;
    if (typeof parsed.granted !== 'boolean' || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return { granted: parsed.granted, ts: parsed.ts };
  } catch {
    return null;
  }
}

function writeCache(granted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ granted, ts: Date.now() }));
  } catch {
    // private mode, quota exceeded — fail silently.
  }
}

export function clearPermissionMemory(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}

// Detailed query — returns per-device states so callers can light up the
// audio-only fallback when camera is denied but mic is granted (audit R2 M1).
// Safari returns 'unsupported' for both because permissions.query throws
// TypeError on camera/microphone names (through 18.x).
//
// Audit S6 (integration): the union deliberately collapses
// {camera:'unsupported', microphone:'unsupported'} into a single shape —
// there is no way to express "Safari knows mic but not camera." That
// hybrid case was non-existent on Safari at writing; if it ever ships,
// extend the union (don't try to split the lib's branching).
export type DetailedPermissionState =
  | { camera: 'granted' | 'denied' | 'prompt'; microphone: 'granted' | 'denied' | 'prompt' }
  | { camera: 'unsupported'; microphone: 'unsupported' };

export async function queryDetailedPermissionState(): Promise<DetailedPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return { camera: 'unsupported', microphone: 'unsupported' };
  }
  try {
    const [camera, microphone] = await Promise.all([
      navigator.permissions.query({ name: 'camera' as PermissionName }),
      navigator.permissions.query({ name: 'microphone' as PermissionName }),
    ]);
    return {
      camera:     camera.state     as 'granted' | 'denied' | 'prompt',
      microphone: microphone.state as 'granted' | 'denied' | 'prompt',
    };
  } catch {
    return { camera: 'unsupported', microphone: 'unsupported' };
  }
}

// Convenience collapse for the single-signal callers (e.g. ReactButton's
// pre-prompt readiness check). Use queryDetailedPermissionState directly
// when you need to branch on camera-vs-mic separately.
export async function queryPermissionState(): Promise<PermissionState> {
  const d = await queryDetailedPermissionState();
  if (d.camera === 'unsupported') return 'unsupported';
  if (d.camera === 'denied'  || d.microphone === 'denied')  return 'denied';
  if (d.camera === 'granted' && d.microphone === 'granted') return 'granted';
  return 'prompt';
}

export type RequestOptions = {
  /** Default true. Set false for audio-only fallback (camera-denied path). */
  video?: boolean;
  /** Default true. Always set true for the full duet path. */
  audio?: boolean;
  /** Optional AbortSignal — aborts the in-flight permission prompt if signaled.
   *  Note: the underlying browser prompt cannot be canceled (no API). When
   *  aborted, if getUserMedia later resolves with a stream, we release it
   *  immediately so the camera LED does not stay on (audit R2 C1). */
  signal?: AbortSignal;
};

export type RequestResult = {
  stream: MediaStream;
  /** True if the cache said granted before the call; false if first-time
   * or cache miss. Useful for telemetry: time-to-armed differs sharply
   * between a silent re-grant and a fresh prompt. */
  fromCache: boolean;
};

// Single entry point. Throws RecordingPermissionError on any failure so
// callers can branch by code (.code === 'denied' → fallback CTA, etc).
export async function requestMediaPermission(opts: RequestOptions = {}): Promise<RequestResult> {
  // Kill-switch defense in depth (audit C3 integration). The ReactButton
  // null-renders when the flag is off, but a future caller (Day-2
  // controller, admin debug surface, Storybook entry, test harness) can
  // import this lib directly. Refuse to fire the camera prompt under the
  // off state — same flag that gates Mux crossOrigin (Plan §20.2 — flag
  // is unified per R3 M5).
  //
  // Reads at runtime: in the browser this is the build-time-inlined
  // literal (Next.js webpack DefinePlugin); on Node/SSR/server actions it
  // reads live process.env (Next exposes NEXT_PUBLIC_* on the server too).
  // Both surfaces produce the right kill-switch behavior. This lib is
  // intended for CLIENT use; the only legitimate server import is tests.
  if (process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED !== '1') {
    throw new RecordingPermissionError('disabled', 'recording feature disabled via NEXT_PUBLIC_REACT_CAPTURE_ENABLED');
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new RecordingPermissionError('unsupported', 'navigator.mediaDevices.getUserMedia is not available');
  }
  if (opts.signal?.aborted) {
    throw new RecordingPermissionError('aborted', 'request aborted before start');
  }

  const constraints: MediaStreamConstraints = {
    video: opts.video ?? true,
    audio: opts.audio ?? true,
  };

  const cached = readCache();
  const fromCache = cached?.granted === true;

  // Underlying request. We track this separately from the race so a late
  // resolution (race lost to abort) can release the stream.
  const requestPromise: Promise<MediaStream> = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      writeCache(true);
      return stream;
    } catch (err) {
      const mapped = mapMediaError(err);
      // Only persist 'denied' to the cache. Other codes (in_use,
      // no_device, aborted) reflect transient hardware state, not a
      // permission decision; don't overwrite a prior 'granted' bit.
      if (mapped.code === 'denied') writeCache(false);
      throw mapped;
    }
  })();

  if (!opts.signal) return { stream: await requestPromise, fromCache };

  const signal = opts.signal;
  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new RecordingPermissionError('aborted', 'request aborted by signal')),
      { once: true },
    );
  });

  try {
    const stream = await Promise.race([requestPromise, abortPromise]);
    return { stream, fromCache };
  } catch (err) {
    // Audit R2 C1: if abort won the race but the underlying getUserMedia
    // later resolves with a stream, release it so the camera LED does
    // not stay on after the user-perceived cancel. Attach unconditionally
    // — if requestPromise rejects, the rejection handler is a no-op.
    if (signal.aborted) {
      requestPromise.then(
        (s) => releaseStream(s),
        () => {/* late rejection — already handled or ignored */},
      );
    }
    throw err;
  }
}

// ── attachRevokeWatcher ─────────────────────────────────────────────────
// Watch for mid-session permission revocation. Most common trigger on
// iOS: user opens Settings → Safari → flips camera off → returns. The
// MediaStreamTrack 'ended' event fires (not synchronous with the flip;
// usually within 1-2s when the OS evicts the capture device). 'mute'
// fires on transient interruption (e.g. another app grabbing the camera).
//
// Idempotent under repeated attach (audit R2 M2) — multiple subscribers
// to the same stream share a single pair of listeners on each track.
// Required for React StrictMode dev double-invoke + route transitions
// that would otherwise leave dangling listeners.
//
// Constraint (audit R3 M2): the watcher binds to the tracks present
// at the first attach. If the caller later mutates the stream
// (`stream.addTrack(...)` post-attach), the new track is NOT watched.
// For getUserMedia-derived streams this is fine (the stream's tracks
// are fixed at creation). Callers that swap tracks (e.g. an audio-
// only fallback retry) should release the old stream and attach to a
// fresh one rather than mutating in place.
type WatcherEntry = {
  callbacks: Set<(reason: 'ended' | 'mute') => void>;
  detach: () => void;
};
const watchers = new WeakMap<MediaStream, WatcherEntry>();

export function attachRevokeWatcher(
  stream: MediaStream,
  onRevoke: (reason: 'ended' | 'mute') => void,
): () => void {
  let entry = watchers.get(stream);
  if (!entry) {
    const callbacks = new Set<(reason: 'ended' | 'mute') => void>();
    const tracks = stream.getTracks();
    const onEnded = () => { for (const cb of callbacks) cb('ended'); };
    const onMute  = () => { for (const cb of callbacks) cb('mute');  };
    for (const t of tracks) {
      t.addEventListener('ended', onEnded);
      t.addEventListener('mute',  onMute);
    }
    entry = {
      callbacks,
      detach: () => {
        for (const t of tracks) {
          t.removeEventListener('ended', onEnded);
          t.removeEventListener('mute',  onMute);
        }
        watchers.delete(stream);
      },
    };
    watchers.set(stream, entry);
  }
  entry.callbacks.add(onRevoke);
  const captured = entry;
  return () => {
    captured.callbacks.delete(onRevoke);
    if (captured.callbacks.size === 0) captured.detach();
  };
}

// Fully release a stream — stop all tracks. Idempotent. Stops cameras
// LEDs immediately on Chrome and within a frame on Safari.
export function releaseStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try { t.stop(); } catch { /* track already stopped */ }
  }
}
