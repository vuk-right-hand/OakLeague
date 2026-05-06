'use client';
// Admin face-upload cell. Posts to /api/admin/face-upload then polls
// /api/admin/face-upload/status until state flips out of 'pending'.
//
// FACE_UI_PLAN §6 dual-lane UX:
//   - Photo tab live (Simli Trinity-1; image-only).
//   - Video tab greyed with tooltip "Available with Tavus/HeyGen."
// FACE_UI_PLAN §7 kebab-delete pattern: when a face is already trained,
// a 3-dot menu in the top-right reveals a Delete pill → confirm modal →
// POST /api/admin/simli-retrain. Replaces the standalone force-retrain
// button on /health.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type PendingUpload = {
  uploadId: number;
  vendorFaceId: string;
  createdAt: string;
};

type TimeoutOrphan = {
  uploadId: number;
  createdAt: string;
  lastError: string | null;
};

type Props = {
  creatorId: string;
  hasExistingFace: boolean;
  existingFaceId: string | null;
  // Auditor R2-M1 — server-side pending row for tab-close resume.
  pendingUpload: PendingUpload | null;
  // Path C — server-side timeout-orphan row eligible for recovery
  // via /api/admin/face-upload/recover (admin pastes the face_id
  // from Simli Studio).
  timeoutOrphan: TimeoutOrphan | null;
};

type UploadResponse = {
  ok: true;
  uploadId: number;
  faceId: string;
  state: 'pending';
  queuePosition: number | null;
  warnings: unknown[];
  overwrites: boolean;
};

type StatusResponse =
  | { ok: true; state: 'pending'; simliStatus?: string; queuePosition?: number | null }
  | { ok: true; state: 'ready'; faceId: string; warnings: unknown[]; overwrote?: boolean }
  | { ok: false; state: 'pending'; error?: string; activeSessions?: number; simliReachable?: boolean }
  | { ok: false; state: 'failed'; error?: string; lastError?: string };

