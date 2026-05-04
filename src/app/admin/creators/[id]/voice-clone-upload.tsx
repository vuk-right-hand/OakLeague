'use client';
// Admin voice-clone upload cell. Posts to POST /api/admin/voice-clone.
// v1: WAV-only; the route validates server-side (RIFF magic + duration).

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  creatorId: string;
  hasExistingVoice: boolean;
};

type Result =
  | { kind: 'idle' }
  | { kind: 'uploading'; stage: 'upload' | 'training' }
  | { kind: 'ok'; voiceId: string; durationSeconds: number; overwrote: boolean }
  | { kind: 'error'; code: string; title: string; body: string; retryWithForce?: boolean; activeSessions?: number };

// U-M4 — friendly-error map. Server returns {error: code, detail?, activeSessions?}.
// Code → admin-readable title/body. Retry hint encoded as `retryWithForce`
// so the form can offer one-tap force-resubmit (U-M7).
const ERROR_COPY: Record<string, { title: string; body: string }> = {
  bad_creator_id: { title: 'Creator id rejected', body: 'Refresh the page and try again.' },
  bad_name: { title: 'Name is required', body: 'Add a short name (≤80 chars).' },
  bad_description: { title: 'Description too long', body: 'Trim to 500 characters.' },
  no_clip: { title: 'No clip attached', body: 'Pick a WAV file before submitting.' },
  empty_clip: { title: 'Clip is empty', body: 'The selected file is 0 bytes.' },
  clip_too_large: { title: 'Clip too large', body: 'Maximum 10 MB. Trim or re-export.' },
  unsupported_format: { title: "That isn't a PCM WAV", body: 'Re-export from Audacity / ffmpeg as PCM 16-bit WAV.' },
  clip_too_short: { title: 'Clip too short', body: 'Voice cloning needs at least 3 seconds.' },
  clip_too_long: { title: 'Clip too long', body: 'Trim to ≤120 seconds.' },
  rate_limit: { title: 'Daily limit reached', body: 'Maximum 3 successful clones per 24h.' },
  rate_limit_attempts: { title: 'Too many failed attempts', body: 'Wait 24h or check Cartesia status before retrying.' },
  already_cloned: { title: 'Voice already exists', body: 'Check the overwrite box and resubmit.' },
  creator_has_active_sessions: {
    title: 'Live sessions in progress',
    body: 'End the active sessions before replacing the voice.',
  },
  cartesia_clone_failed: { title: 'Cartesia rejected the clip', body: 'Try a different recording or check Cartesia status.' },
  cartesia_unreachable: { title: 'Cartesia is unreachable', body: 'Check status.cartesia.ai — retry in a minute.' },
  cartesia_clone_bad_response: { title: 'Cartesia returned malformed data', body: 'Retry in a minute. Persists? File a bug.' },
  cartesia_misconfig: { title: 'Server misconfigured', body: 'CARTESIA_API_KEY is not set on this deployment.' },
  finalize_failed: { title: 'Database write failed', body: 'The clone was created but not saved. Re-run with the same name.' },
  audit_insert_failed: { title: 'Audit row write failed', body: 'Refresh and try again. Persists? File a bug.' },
  bad_origin: { title: 'Cross-origin request blocked', body: 'Refresh from the admin tab.' },
  cross_origin: { title: 'Cross-origin request blocked', body: 'Refresh from the admin tab.' },
  rate_lookup_failed: { title: 'Rate-limit lookup failed', body: 'Retry in a moment.' },
  creator_not_found: { title: 'Creator not found', body: 'This creator may have been deleted. Refresh.' },
  // R3-M5 (UX) gap fillers — codes the route returns that previously
  // fell through to the generic fallback.
  bad_multipart: { title: 'Upload was malformed', body: 'Refresh and try again.' },
  creator_lookup_failed: { title: 'Creator lookup failed', body: 'Database hiccup — retry in a moment.' },
  upload_already_used: { title: 'Upload already consumed', body: 'Submit a fresh clip.' },
  network: { title: 'Network error', body: 'Check your connection and retry.' },
  unknown_error: { title: 'Upload failed', body: 'See the code below for the reason.' },
};
function lookupError(code: string): { title: string; body: string } {
  return ERROR_COPY[code] ?? { title: 'Upload failed', body: code };
}

