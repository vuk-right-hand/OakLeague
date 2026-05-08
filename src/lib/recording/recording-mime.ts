// MediaRecorder MIME selection (Plan §6 — output is whatever the browser
// produces; no v1 transcode). Probe with MediaRecorder.isTypeSupported and
// pick the first match in priority order. Returns the chosen MIME plus the
// container extension so callers can build a sensible filename.
//
// Browser priorities:
//   iOS Safari 17+   prefers mp4 (avc1+aac).
//   Android Chrome   prefers mp4 (avc1+aac) — WhatsApp on Android refuses
//                    WebM containers entirely (verified 2026-05-08, both
//                    direct-share and Photos→WhatsApp paths). Android Chrome
//                    113+ supports MP4 in MediaRecorder; we fall back to
//                    WebM only if the device probe says MP4 is unsupported.
//   Desktop Chrome   prefers webm (vp9+opus) — desktop downloads, never
//                    shares to a mobile messenger directly.
//   Desktop Safari   prefers mp4.

export type RecordingMime = {
  /** The full MediaRecorder mimeType string with codec params. */
  mimeType: string;
  /** Container extension for the output filename (no leading dot). */
  extension: 'mp4' | 'webm';
  /** Coarse container kind for Web Share API capability decisions. */
  container: 'mp4' | 'webm';
};

// Priority list — mobile share surfaces (iOS, desktop-Safari, Android) get
// mp4 first; desktop/unknown lead with webm/vp9 because they download rather
// than share to a chat app. Each entry is probed against
// MediaRecorder.isTypeSupported in order. The controller iterates the
// supported subset, attempting MediaRecorder construction on each — some
// Android Chrome forks return true from isTypeSupported but throw
// NotSupportedError from the constructor for the same string.
const MP4_AVCC_AAC = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
const MP4_AVC1_AAC = 'video/mp4;codecs=avc1,mp4a.40.2';
const WEBM_VP9_OPUS = 'video/webm;codecs=vp9,opus';
const WEBM_VP8_OPUS = 'video/webm;codecs=vp8,opus';
const WEBM_BARE = 'video/webm';
const MP4_BARE = 'video/mp4';

/** UA-classification for priority order. Exported for tests + telemetry. */
export type Platform = 'ios' | 'android' | 'desktop-safari' | 'desktop' | 'unknown';

export function classifyPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  // iOS includes iPad on iPadOS 13+ (which masquerades as Mac). Treat any
  // touch-capable Mac as iPad. The Plan §6 table treats iOS Safari as a
  // mp4-first surface; the masquerade case fits that.
  const isIPadOS = /macintosh/.test(ua) && typeof navigator !== 'undefined'
    && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints != null
    && ((navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ?? 0) > 1;
  if (/iphone|ipad|ipod/.test(ua) || isIPadOS) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/safari/.test(ua) && !/chrome|chromium|edg/.test(ua)) return 'desktop-safari';
  if (/chrome|chromium|edg|firefox/.test(ua)) return 'desktop';
  return 'unknown';
}

/** Pure helper — returns the priority list a given platform should probe.
 *  Exported separately so tests can assert ordering without monkey-patching
 *  MediaRecorder. */
export function priorityList(platform: Platform): string[] {
  // mp4-first for every mobile-share surface. Android joined the mp4-first
  // list 2026-05-08 because WhatsApp on Android refuses webm — and TT/IG/X/FB
  // all accept mp4 too, so there's no mobile-share surface left where webm
  // beats mp4.
  if (platform === 'ios' || platform === 'desktop-safari' || platform === 'android') {
    return [MP4_AVCC_AAC, MP4_AVC1_AAC, MP4_BARE, WEBM_VP9_OPUS, WEBM_VP8_OPUS, WEBM_BARE];
  }
  // desktop, unknown — webm-first (desktop downloads, doesn't share to chat apps).
  return [WEBM_VP9_OPUS, WEBM_VP8_OPUS, WEBM_BARE, MP4_AVCC_AAC, MP4_AVC1_AAC, MP4_BARE];
}

/** Pure helper — chooses a MIME from the candidate list given a probe
 *  function. Tests inject a fake `isSupported`; runtime callers pass
 *  MediaRecorder.isTypeSupported.bind(MediaRecorder). */
export function pickMime(
  candidates: readonly string[],
  isSupported: (mime: string) => boolean,
): RecordingMime | null {
  for (const candidate of candidates) {
    if (isSupported(candidate)) {
      const container = candidate.startsWith('video/mp4') ? 'mp4' : 'webm';
      return { mimeType: candidate, extension: container, container };
    }
  }
  return null;
}

/** Top-level entry. Reads navigator.userAgent + MediaRecorder.isTypeSupported,
 *  returning the classified platform and ALL supported MIMEs in priority
 *  order. Controller iterates `mimes` and tries MediaRecorder construction
 *  on each — `isTypeSupported` returning true is necessary but not
 *  sufficient on some Android Chrome forks. `platform` flows into telemetry
 *  so we can split webm vs mp4 outcomes by surface after a rollout. */
export function probeRecording(): { platform: Platform; mimes: RecordingMime[] } {
  if (typeof MediaRecorder === 'undefined' || typeof navigator === 'undefined') {
    return { platform: 'unknown', mimes: [] };
  }
  const platform = classifyPlatform(navigator.userAgent || '');
  const mimes: RecordingMime[] = [];
  for (const candidate of priorityList(platform)) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      const container = candidate.startsWith('video/mp4') ? 'mp4' : 'webm';
      mimes.push({ mimeType: candidate, extension: container, container });
    }
  }
  return { platform, mimes };
}

/** First-supported helper preserved for callers that don't need the full list
 *  or platform classification. */
export function selectRecordingMime(): RecordingMime | null {
  return probeRecording().mimes[0] ?? null;
}
