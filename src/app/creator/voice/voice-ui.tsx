'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { updateTtsSpeed } from './actions';

type PreviewError =
  | 'rate_limited'
  | 'daily_cap_reached'
  | 'voice_not_trained'
  | 'not_a_creator'
  | 'unauthorized'
  | 'cartesia_timeout'
  | 'cartesia_error'
  | 'cartesia_unreachable'
  | 'cartesia_auth_failed'
  | 'cartesia_voice_not_found'
  | 'cartesia_empty_body'
  | 'cartesia_api_key_unset'
  | 'cartesia_pricing_unset'
  | 'rate_limit_failed'
  | 'creator_lookup_failed'
  | 'invalid_speed'
  | 'speed_out_of_range'
  | 'invalid_json'
  | 'unknown';

type Props = {
  initialSpeed: number;
  voiceTrained: boolean;
};

const PRESETS = [
  { label: 'Slower', value: 0.85 },
  { label: 'Default', value: 1.0 },
  { label: 'Faster', value: 1.15 },
] as const;

// Debounce window for the Check Speech button — prevents the user
// hammering the button accidentally and hitting the rate-limit on the
// very first tap.
const PREVIEW_DEBOUNCE_MS = 500;

function speedLabel(v: number): string {
  if (Math.abs(v - 1.0) < 0.001) return '× 1.00 (default)';
  const delta = Math.round((v - 1.0) * 100);
  return `× ${v.toFixed(2)} (${delta > 0 ? '+' : ''}${delta}%)`;
}

function errorMessage(code: PreviewError, detail?: string): string {
  switch (code) {
    case 'rate_limited':
      return 'Slow down — give the audio a moment to finish before trying another speed.';
    case 'daily_cap_reached':
      return "You have used today's 20 previews. Your slider value is still saved — your next conversation uses it. The preview button comes back tomorrow.";
    case 'voice_not_trained':
      return 'Train your cloned voice first to enable preview.';
    case 'not_a_creator':
      return 'You need a creator profile to preview voice.';
    case 'unauthorized':
      return 'Please sign in again.';
    case 'cartesia_timeout':
      return 'The voice service is taking too long. Try again in a moment.';
    case 'cartesia_error':
    case 'cartesia_empty_body':
      return 'The voice service had a hiccup. Try again in a moment.';
    case 'cartesia_unreachable':
      return 'Could not reach the voice service. Try again in a moment.';
    case 'cartesia_auth_failed':
      return 'Voice service authentication failed. Check CARTESIA_API_KEY is set.';
    case 'cartesia_voice_not_found':
      return 'Your cloned voice was not found upstream. Retrain or contact support.';
    case 'cartesia_api_key_unset':
      return 'Server missing CARTESIA_API_KEY env var. Set it in .env.local (dev) or Vercel project (prod).';
    case 'cartesia_pricing_unset':
      return 'Server missing CARTESIA_USD_PER_CHAR env var. Set it (e.g. 0.00005) and restart.';
    case 'rate_limit_failed':
    case 'creator_lookup_failed':
      return 'Internal error. Check server logs.';
    case 'invalid_speed':
    case 'speed_out_of_range':
    case 'invalid_json':
      return detail ?? 'Invalid request. Refresh the page.';
    default:
      return 'Something went wrong. Try again in a moment.';
  }
}