export function VoiceCloneUpload({ creatorId, hasExistingVoice }: Props) {
  const router = useRouter();
  const [name, setName] = useState('');
  const language = 'en';
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  // U-C4 — synchronous double-submit guard. setState is async; on iPhone
  // Safari a fast double-tap can fire twice before React re-renders the
  // disabled button. A ref flag closes the gap.
  const inFlightRef = useRef(false);
  // U-M3 — two-stage label. Cartesia clone-create takes 5–10s; show
  // "Training voice…" after 1.5s so the button doesn't look frozen.
  const trainingTimerRef = useRef<number | null>(null);

  async function submitWithForce(forceFlag: boolean) {
    if (inFlightRef.current) return;
    if (!file) {
      setResult({ kind: 'error', code: 'no_clip', ...lookupError('no_clip') });
      return;
    }
    if (!name.trim()) {
      setResult({ kind: 'error', code: 'bad_name', ...lookupError('bad_name') });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setResult({ kind: 'error', code: 'clip_too_large', ...lookupError('clip_too_large') });
      return;
    }
    // M1 client-side WAV early reject (saves a network round-trip on
    // accidental MP3 picks). Mirrors the server's RIFF check.
    if (!/\.wav$/i.test(file.name)) {
      setResult({ kind: 'error', code: 'unsupported_format', ...lookupError('unsupported_format') });
      return;
    }
    inFlightRef.current = true;
    setResult({ kind: 'uploading', stage: 'upload' });
    if (trainingTimerRef.current) window.clearTimeout(trainingTimerRef.current);
    trainingTimerRef.current = window.setTimeout(() => {
      setResult((r) => (r.kind === 'uploading' ? { kind: 'uploading', stage: 'training' } : r));
    }, 1500);

    const fd = new FormData();
    fd.append('creatorId', creatorId);
    fd.append('name', name.trim());
    fd.append('language', language);
    if (description.trim()) fd.append('description', description.trim());
    fd.append('clip', file);
    const url = forceFlag && hasExistingVoice ? '/api/admin/voice-clone?force=1' : '/api/admin/voice-clone';
    try {
      const res = await fetch(url, { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = String(body?.error || 'unknown_error');
        const friendly = lookupError(code);
        // U-M7 — surface a one-tap retry-with-force for the
        // already_cloned path; surface activeSessions count for the
        // creator_has_active_sessions path (U-C3).
        const retryWithForce = code === 'already_cloned' && hasExistingVoice;
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
      setResult({
        kind: 'ok',
        voiceId: String(body.voiceId || ''),
        durationSeconds: Number(body.durationSeconds || 0),
        overwrote: !!body.overwrote,
      });
      // U-C2 — re-render the page so the SSR'd voice_id row reflects
      // the new value. Without this, the page header still shows the
      // old voice_id and an admin re-submits thinking it failed.
      router.refresh();
    } catch (e) {
      setResult({
        kind: 'error',
        code: 'network',
        title: 'Network error',
        body: (e as Error).message || 'Check your connection and retry.',
      });
    } finally {
      if (trainingTimerRef.current) window.clearTimeout(trainingTimerRef.current);
      trainingTimerRef.current = null;
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

  const uploading = result.kind === 'uploading';
  const stageLabel = uploading
    ? result.stage === 'training'
      ? 'Training voice (this can take 10s)…'
      : 'Uploading clip…'
    : 'Upload + clone';

  return (
    <form
      onSubmit={onSubmit}
      style={{
        marginTop: 16,
        padding: 12,
        border: '1px solid #ddd',
        borderRadius: 6,
        fontSize: 13,
        boxSizing: 'border-box',
        maxWidth: '100%',
      }}
    >
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Upload voice clip</h3>
      <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 10, lineHeight: 1.4 }}>
        WAV only (PCM, 3–120 s, ≤10 MB). Multi-format support is post-YC. The
        clip is sent to Cartesia for instant voice cloning; the resulting
        voice id is saved on the creator row.
      </p>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Voice name
        <input
          type="text"
          maxLength={80}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ display: 'block', width: '100%', padding: 6, marginTop: 2, boxSizing: 'border-box' }}
        />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Description (optional)
        <textarea
          maxLength={500}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ display: 'block', width: '100%', padding: 6, marginTop: 2, boxSizing: 'border-box', resize: 'vertical' }}
        />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Clip (WAV only)
        <input
          type="file"
          accept="audio/wav,.wav"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ display: 'block', marginTop: 2, maxWidth: '100%' }}
        />
      </label>
      {hasExistingVoice && (
        <label style={{ display: 'block', marginBottom: 10, color: '#8a4400', fontSize: 12, lineHeight: 1.4 }}>
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Overwrite existing voice — only allowed when this creator has no live sessions.
        </label>
      )}
      <button
        type="submit"
        disabled={uploading}
        aria-busy={uploading}
        style={{
          padding: '8px 14px',
          fontSize: 13,
          minWidth: 180,
          cursor: uploading ? 'progress' : 'pointer',
        }}
      >
        {uploading ? `⏳ ${stageLabel}` : stageLabel}
      </button>

      <div role="status" aria-live="polite" style={{ marginTop: 10 }}>
        {result.kind === 'ok' && (
          <div style={{ color: '#207020' }}>
            <strong>Voice trained successfully.</strong>{' '}
            {result.overwrote
              ? 'The previous voice will be cleaned up automatically.'
              : ''}{' '}
            <details style={{ display: 'inline-block', marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.8 }}>
                Cartesia voice id ({result.durationSeconds.toFixed(2)}s clip)
              </summary>
              <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{result.voiceId}</code>
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
    </form>
  );
}
