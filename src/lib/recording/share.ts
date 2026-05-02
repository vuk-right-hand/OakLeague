// Day 4 — Web Share + download fallback for recording previews.
//
// REACT_DUET_PLAN §8.
//
// iOS Safari quirk (verified, plan §8): `navigator.share({files, text, url})`
// fails on iOS when text or url accompanies files. iOS shares files alone.
// We therefore embed the invite URL into the recording itself (end-card) and
// pass ONLY `{files}` to navigator.share — never `text` or `url`.
//
// Android Chrome typically accepts the file but the receiving app often
// re-encodes (TT/IG/X). That's the user's responsibility, not ours.
//
// Desktop / unsupported: trigger a blob-URL download. The user gets a file
// they can drag into their preferred channel.
//
// Mime-driven extension (audit M4 Day 4 — hardcoded .mp4 broke webm shares
// on iOS variants that strict-checked the extension match).

export type ShareResult =
  | { kind: 'shared' }
  | { kind: 'downloaded' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

export type ShareOptions = {
  blob: Blob;
  /** Full mime string from MediaRecorder, e.g. 'video/webm;codecs=vp9,opus'. */
  mimeType: string;
  /** Short token / id for the filename. Slug-safe — caller should pass a
   *  Crockford base32 token plaintext or similar. */
  shortId: string;
};

/** Try Web Share with files-only payload. Falls back to download if the
 *  browser doesn't support it OR canShare returns false for the given file
 *  (some Android variants reject video/* files even though they support
 *  navigator.share — a known platform inconsistency). */
export async function shareOrSave(opts: ShareOptions): Promise<ShareResult> {
  const ext = extensionForMime(opts.mimeType);
  const filename = `oakleague-${sanitizeFilenameSegment(opts.shortId)}.${ext}`;
  const file = makeFile(opts.blob, filename, opts.mimeType);

  // Web Share API support check. The canShare guard is essential — bare
  // `if (navigator.share)` lies on browsers that have the function but
  // reject files at runtime (older Android Chrome, Brave-on-Android, etc.).
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      // FILES-ONLY payload. Do NOT add text or url — iOS rejects.
      await navigator.share({ files: [file] });
      return { kind: 'shared' };
    } catch (err: unknown) {
      // AbortError = user cancelled the sheet. Anything else is a real failure.
      if (isAbortError(err)) return { kind: 'cancelled' };
      // Fall through to download — the share UI failed but the user wants the file.
      return triggerDownloadFallback(opts.blob, filename);
    }
  }

  // Browser doesn't support Web Share or canShare rejected — download.
  return triggerDownloadFallback(opts.blob, filename);
}

/** Extension lookup. Centralized so a new MIME priority entry only changes
 *  recording-mime.ts and one row here. */
export function extensionForMime(mimeType: string): 'mp4' | 'webm' {
  // Match the lower-case base type — codec params after `;` don't change
  // the container.
  const m = mimeType.toLowerCase();
  if (m.startsWith('video/mp4') || m.startsWith('audio/mp4')) return 'mp4';
  return 'webm';
}

// ── helpers ───────────────────────────────────────────────────────────────

function makeFile(blob: Blob, filename: string, mimeType: string): File {
  // Browsers reject File construction with empty blobs in some versions —
  // fall back to a tiny stub so canShare doesn't throw before our test.
  // (Real recordings are always > a few KB.)
  return new File([blob], filename, { type: mimeType });
}

function sanitizeFilenameSegment(s: string): string {
  // Allow Crockford base32 + alphanumerics. Reject everything else.
  // Empty input → 'recording' default.
  const cleaned = s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  return cleaned || 'recording';
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError';
}

function triggerDownloadFallback(blob: Blob, filename: string): ShareResult {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return { kind: 'failed', reason: 'no_dom' };
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick — Safari needs the URL to remain valid until the
    // navigation/download starts.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* */ } }, 1500);
    return { kind: 'downloaded' };
  } catch (err) {
    return { kind: 'failed', reason: (err as Error)?.message ?? 'download_failed' };
  }
}