export function VoiceSpeedUI({ initialSpeed, voiceTrained }: Props) {
  const [speed, setSpeed] = useState<number>(initialSpeed);
  const [savedSpeed, setSavedSpeed] = useState<number>(initialSpeed);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewError, setPreviewError] = useState<PreviewError | null>(null);
  const [previewErrorDetail, setPreviewErrorDetail] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<'saved' | 'error' | null>(null);

  // R2 audit S5 — audio cleanup.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastTapRef = useRef<number>(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cleanup audio + abort + revoke URL on unmount.
      const a = audioRef.current;
      if (a) {
        try { a.pause(); a.removeAttribute('src'); a.load(); } catch { /* ignore */ }
      }
      const url = objectUrlRef.current;
      if (url) URL.revokeObjectURL(url);
      abortRef.current?.abort();
    };
  }, []);

  const dirty = Math.abs(speed - savedSpeed) > 0.001;

  const onCheckSpeech = useCallback(async () => {
    const now = Date.now();
    if (now - lastTapRef.current < PREVIEW_DEBOUNCE_MS) return;
    lastTapRef.current = now;

    if (!voiceTrained) {
      setPreviewError('voice_not_trained');
      return;
    }

    // Abort any in-flight preview before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPreviewing(true);
    setPreviewError(null);
    setPreviewErrorDetail(null);

    // Pre-commit audit M1 fix: every error branch MUST set previewing=false
    // BEFORE returning. The prior microtask-based reset relied on a stale
    // closure of `previewError`, leaving the button stuck on "Playing..."
    // on the first error per session. Inline reset per branch is mechanical
    // but correct.
    try {
      const res = await fetch('/api/creator/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed }),
        signal: controller.signal,
      });

      if (!mountedRef.current) return;

      // R1 audit M5 / R2 M6 — branch on Content-Type, not just .ok.
      const ct = res.headers.get('Content-Type') || '';
      if (!res.ok) {
        let code: PreviewError = 'unknown';
        let detail: string | undefined;
        try {
          const body = (await res.json()) as { code?: string; detail?: string };
          if (body.code) code = body.code as PreviewError;
          if (body.detail) detail = body.detail;
        } catch { /* ignore */ }
        // Log the actual server code to console so dev gets it even if
        // the type whitelist falls through to 'unknown'.
        console.warn('[voice-preview] server returned', res.status, code, detail);
        setPreviewError(code);
        setPreviewErrorDetail(detail ?? null);
        setPreviewing(false);
        return;
      }
      if (!ct.startsWith('audio/')) {
        setPreviewError('unknown');
        setPreviewing(false);
        return;
      }

      const blob = await res.blob();
      if (blob.size === 0) {
        setPreviewError('cartesia_error');
        setPreviewing(false);
        return;
      }

      // Revoke prior object URL before assigning new one.
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      audioRef.current.onended = () => {
        if (mountedRef.current) setPreviewing(false);
      };
      try {
        await audioRef.current.play();
        // Happy path: previewing stays true until onended fires.
      } catch {
        // Autoplay rejection — should never hit since this is a user-gesture
        // handler, but defense in depth.
        setPreviewError('unknown');
        setPreviewing(false);
      }
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'AbortError') {
        // User-triggered abort — silent. previewing will be reset by the
        // newer in-flight request's setPreviewing(true) → audio.onended.
        return;
      }
      if (mountedRef.current) {
        setPreviewError('unknown');
        setPreviewing(false);
      }
    }
  }, [speed, voiceTrained]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setSavedToast(null);
    try {
      const res = await updateTtsSpeed({ speed });
      if (!mountedRef.current) return;
      if (res.ok) {
        setSavedSpeed(speed);
        setSavedToast('saved');
        setTimeout(() => mountedRef.current && setSavedToast(null), 2500);
      } else {
        setSavedToast('error');
      }
    } catch {
      if (mountedRef.current) setSavedToast('error');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [speed]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
      {/* Slider + label */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <label htmlFor="speed-slider" style={{ fontSize: 14, fontWeight: 500 }}>
            Playback speed
          </label>
          <span style={{ fontSize: 14, color: '#888', fontVariantNumeric: 'tabular-nums' }}>
            {speedLabel(speed)}
          </span>
        </div>
        <input
          id="speed-slider"
          type="range"
          min="0.6"
          max="1.5"
          step="0.05"
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          aria-label="Voice playback speed multiplier"
          aria-valuemin={0.6}
          aria-valuemax={1.5}
          aria-valuenow={speed}
          aria-valuetext={speedLabel(speed)}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666', marginTop: 4 }}>
          <span>0.6×</span>
          <span>1.0×</span>
          <span>1.5×</span>
        </div>
      </div>

      {/* Preset chips */}
      <div role="radiogroup" aria-label="Voice speed presets" style={{ display: 'flex', gap: 8 }}>
        {PRESETS.map((p) => {
          const active = Math.abs(speed - p.value) < 0.001;
          return (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSpeed(p.value)}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 6,
                border: active ? '1px solid #6c8eff' : '1px solid #333',
                background: active ? '#1a2b5a' : '#0f0f0f',
                color: active ? '#fff' : '#ccc',
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              {p.label} <span style={{ opacity: 0.6 }}>({p.value.toFixed(2)})</span>
            </button>
          );
        })}
      </div>

      {/* Check Speech button */}
      <div>
        <button
          type="button"
          onClick={onCheckSpeech}
          disabled={!voiceTrained || previewing}
          style={{
            padding: '12px 16px',
            borderRadius: 6,
            border: '1px solid #444',
            background: voiceTrained && !previewing ? '#2a2a2a' : '#1a1a1a',
            color: voiceTrained ? '#fff' : '#666',
            fontSize: 14,
            cursor: voiceTrained && !previewing ? 'pointer' : 'not-allowed',
            width: '100%',
          }}
        >
          {previewing ? 'Playing…' : 'Check Speech'}
        </button>
        {!voiceTrained && (
          <p style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
            Train your cloned voice first to enable preview.
          </p>
        )}
        {previewError && (
          <p
            role="alert"
            style={{ fontSize: 13, color: previewError === 'daily_cap_reached' ? '#ddb55a' : '#ff7a7a', marginTop: 8 }}
          >
            {errorMessage(previewError, previewErrorDetail ?? undefined)}
          </p>
        )}
        <p style={{ fontSize: 11, color: '#666', marginTop: 6, lineHeight: 1.5 }}>
          Each Check Speech generates ~7 seconds of fresh audio in your voice.
          Soft cap: 5 per minute, 20 per day. Resets midnight UTC.
        </p>
      </div>

      {/* Save button + status */}
      <div style={{ borderTop: '1px solid #222', paddingTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          style={{
            padding: '10px 20px',
            borderRadius: 6,
            border: '1px solid #555',
            background: dirty && !saving ? '#6c8eff' : '#222',
            color: dirty && !saving ? '#fff' : '#666',
            fontSize: 14,
            cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedToast === 'saved' && (
          <span role="status" style={{ fontSize: 13, color: '#7acf6a' }}>
            Saved. Changes apply to your next conversation.
          </span>
        )}
        {savedToast === 'error' && (
          <span role="alert" style={{ fontSize: 13, color: '#ff7a7a' }}>
            Save failed. Try again.
          </span>
        )}
        {!savedToast && dirty && (
          <span style={{ fontSize: 12, color: '#888' }}>
            Unsaved changes. Active sessions keep their current speed.
          </span>
        )}
      </div>
    </section>
  );
}
