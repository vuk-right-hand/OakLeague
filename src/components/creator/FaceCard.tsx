'use client';

// Creator Face card (WS5). Posts to /creator/api/face-upload, then polls
// /creator/api/face-upload/status until the face flips out of 'pending'.
// Leaner than the admin cell: no kebab-delete, no orphan-recover, no video
// tab (all admin-only). Overwrite is offered only while the creator is
// unpublished — once live, avatar identity changes go through an admin.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  hasExistingFace: boolean;
  published: boolean;
  pendingUpload: { uploadId: number; vendorFaceId: string } | null;
};

type Result =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'training'; uploadId: number; queuePosition: number | null }
  | { kind: 'ok'; overwrote: boolean }
  | { kind: 'error'; code: string; title: string; body: string; retryWithForce?: boolean };

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  no_image: { title: 'No photo selected', body: 'Pick a JPEG or PNG first.' },
  empty_image: { title: 'Photo is empty', body: 'That file is 0 bytes.' },
  face_too_large: { title: 'Photo too large', body: 'Maximum 4.5 MB. Export a smaller version.' },
  bad_mime: { title: 'Unsupported format', body: 'Use JPEG or PNG.' },
  bad_image_dims: { title: 'Resolution out of range', body: '256×256 min, 4096×4096 max.' },
  bad_aspect: { title: 'Aspect ratio out of range', body: 'Use 9:16, 16:9, or 1:1.' },
  rate_limit: { title: 'Daily limit reached', body: 'Max 3 successful trains per 24h.' },
  rate_limit_attempts: { title: 'Too many attempts', body: 'Wait 24h, then retry.' },
  already_face_trained: { title: 'You already have a face', body: 'Tick “replace” to overwrite it.' },
  face_locked_while_live: {
    title: 'Locked while live',
    body: 'Your profile is published, so the avatar face can’t be swapped here. Contact us to change it.',
  },
  face_state_drift: { title: 'Face changed mid-train', body: 'Refresh and start over.' },
  creator_has_active_sessions: { title: 'Live sessions in progress', body: 'Wait for open chats to end, then retry.' },
  face_train_failed: { title: 'The photo was rejected', body: 'Try a clear, centered, well-lit face photo.' },
  face_no_subject: { title: 'No face detected', body: 'Use a photo with a clearly visible face.' },
  face_train_unreachable: { title: 'Face service unreachable', body: 'Try again in a minute.' },
  simli_quota_exceeded: { title: 'Face slots full', body: 'Contact us — the account is at capacity.' },
  simli_queue_full: { title: 'Training queue busy', body: 'Another face is training. Try again shortly.' },
  consent_missing: { title: 'Consent needed', body: 'We don’t have your likeness consent on file. Contact us.' },
  face_upload_only_in_production: { title: 'Not available here', body: 'Face training runs on the live site only.' },
  network: { title: 'Network error', body: 'Check your connection and retry.' },
  unknown_error: { title: 'Upload failed', body: 'Try again.' },
};
const lookupError = (code: string) => ERROR_COPY[code] ?? { title: 'Upload failed', body: code };

const POLL_INTERVAL_MS = 3000;
const POLL_SOFT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

