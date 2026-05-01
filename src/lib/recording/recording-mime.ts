// MediaRecorder MIME selection (Plan §6 — output is whatever the browser
// produces; no v1 transcode). Probe with MediaRecorder.isTypeSupported and
// pick the first match in priority order. Returns the chosen MIME plus the
// container extension so callers can build a sensible filename.
//
// Browser priorities:
//   iOS Safari 17+   prefers mp4 (avc1+aac).
//   Android Chrome   prefers webm (vp9+opus).
//   Desktop Chrome   prefers webm (vp9+opus).
//   Desktop Safari   prefers mp4.
//
// Web Share API on iOS accepts mp4 natively. Android Chrome's share sheet
// accepts webm to most apps but TT/IG/X often re-encode anyway. Plan §6 is
// explicit that v1 ships a "Save & Share" CTA on Android (download the
// webm, user shares via system) rather than blocking on cross-container
// transcode.

export type RecordingMime = {
  /** The full MediaRecorder mimeType string with codec params. */
  mimeType: string;
  /** Container extension for the output filename (no leading dot). */
  extension: 'mp4' | 'webm';
  /** Coarse container kind for Web Share API capability decisions. */
  container: 'mp4' | 'webm';
};

// Priority list — iOS gets mp4 first; everywhere else, webm/vp9 leads.
// Each entry is probed against MediaRecorder.isTypeSupported in order.
// Empty-string fallback at the end means "let MediaRecorder pick"; we
// don't actually use it in v1 because partial-codec MIMEs without a
// concrete container produce inconsistent blobs.
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
  if (platform === 'ios' || platform === 'desktop-safari') {
    return [MP4_AVCC_AAC, MP4_AVC1_AAC, MP4_BARE, WEBM_VP9_OPUS, WEBM_VP8_OPUS, WEBM_BARE];
  }
  // android, desktop, unknown — webm-first.
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

/** Top-level entry. Reads navigator.userAgent + MediaRecorder.isTypeSupported.
 *  Returns null when MediaRecorder is unavailable OR no candidate is supported
 *  (iOS Safari < 14.3 falls in the "no candidate" bucket and the controller
 *  surfaces 'unsupported' to the user). */
export function selectRecordingMime(): RecordingMime | null {
  if (typeof MediaRecorder === 'undefined' || typeof navigator === 'undefined') return null;
  const platform = classifyPlatform(navigator.userAgent || '');
  return pickMime(priorityList(platform), (mime) => MediaRecorder.isTypeSupported(mime));
}