type Result =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'training'; uploadId: number; faceId: string; queuePosition: number | null }
  | { kind: 'ok'; faceId: string; overwrote: boolean }
  | { kind: 'error'; code: string; title: string; body: string; retryWithForce?: boolean; activeSessions?: number };

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  bad_creator_id: { title: 'Creator id rejected', body: 'Refresh and try again.' },
  bad_name: { title: 'Name is required', body: 'Add a short name (≤80 chars).' },
  no_image: { title: 'No image attached', body: 'Pick a JPEG or PNG before submitting.' },
  empty_image: { title: 'Image is empty', body: 'The selected file is 0 bytes.' },
  face_too_large: { title: 'Image too large', body: 'Maximum 4.5 MB. Re-export at lower resolution.' },
  bad_mime: { title: 'Unsupported format', body: 'Use JPEG or PNG.' },
  bad_image_dims: { title: 'Image resolution out of range', body: 'Need 256×256 minimum, 4096×4096 maximum.' },
  bad_aspect: { title: 'Aspect ratio out of range', body: 'Use 9:16, 16:9, or 1:1 (±5% tolerance).' },
  rate_limit: { title: 'Daily limit reached', body: 'Maximum 3 successful trainings per 24h.' },
  rate_limit_attempts: { title: 'Too many attempts', body: 'Wait 24h or check Simli status before retrying.' },
  already_face_trained: {
    title: 'Concurrent upload won the race',
    body: 'Another tab/admin finished training a face for this creator before this one. The vendor face from this attempt was queued for cleanup. Refresh to see the live face; check the overwrite box only if you want to replace it.',
  },
  face_state_drift: {
    title: 'Face was retrained mid-train',
    body: 'Someone clicked Delete on this creator while the upload was still training. The vendor face from this attempt was queued for cleanup. Refresh and start over.',
  },
  creator_has_active_sessions: { title: 'Live sessions in progress', body: 'End active sessions before replacing the face.' },
  face_train_failed: { title: 'Simli rejected the image', body: 'Try a different photo. Persists? File a bug.' },
  face_train_unreachable: { title: 'Simli is unreachable', body: 'Vendor side is down. Retry in a minute.' },
  face_train_bad_response: { title: 'Simli returned malformed data', body: 'Retry in a minute. Persists? File a bug.' },
  face_no_subject: { title: 'Face not detected', body: 'Use a photo with a clearly visible, centered face.' },
  simli_quota_exceeded: { title: 'Simli quota exceeded', body: 'Upgrade the plan or delete an existing face slot.' },
  simli_queue_full: {
    title: 'Simli training queue full',
    body: 'Your Simli plan has another training request in the queue. Wait for it to complete (Hobby plan trains ~1 face every ~30–60 min depending on global queue depth) and try again. No need to retry the same photo immediately.',
  },
  simli_misconfig: { title: 'Server misconfigured', body: 'SIMLI_API_KEY is not set on this deployment.' },
  face_upload_only_in_production: { title: 'Production-only', body: 'Run face-upload from the production deployment.' },
  audit_insert_failed: { title: 'Audit row write failed', body: 'Refresh and try again. Persists? File a bug.' },
  register_failed: { title: 'Database write failed', body: 'Training started but row update failed. Re-run.' },
  finalize_failed: { title: 'Finalize step failed', body: 'Training succeeded but commit failed. Refresh — may already be applied.' },
  bad_origin: { title: 'Cross-origin blocked', body: 'Refresh from the admin tab.' },
  cross_origin: { title: 'Cross-origin blocked', body: 'Refresh from the admin tab.' },
  rate_lookup_failed: { title: 'Rate-limit lookup failed', body: 'Retry in a moment.' },
  creator_not_found: { title: 'Creator not found', body: 'This creator may have been deleted. Refresh.' },
  bad_multipart: { title: 'Upload was malformed', body: 'Refresh and try again.' },
  network: { title: 'Network error', body: 'Check your connection and retry.' },
  unknown_error: { title: 'Upload failed', body: 'See the code below.' },
};
function lookupError(code: string) {
  return ERROR_COPY[code] ?? { title: 'Upload failed', body: code };
}

function queueLabel(r: Extract<Result, { kind: 'training' }>): string {
  if (typeof r.queuePosition === 'number') return `#${r.queuePosition}`;
  return '…';
}

const POLL_INTERVAL_MS = 3000;
// Auditor R2-M5 — soft client-side timeout. Hits 'still training in
// background' UX rather than marking the upload failed (the server still
// owns the row's terminal state). Admin can refresh to rejoin polling
// per the M1 resume hook below.
const POLL_SOFT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

