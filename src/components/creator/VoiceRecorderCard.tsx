'use client';

// Creator Voice card (WS4). Recording-only — the creator reads a fresh
// server-minted 4-sentence script while we capture mic audio, build a 16-bit
// MONO 16 kHz WAV in the browser (the server probe + Cartesia path are
// WAV-pinned; MediaRecorder webm is not in the allowlist), and POST it to
// /creator/api/voice-clone. No file upload (the random script is the
// replay-resistance check; an uploaded file can't follow a 30s-old script).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = { hasExistingVoice: boolean; published: boolean };

type Sentence = { emotion: string; text: string };
type Phase = 'idle' | 'recording' | 'recorded' | 'submitting' | 'done' | 'error';

const TARGET_RATE = 16000;
const MAX_SECONDS = 60;
const MIN_SECONDS = 20;

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  bad_script: { title: 'Script expired', body: 'Generate a new script and record again.' },
  script_used: { title: 'Script already used', body: 'Generate a fresh script and record again.' },
  script_expired: { title: 'Script expired', body: 'Scripts last 30 minutes. Generate a new one.' },
  clip_too_short: { title: 'Recording too short', body: `Record at least ${MIN_SECONDS} seconds.` },
  clip_too_long: { title: 'Recording too long', body: `Keep it under ${MAX_SECONDS} seconds.` },
  not_mono: { title: 'Recording problem', body: 'Audio wasn’t mono. Refresh and retry.' },
  voice_locked_while_live: {
    title: 'Locked while live',
    body: 'Your profile is published, so your voice can’t be changed here. Contact us.',
  },
  creator_has_active_sessions: { title: 'Live sessions in progress', body: 'Wait for open chats to end, then retry.' },
  voice_dispatch_in_flight: { title: 'Previous voice still clearing', body: 'Wait ~60 seconds and retry.' },
  cartesia_clone_failed: { title: 'The recording was rejected', body: 'Record again in a quiet room, speaking clearly.' },
  cartesia_unreachable: { title: 'Voice service unreachable', body: 'Try again in a minute.' },
  consent_missing: { title: 'Consent needed', body: 'We don’t have your voice consent on file. Contact us.' },
  voice_clone_only_in_production: { title: 'Not available here', body: 'Voice cloning runs on the live site only.' },
  source_persist_failed: { title: 'Save failed', body: 'Could not store your recording. Try again.' },
  rate_limit: { title: 'Daily limit reached', body: 'Max 3 successful clones per 24h.' },
  rate_limit_attempts: { title: 'Too many attempts', body: 'Wait 24h, then retry.' },
  mic_denied: { title: 'Microphone blocked', body: 'Allow mic access in your browser and reload.' },
  network: { title: 'Network error', body: 'Check your connection and retry.' },
  unknown_error: { title: 'Clone failed', body: 'Try again.' },
};
const lookupError = (code: string) => ERROR_COPY[code] ?? { title: 'Clone failed', body: code };