export function FaceCard({ hasExistingFace, published, pendingUpload }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const inFlightRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  useEffect(() => () => {
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
  }, []);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // Resume polling if a pending upload exists server-side (tab-close resume).
  useEffect(() => {
    if (pendingUpload && result.kind === 'idle') startPolling(pendingUpload.uploadId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startPolling(uploadId: number, initialQueue: number | null) {
    pollDeadlineRef.current = Date.now() + POLL_SOFT_TIMEOUT_MS;
    setResult({ kind: 'training', uploadId, queuePosition: initialQueue });

    async function tick() {
      if (Date.now() > pollDeadlineRef.current) {
        setResult({
          kind: 'error',
          code: 'face_train_still_training',
          title: 'Still training in the background',
          body: 'This is taking longer than usual. Refresh in a minute to pick up where it left off — don’t start a new upload.',
        });
        return;
      }
      try {
        const res = await fetch(`/creator/api/face-upload/status?uploadId=${uploadId}`, {
          method: 'GET',
          credentials: 'same-origin',
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          const code = String(body.error || 'unknown_error');
          setResult({ kind: 'error', code, ...lookupError(code) });
          return;
        }
        if (body.state === 'ready') {
          setResult({ kind: 'ok', overwrote: !!body.overwrote });
          router.refresh();
          return;
        }
        if (body.state === 'failed') {
          const code = String(body.error || 'face_train_failed');
          setResult({ kind: 'error', code, ...lookupError(code) });
          return;
        }
        setResult({
          kind: 'training',
          uploadId,
          queuePosition: typeof body.queuePosition === 'number' ? body.queuePosition : null,
        });
        pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      } catch (e) {
        console.error('[creator face poll]', e);
        pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
  }

  function onPick(f: File | null) {
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  async function submit(forceFlag: boolean) {
    if (inFlightRef.current) return;
    if (!file) {
      setResult({ kind: 'error', code: 'no_image', ...lookupError('no_image') });
      return;
    }
    if (file.size > MAX_BYTES) {
      setResult({ kind: 'error', code: 'face_too_large', ...lookupError('face_too_large') });
      return;
    }
    if (!/\.(jpe?g|png)$/i.test(file.name)) {
      setResult({ kind: 'error', code: 'bad_mime', ...lookupError('bad_mime') });
      return;
    }
    inFlightRef.current = true;
    setResult({ kind: 'uploading' });
    const fd = new FormData();
    fd.append('image', file);
    const url = forceFlag && hasExistingFace ? '/creator/api/face-upload?force=1' : '/creator/api/face-upload';
    try {
      const res = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const code = String(body.error || 'unknown_error');
        setResult({
          kind: 'error',
          code,
          ...lookupError(code),
          retryWithForce: code === 'already_face_trained' && hasExistingFace && !published,
        });
        return;
      }
      startPolling(Number(body.uploadId), typeof body.queuePosition === 'number' ? body.queuePosition : null);
    } catch (e) {
      setResult({ kind: 'error', code: 'network', title: 'Network error', body: (e as Error).message });
    } finally {
      inFlightRef.current = false;
    }
  }

  const busy = result.kind === 'uploading' || result.kind === 'training';
  const canOverwrite = hasExistingFace && !published;

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={sectionTitle}>Your face</h2>
        <span style={{ fontSize: 12, color: hasExistingFace ? '#4ad07a' : '#999' }}>
          {hasExistingFace ? 'Trained ✓' : 'Not set up'}
        </span>
      </div>
      <p style={{ marginTop: 8, opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>
        A clear, centered, well-lit photo of your face. We train your talking avatar from it.
        JPEG or PNG, up to 4.5 MB, 9:16 / 16:9 / 1:1.
      </p>

      {hasExistingFace && published && (
        <p style={{ marginTop: 8, fontSize: 13, color: '#c9a227' }}>
          Your profile is live, so the avatar face is locked here. Contact us to change it.
        </p>
      )}

      {(!hasExistingFace || canOverwrite) && (
        <div style={{ marginTop: 12 }}>
          <input
            type="file"
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            disabled={busy}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="preview"
              style={{ display: 'block', marginTop: 12, maxWidth: 180, borderRadius: 8 }}
            />
          )}
          {canOverwrite && (
            <label style={{ display: 'block', marginTop: 10, fontSize: 13, color: '#c9a227' }}>
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                disabled={busy}
                style={{ marginRight: 6 }}
              />
              Replace my current face
            </label>
          )}
          <button
            type="button"
            onClick={() => submit(force)}
            disabled={busy || !file}
            style={{ marginTop: 12 }}
          >
            {result.kind === 'uploading'
              ? 'Uploading…'
              : result.kind === 'training'
              ? `Training${result.queuePosition != null ? ` (queue #${result.queuePosition})` : ''}…`
              : 'Upload & train'}
          </button>
        </div>
      )}

      <div role="status" aria-live="polite" style={{ marginTop: 10 }}>
        {result.kind === 'ok' && (
          <div style={{ color: '#4ad07a', fontSize: 14 }}>
            <strong>Face trained.</strong> {result.overwrote ? 'Your previous face is being replaced.' : ''}
          </div>
        )}
        {result.kind === 'error' && (
          <div style={{ color: 'salmon', fontSize: 14 }}>
            <strong>{result.title}</strong>
            <div style={{ marginTop: 2 }}>{result.body}</div>
            {result.retryWithForce && (
              <button
                type="button"
                onClick={() => {
                  setForce(true);
                  void submit(true);
                }}
                style={{ marginTop: 6 }}
              >
                Replace existing face
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const card: React.CSSProperties = { padding: 16, border: '1px solid #222', borderRadius: 8 };
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: 0 };