export function FaceUpload({ creatorId, hasExistingFace, existingFaceId, pendingUpload, timeoutOrphan }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<'photo' | 'video'>('photo');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [kebabOpen, setKebabOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [recoverFaceId, setRecoverFaceId] = useState('');
  const [recoverPending, setRecoverPending] = useState(false);
  const [recoverError, setRecoverError] = useState<{ title: string; body: string; code: string } | null>(null);
  const inFlightRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  // Cleanup poller on unmount.
  useEffect(() => () => {
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
  }, []);

  // Close kebab menu on outside click.
  useEffect(() => {
    if (!kebabOpen) return;
    function onClick() { setKebabOpen(false); }
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [kebabOpen]);

  // Auditor R2-M7 — ESC closes the kebab menu and the confirm modal
  // (when not in flight). Backdrop click already gated by deletePending.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (kebabOpen) setKebabOpen(false);
      if (confirmOpen && !deletePending) setConfirmOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kebabOpen, confirmOpen, deletePending]);

  // Auditor R2-M1 — auto-resume polling on page load if there's an
  // in-flight pending upload row server-side. Fires once on mount; the
  // poller below is idempotent (the status route handles all terminal
  // states even when called from a fresh client).
  useEffect(() => {
    if (!pendingUpload) return;
    if (result.kind !== 'idle') return;
    startPolling(pendingUpload.uploadId, pendingUpload.vendorFaceId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startPolling(uploadId: number, faceId: string, initialQueue: number | null) {
    pollDeadlineRef.current = Date.now() + POLL_SOFT_TIMEOUT_MS;
    setResult({ kind: 'training', uploadId, faceId, queuePosition: initialQueue });

    async function tick() {
      if (Date.now() > pollDeadlineRef.current) {
        // Auditor R2-M5 — soft timeout. Server-side row remains pending;
        // admin can refresh to resume. We do NOT mark failed here —
        // marking failed would orphan the still-training Simli face.
        setResult({
          kind: 'error',
          code: 'face_train_still_training',
          title: 'Still training in the background',
          body: 'Simli is taking longer than expected. Refresh the page in a minute and we will pick up where this left off. Do not start a new upload — it would orphan the in-flight one.',
        });
        return;
      }
      try {
        // Auditor R2-M2 — force flag is persisted on the audit row, not
        // a poll-level query param. Status route reads it server-side.
        const res = await fetch(`/api/admin/face-upload/status?uploadId=${uploadId}`, {
          method: 'GET',
          credentials: 'same-origin',
        });
        const body = (await res.json().catch(() => ({}))) as StatusResponse;

        if (!res.ok) {
          if (body && (body as { error?: string }).error === 'creator_has_active_sessions') {
            setResult({
              kind: 'error',
              code: 'creator_has_active_sessions',
              ...lookupError('creator_has_active_sessions'),
              activeSessions: typeof (body as { activeSessions?: number }).activeSessions === 'number'
                ? (body as { activeSessions?: number }).activeSessions
                : undefined,
            });
            return;
          }
          const code = String((body as { error?: string }).error || 'unknown_error');
          setResult({ kind: 'error', code, ...lookupError(code) });
          return;
        }

        if (body.state === 'ready') {
          setResult({
            kind: 'ok',
            faceId: body.faceId,
            overwrote: !!(body as { overwrote?: boolean }).overwrote,
          });
          router.refresh();
          return;
        }
        if (body.state === 'failed') {
          const code = String((body as { error?: string }).error || 'face_train_failed');
          setResult({ kind: 'error', code, ...lookupError(code) });
          return;
        }
        // pending — keep polling
        if (body.state === 'pending' && 'queuePosition' in body) {
          setResult({
            kind: 'training',
            uploadId,
            faceId,
            queuePosition: typeof body.queuePosition === 'number' ? body.queuePosition : null,
          });
        }
        pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      } catch (e) {
        // Transient — keep polling.
        console.error('[face-upload poll]', e);
        pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
  }

  async function submitWithForce(forceFlag: boolean) {
    if (inFlightRef.current) return;
    if (!file) {
      setResult({ kind: 'error', code: 'no_image', ...lookupError('no_image') });
      return;
    }
    if (!name.trim()) {
      setResult({ kind: 'error', code: 'bad_name', ...lookupError('bad_name') });
      return;
    }
    if (file.size > MAX_BYTES) {
      setResult({ kind: 'error', code: 'face_too_large', ...lookupError('face_too_large') });
      return;
    }
    // UX-only short-circuit before sending bytes over the wire. The route
    // re-validates via magic-byte sniff (image-probe.ts) and ignores
    // Content-Type / extension entirely.
    if (!/\.(jpe?g|png)$/i.test(file.name)) {
      setResult({ kind: 'error', code: 'bad_mime', ...lookupError('bad_mime') });
      return;
    }
    inFlightRef.current = true;
    setResult({ kind: 'uploading' });

    const fd = new FormData();
    fd.append('creatorId', creatorId);
    fd.append('name', name.trim());
    fd.append('image', file);
    const url = forceFlag && hasExistingFace ? '/api/admin/face-upload?force=1' : '/api/admin/face-upload';
    try {
      const res = await fetch(url, { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = String(body?.error || 'unknown_error');
        const friendly = lookupError(code);
        const retryWithForce = code === 'already_face_trained' && hasExistingFace;
        setResult({
          kind: 'error',
          code,
          title: friendly.title,
          body: friendly.body,
          retryWithForce,
          activeSessions: typeof body?.activeSessions === 'number' ? body.activeSessions : undefined,
        });
        return;
      }
      const ok = body as UploadResponse;
      startPolling(ok.uploadId, ok.faceId, ok.queuePosition);
    } catch (e) {
      setResult({
        kind: 'error',
        code: 'network',
        title: 'Network error',
        body: (e as Error).message || 'Check your connection and retry.',
      });
    } finally {
      inFlightRef.current = false;
    }
  }

  function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    void submitWithForce(force);
  }
  function onForceRetry() {
    setForce(true);
    void submitWithForce(true);
  }

  async function onRecover() {
    if (!timeoutOrphan) return;
    if (recoverPending) return;
    const fid = recoverFaceId.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fid)) {
      setRecoverError({
        code: 'bad_face_id',
        title: 'Face id format invalid',
        body: 'Paste the UUID exactly as it appears in Simli Studio (e.g. ccbb01a7-78b9-43e1-8100-ba5918f67530).',
      });
      return;
    }
    setRecoverPending(true);
    setRecoverError(null);
    try {
      const r = await fetch('/api/admin/face-upload/recover', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: timeoutOrphan.uploadId, faceId: fid }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const code = String(body?.error || 'unknown_error');
        const copyMap: Record<string, { title: string; body: string }> = {
          face_not_ready: { title: 'Simli says face is not ready yet', body: 'Wait until Simli Studio shows the face as completed (status ready), then retry.' },
          already_face_trained: { title: 'Creator already has a face', body: 'The prior upload was not flagged for overwrite. Use the regular upload flow with overwrite checked.' },
          already_recovered: { title: 'Face already recovered', body: 'This face_id is already attributed to another upload row.' },
          not_recoverable: { title: 'Not a timeout orphan', body: 'This row is not in the recoverable state (failed + timeout + no vendor_face_id).' },
          creator_has_active_sessions: { title: 'Live sessions in progress', body: 'End active sessions before recovering an overwrite.' },
          simli_unreachable: { title: 'Simli is unreachable', body: 'Retry in a moment.' },
          simli_compose_failed: { title: 'Simli refused the face_id', body: String(body?.detail || 'Check the face_id; copy-paste it again.') },
          face_upload_only_in_production: { title: 'Production-only', body: 'Recovery requires VERCEL_ENV=production or FACE_UPLOAD_ALLOW_LOCAL=1.' },
          bad_face_id: { title: 'Bad face_id format', body: 'Must be 1–128 chars of [A-Za-z0-9_-].' },
          bad_upload_id: { title: 'Bad upload id', body: 'Refresh the page.' },
          bad_json: { title: 'Bad request', body: 'Refresh and try again.' },
          recover_failed: { title: 'Recovery failed', body: 'Server error during recovery. See the code below.' },
        };
        const friendly = copyMap[code] ?? { title: 'Recovery failed', body: code };
        setRecoverError({ code, ...friendly });
        return;
      }
      // Success — page refresh shows the new ready row + updated simli_face_id.
      router.refresh();
    } catch (e) {
      setRecoverError({
        code: 'network',
        title: 'Network error',
        body: (e as Error).message || 'Check your connection and retry.',
      });
    } finally {
      setRecoverPending(false);
    }
  }

  async function onConfirmDelete() {
    setDeletePending(true);
    try {
      const r = await fetch('/api/admin/simli-retrain', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setResult({
          kind: 'error',
          code: String(body?.error || 'delete_failed'),
          title: 'Delete failed',
          body: String(body?.error || 'Unknown error'),
        });
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setDeletePending(false);
    }
  }

  const uploading = result.kind === 'uploading';
  const training = result.kind === 'training';
  const busy = uploading || training;

  return (
    <div
      style={{
        position: 'relative',
        marginTop: 16,
        padding: 12,
        border: '1px solid #ddd',
        borderRadius: 6,
        fontSize: 13,
        boxSizing: 'border-box',
        maxWidth: '100%',
      }}
    >
      {/* Top-right kebab when an existing face is trained. */}
      {hasExistingFace && (
        <div style={{ position: 'absolute', top: 8, right: 8 }}>
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              setKebabOpen((v) => !v);
            }}
            aria-label="Face options"
            style={{
              width: 28, height: 28, borderRadius: 4, border: '1px solid #ccc',
              background: '#fff', cursor: 'pointer', fontSize: 16, lineHeight: '20px',
            }}
          >
            ⋯
          </button>
          {kebabOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', right: 0, top: 32, background: '#fff',
                border: '1px solid #ccc', borderRadius: 4, padding: 4, minWidth: 120,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 5,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setKebabOpen(false);
                  setConfirmOpen(true);
                }}
                style={{
                  display: 'block', width: '100%', padding: '6px 10px', textAlign: 'left',
                  background: '#fff5f5', color: '#a02020', border: 'none', borderRadius: 3,
                  fontSize: 12, cursor: 'pointer',
                }}
              >
                Delete face
              </button>
            </div>
          )}
        </div>
      )}

      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Upload creator face</h3>

      {/* Path C — timeout-orphan recovery panel. Only renders when the
          server-side query found a recent (≤24h) failed+timeout row with
          no vendor_face_id. Admin pastes the face_id from Simli Studio
          to attribute the orphan back to OakLeague without re-uploading. */}
      {timeoutOrphan && (
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            border: '1px solid #b45309',
            borderRadius: 6,
            background: '#fff7ed',
            color: '#7c2d12',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong>Recover a timed-out upload.</strong>{' '}
          A previous upload (#{timeoutOrphan.uploadId}, {new Date(timeoutOrphan.createdAt).toLocaleString()}) timed out before Simli responded.
          If the trained face is now visible in your Simli Studio "Your Faces" tab, paste its face_id here to attribute it back without re-uploading + burning another quota slot.
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="ccbb01a7-78b9-43e1-8100-ba5918f67530"
              value={recoverFaceId}
              onChange={(e) => setRecoverFaceId(e.target.value)}
              disabled={recoverPending}
              style={{
                flex: '1 1 280px', minWidth: 240, padding: 6, fontSize: 12,
                fontFamily: 'ui-monospace, monospace',
              }}
            />
            <button
              type="button"
              onClick={onRecover}
              disabled={recoverPending}
              style={{
                padding: '6px 12px', fontSize: 12, background: '#b45309', color: '#fff',
                border: 'none', borderRadius: 4,
                cursor: recoverPending ? 'progress' : 'pointer',
              }}
            >
              {recoverPending ? 'Recovering…' : 'Recover'}
            </button>
          </div>
          {recoverError && (
            <div style={{ marginTop: 6, color: '#991b1b' }}>
              <strong>{recoverError.title}</strong>
              <div>{recoverError.body}</div>
              <div style={{ marginTop: 2, opacity: 0.6 }}>code: <code>{recoverError.code}</code></div>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 10, fontSize: 12 }}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'photo'}
          onClick={() => setTab('photo')}
          style={{
            padding: '4px 10px', borderRadius: 4,
            border: tab === 'photo' ? '1px solid #333' : '1px solid #ccc',
            background: tab === 'photo' ? '#222' : '#fff',
            color: tab === 'photo' ? '#fff' : '#333',
            cursor: 'pointer',
          }}
        >
          Photo
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'video'}
          disabled
          title="Available when we wire Tavus / HeyGen — Simli Trinity-1 is image-only."
          style={{
            padding: '4px 10px', borderRadius: 4,
            border: '1px solid #eee', background: '#f7f7f7', color: '#999',
            cursor: 'not-allowed',
          }}
        >
          Video (coming with Tavus/HeyGen)
        </button>
      </div>

      <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 10, lineHeight: 1.4 }}>
        JPEG or PNG. ≤ 4.5 MB. 256×256 minimum, 4096×4096 maximum. 9:16, 16:9, or 1:1.
        The image is sent to Simli Trinity-1 for face training; the resulting
        face id is saved on the creator row once training completes.
      </p>

      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Name (label only, not user-visible)
          <input
            type="text"
            maxLength={80}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            style={{ display: 'block', width: '100%', padding: 6, marginTop: 2, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Image (JPEG or PNG)
          <input
            type="file"
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
            style={{ display: 'block', marginTop: 2, maxWidth: '100%' }}
          />
        </label>
        {hasExistingFace && (
          <label style={{ display: 'block', marginBottom: 10, color: '#8a4400', fontSize: 12, lineHeight: 1.4 }}>
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              disabled={busy}
              style={{ marginRight: 6 }}
            />
            Overwrite existing face — only allowed when this creator has no live sessions.
          </label>
        )}
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          style={{
            padding: '8px 14px', fontSize: 13, minWidth: 220,
            cursor: busy ? 'progress' : 'pointer',
          }}
        >
          {uploading
            ? '⏳ Uploading image…'
            : training
            ? `⏳ Training face (queue ${queueLabel(result)}) — can take a few minutes`
            : 'Upload + train'}
        </button>
      </form>

      <div role="status" aria-live="polite" style={{ marginTop: 10 }}>
        {result.kind === 'ok' && (
          <div style={{ color: '#207020' }}>
            <strong>Face trained successfully.</strong>{' '}
            {result.overwrote ? 'The previous face will be cleaned up automatically.' : ''}{' '}
            <details style={{ display: 'inline-block', marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.8 }}>Simli face id</summary>
              <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{result.faceId}</code>
            </details>
          </div>
        )}
        {result.kind === 'error' && (
          <div style={{ color: '#a02020' }}>
            <strong>{result.title}</strong>
            <div style={{ marginTop: 2 }}>{result.body}</div>
            {typeof result.activeSessions === 'number' && result.activeSessions > 0 && (
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>
                {result.activeSessions} session(s) currently open against this creator.
              </div>
            )}
            {result.retryWithForce && (
              <button
                type="button"
                onClick={onForceRetry}
                style={{ marginTop: 6, padding: '4px 10px', fontSize: 12 }}
              >
                Retry with overwrite
              </button>
            )}
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.55 }}>
              code: <code>{result.code}</code>
            </div>
          </div>
        )}
      </div>

      {/* Confirm-delete modal */}
      {confirmOpen && (
        <div
          onClick={() => !deletePending && setConfirmOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 8, padding: 20, maxWidth: 420, width: '90%',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Delete creator face?</h3>
            <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
              This clears <code>simli_face_id</code> on the creator and queues the
              prior face{' '}
              <code style={{ fontSize: 11 }}>
                {existingFaceId ? `${existingFaceId.slice(0, 8)}…` : '(unknown)'}
              </code>
              {' '}for deletion in 60 seconds. The creator will not be usable for sessions
              until a new face is trained.
            </p>
            <p style={{ fontSize: 12, color: '#a02020', marginBottom: 16 }}>
              Blocked if any sessions are currently open against this creator.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={deletePending}
                style={{ padding: '6px 12px', fontSize: 13, background: '#eee', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={deletePending}
                style={{
                  padding: '6px 12px', fontSize: 13, background: '#dc2626', color: '#fff',
                  border: 'none', borderRadius: 4, cursor: deletePending ? 'progress' : 'pointer',
                }}
              >
                {deletePending ? 'Deleting…' : 'Delete face'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