function downsampleMono(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric on purpose: int16 range is [-32768, 32767], so full-scale
    // negative uses 0x8000 and positive 0x7fff. Don't "simplify" to one factor.
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

export function VoiceRecorderCard({ hasExistingVoice, published }: Props) {
  const router = useRouter();
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [wavBlob, setWavBlob] = useState<Blob | null>(null);
  const [wavUrl, setWavUrl] = useState<string | null>(null);
  const [err, setErr] = useState<{ title: string; body: string } | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const inRateRef = useRef<number>(48000);
  const timerRef = useRef<number | null>(null);

  const locked = hasExistingVoice && published;

  useEffect(
    () => () => {
      teardown();
      if (wavUrl) URL.revokeObjectURL(wavUrl);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function teardown() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (procRef.current) {
      procRef.current.disconnect();
      procRef.current.onaudioprocess = null;
      procRef.current = null;
    }
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  async function generateScript() {
    setScriptLoading(true);
    setErr(null);
    try {
      const res = await fetch('/creator/api/voice-script', { method: 'POST', credentials: 'same-origin' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setErr(lookupError(String(body.error || 'unknown_error')));
        return;
      }
      setScriptId(String(body.scriptId));
      setSentences((body.sentences as Sentence[]) ?? []);
      // Reset any prior recording — a new script means a fresh take.
      resetRecording();
    } catch (e) {
      setErr({ title: 'Network error', body: (e as Error).message });
    } finally {
      setScriptLoading(false);
    }
  }

  function resetRecording() {
    setPhase('idle');
    setElapsed(0);
    setLevel(0);
    setWavBlob(null);
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    setWavUrl(null);
    chunksRef.current = [];
  }

  async function startRecording() {
    setErr(null);
    resetRecording();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setErr(lookupError('mic_denied'));
      setPhase('error');
      return;
    }
    streamRef.current = stream;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Audit M1: ask the AudioContext for 16 kHz directly. Chrome/Edge/Firefox
    // honor it (capture is then already at TARGET_RATE → downsampleMono is a
    // no-op, no aliasing); Safari ignores/throws → fall back and the block
    // averager handles the resample.
    let ctx: AudioContext;
    try {
      ctx = new Ctx({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new Ctx();
    }
    ctxRef.current = ctx;
    inRateRef.current = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    procRef.current = proc;
    chunksRef.current = [];

    // Audit M2: throttle the level-meter setState — updating React every
    // ~85ms buffer churns the main thread that ScriptProcessor shares and can
    // drop audio. Capture every buffer; surface the meter ~5x/sec.
    let bufN = 0;
    proc.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      chunksRef.current.push(new Float32Array(ch));
      if (++bufN % 3 === 0) {
        let sum = 0;
        for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
        setLevel(Math.min(1, Math.sqrt(sum / ch.length) * 4));
      }
    };
    source.connect(proc);
    proc.connect(ctx.destination);

    setPhase('recording');
    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => {
      const secs = (Date.now() - startedAt) / 1000;
      setElapsed(secs);
      if (secs >= MAX_SECONDS) stopRecording();
    }, 200);
  }

  function stopRecording() {
    if (phase !== 'recording') return;
    const inRate = inRateRef.current;
    const chunks = chunksRef.current;
    teardown();

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const down = downsampleMono(merged, inRate, TARGET_RATE);
    const blob = encodeWav(down, TARGET_RATE);
    setWavBlob(blob);
    setWavUrl(URL.createObjectURL(blob));
    setElapsed(down.length / TARGET_RATE);
    setLevel(0);
    setPhase('recorded');
  }

  async function submit() {
    if (!wavBlob || !scriptId) return;
    setPhase('submitting');
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('scriptId', scriptId);
      fd.append('clip', wavBlob, 'voice.wav');
      const res = await fetch('/creator/api/voice-clone', { method: 'POST', body: fd, credentials: 'same-origin' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setErr(lookupError(String(body.error || 'unknown_error')));
        setPhase('error');
        return;
      }
      setPhase('done');
      router.refresh();
    } catch (e) {
      setErr({ title: 'Network error', body: (e as Error).message });
      setPhase('error');
    }
  }

  const durationOk = elapsed >= MIN_SECONDS && elapsed <= MAX_SECONDS;

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={sectionTitle}>Your voice</h2>
        <span style={{ fontSize: 12, color: hasExistingVoice ? '#4ad07a' : '#999' }}>
          {hasExistingVoice ? 'Cloned ✓' : 'Not set up'}
        </span>
      </div>
      <p style={{ marginTop: 8, opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>
        Read the script out loud in a quiet room. We clone your voice so your avatar
        answers in your own voice. {MIN_SECONDS}–{MAX_SECONDS} seconds.
      </p>

      {locked ? (
        <p style={{ marginTop: 8, fontSize: 13, color: '#c9a227' }}>
          Your profile is live, so your voice is locked here. Contact us to change it.
        </p>
      ) : (
        <>
          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={generateScript} disabled={scriptLoading || phase === 'recording'}>
              {scriptLoading ? 'Generating…' : scriptId ? 'New script' : 'Generate script'}
            </button>
          </div>

          {sentences.length > 0 && (
            <ol style={{ marginTop: 16, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sentences.map((s, i) => (
                <li key={i} style={{ lineHeight: 1.5 }}>
                  <span style={emotionCue}>{s.emotion}</span>
                  <div>{s.text}</div>
                </li>
              ))}
            </ol>
          )}

          {scriptId && (
            <div style={{ marginTop: 16 }}>
              {phase === 'recording' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button type="button" onClick={stopRecording}>
                    ■ Stop
                  </button>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{elapsed.toFixed(1)}s</span>
                  <LevelMeter level={level} />
                </div>
              ) : (
                <button type="button" onClick={startRecording} disabled={phase === 'submitting'}>
                  ● {phase === 'recorded' || phase === 'error' ? 'Re-record' : 'Record'}
                </button>
              )}
            </div>
          )}

          {phase === 'recorded' && wavUrl && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio src={wavUrl} controls style={{ width: '100%', maxWidth: 360 }} />
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                {elapsed.toFixed(1)}s recorded
                {!durationOk && (
                  <span style={{ color: 'salmon', marginLeft: 8 }}>
                    (need {MIN_SECONDS}–{MAX_SECONDS}s)
                  </span>
                )}
              </div>
              <div>
                <button type="button" onClick={submit} disabled={!durationOk}>
                  Use this recording
                </button>
              </div>
            </div>
          )}

          {phase === 'submitting' && <div style={{ marginTop: 12, opacity: 0.7 }}>Cloning your voice…</div>}
          {phase === 'done' && (
            <div style={{ marginTop: 12, color: '#4ad07a', fontSize: 14 }}>
              <strong>Voice cloned.</strong> Your avatar will answer in your voice.
            </div>
          )}
        </>
      )}

      {err && (
        <div role="alert" style={{ marginTop: 12, color: 'salmon', fontSize: 14 }}>
          <strong>{err.title}</strong>
          <div style={{ marginTop: 2 }}>{err.body}</div>
        </div>
      )}
    </section>
  );
}

function LevelMeter({ level }: { level: number }) {
  return (
    <div style={{ width: 120, height: 8, background: '#1c1c1c', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ width: `${Math.round(level * 100)}%`, height: '100%', background: '#4ad07a', transition: 'width 0.1s' }} />
    </div>
  );
}

const card: React.CSSProperties = { padding: 16, border: '1px solid #222', borderRadius: 8 };
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: 0 };
const emotionCue: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  opacity: 0.55,
  marginBottom: 2,
};
