'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

type ModelId = 'gemini-3.1-flash-live-preview' | 'gemini-live-2.5-flash-native-audio';

type Status = 'DONE' | 'ERROR' | 'TIMEOUT' | 'INVALID';

type TurnRow = {
  turn: number;
  tokenMs?: number;
  wsMs?: number;
  setupMs?: number;
  bufferedAtT4?: number;
  ttfaMs?: number;
  totalMs?: number;
  status: Status;
  reason?: string;
};

type SessionResult = {
  sessionIdx: number;
  turns: TurnRow[];
  aborted?: string;
};

type RunState = 'idle' | 'preflight' | 'running' | 'done';

const TOKEN_TIMEOUT_MS = 10_000;
const WS_OPEN_TIMEOUT_MS = 10_000;
const SETUP_COMPLETE_TIMEOUT_MS = 10_000;
const FIRST_CHUNK_TIMEOUT_MS = 15_000;
const TURNS_PER_SESSION = 5;
const SESSIONS_PER_CELL = 3;
const MAX_CONSECUTIVE_INVALID = 3;
const BUFFERED_SUSPECT_THRESHOLD = 4096;
const CHUNK_SAMPLES = 16_000;         // ~1s @ 16kHz
const CHUNK_BYTES = CHUNK_SAMPLES * 2;

function isoDuration(pcmBytes: number) {
  return pcmBytes / 2 / 16000;
}

function base64FromBytes(b: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)));
  }
  return btoa(s);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchToken(model: ModelId, signal: AbortSignal): Promise<string> {
  const r = await fetch('/api/voice/ephemeral-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal,
  });
  if (!r.ok) throw new Error(`token_http_${r.status}`);
  const j = (await r.json()) as { token?: string; error?: string };
  if (!j.token) throw new Error(j.error || 'token_missing');
  return j.token;
}

async function recordCogs(model: ModelId, inSec: number, outSec: number, device: string) {
  await fetch('/api/voice/spike-a/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, inputAudioSec: inSec, outputAudioSec: outSec, device, ua: navigator.userAgent,
    }),
  }).catch(() => { /* best-effort; harness must keep going */ });
}

async function loadCannedPcm(): Promise<Uint8Array> {
  const r = await fetch('/spike-a/canned-question.pcm', { cache: 'no-store' });
  if (!r.ok) throw new Error('canned_audio_fetch_failed');
  const buf = new Uint8Array(await r.arrayBuffer());
  const dur = isoDuration(buf.length);
  if (dur < 2 || dur > 5) throw new Error(`canned_audio_duration_out_of_range_${dur.toFixed(2)}s`);
  return buf;
}

function detectDevice(): string {
  if (typeof navigator === 'undefined') return 'server';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios-safari';
  if (/Android/.test(ua)) return 'android-chrome';
  return 'desktop';
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function iqr(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return q(0.75) - q(0.25);
}

export default function SpikeClient() {
  const [model, setModel] = useState<ModelId>('gemini-3.1-flash-live-preview');
  const [runState, setRunState] = useState<RunState>('idle');
  const [preflightOk, setPreflightOk] = useState<boolean | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionResult[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const cannedRef = useRef<Uint8Array | null>(null);
  const abortRef = useRef<{ aborted: boolean; reason?: string }>({ aborted: false });

  const device = useMemo(detectDevice, []);
  const standalone = useMemo(isStandalone, []);

  const appendLog = useCallback((s: string) => {
    setLog((prev) => [...prev.slice(-99), `[${new Date().toISOString().slice(11, 23)}] ${s}`]);
  }, []);

  // Preflight: /api/me + canned audio fetch + standalone mode hint
  useEffect(() => {
    (async () => {
      setRunState('preflight');
      try {
        const me = await fetch('/api/me', { cache: 'no-store' });
        if (!me.ok) throw new Error('me_http_' + me.status);
        cannedRef.current = await loadCannedPcm();
        setPreflightOk(true);
        appendLog(`preflight ok · device=${device} · standalone=${standalone} · pcm=${cannedRef.current.length}B`);
      } catch (e) {
        setPreflightOk(false);
        setPreflightError((e as Error).message);
        appendLog(`preflight FAIL: ${(e as Error).message}`);
      } finally {
        setRunState('idle');
      }
    })();
  }, [appendLog, device, standalone]);

  // Abort guards: visibilitychange + pagehide + freeze
  useEffect(() => {
    const onHide = (ev: Event) => {
      if (document.hidden || ev.type === 'pagehide' || ev.type === 'freeze') {
        abortRef.current = { aborted: true, reason: ev.type };
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('freeze', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('freeze', onHide);
    };
  }, []);

  const runOneSession = useCallback(
    async (sessionIdx: number): Promise<SessionResult> => {
      const result: SessionResult = { sessionIdx, turns: [] };
      abortRef.current = { aborted: false };
      const canned = cannedRef.current!;
      const ac = new AbortController();

      // 1. Token mint
      const t0 = performance.now();
      let token: string;
      try {
        const tokenTimer = setTimeout(() => ac.abort('token_timeout'), TOKEN_TIMEOUT_MS);
        token = await fetchToken(model, ac.signal);
        clearTimeout(tokenTimer);
      } catch (e) {
        result.aborted = 'token_' + (e as Error).message;
        appendLog(`session ${sessionIdx}: ${result.aborted}`);
        return result;
      }
      const t1 = performance.now();

      // 2. SDK live.connect. onopen → t2. onmessage setupComplete → t3. onmessage audio part → t5.
      const client = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: 'v1alpha' },
      });

      let t2 = 0, t3 = 0;
      let session: Session | null = null;
      let openResolver: ((v: true) => void) | null = null;
      let openRejector: ((e: Error) => void) | null = null;
      const openedPromise = new Promise<true>((res, rej) => { openResolver = res; openRejector = rej; });

      let currentTurnFirstChunkResolver: ((ms: number) => void) | null = null;
      let currentTurnFirstChunkRejecter: ((e: Error) => void) | null = null;
      let activityEndAtMs = 0;
      let bufferedAtT4 = 0;
      let t4Recorded = false;
      let t3Recorded = false;
      let hasTurnFinished = false;

      const onMessage = (m: LiveServerMessage) => {
        if (m.setupComplete && !t3Recorded) {
          t3 = performance.now();
          t3Recorded = true;
          return;
        }
        const parts = m.serverContent?.modelTurn?.parts ?? [];
        let audioBytes = 0;
        for (const p of parts) {
          if (p.inlineData?.mimeType?.startsWith('audio/pcm')) {
            const b64 = p.inlineData.data ?? '';
            audioBytes += Math.max(0, Math.floor((b64.length * 3) / 4));
            if (t4Recorded && currentTurnFirstChunkResolver) {
              const ttfa = performance.now() - activityEndAtMs;
              const res = currentTurnFirstChunkResolver;
              currentTurnFirstChunkResolver = null;
              currentTurnFirstChunkRejecter = null;
              res(ttfa);
            }
          }
        }
        void audioBytes;
        if (m.serverContent?.turnComplete) hasTurnFinished = true;
      };

      try {
        session = await client.live.connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: 'You are a helpful mentor. Answer in one concise sentence.',
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          },
          callbacks: {
            onopen: () => {
              t2 = performance.now();
              if (openResolver) openResolver(true);
            },
            onmessage: onMessage,
            onerror: (ev: ErrorEvent) => {
              const err = new Error('ws_error');
              if (openRejector) openRejector(err);
              if (currentTurnFirstChunkRejecter) currentTurnFirstChunkRejecter(err);
              appendLog(`ws error: ${ev?.message || 'unknown'}`);
            },
            onclose: (ev: CloseEvent) => {
              const err = new Error(`ws_closed_${ev?.code ?? 'x'}`);
              if (openRejector) openRejector(err);
              if (currentTurnFirstChunkRejecter) currentTurnFirstChunkRejecter(err);
              appendLog(`ws closed: code=${ev?.code} reason=${ev?.reason ?? ''}`);
            },
          },
        });
      } catch (e) {
        result.aborted = 'connect_' + (e as Error).message;
        appendLog(`session ${sessionIdx}: ${result.aborted}`);
        return result;
      }

      // Wait for ws open
      try {
        await Promise.race([
          openedPromise,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ws_open_timeout')), WS_OPEN_TIMEOUT_MS)),
        ]);
      } catch (e) {
        result.aborted = (e as Error).message;
        try { session.close(); } catch {}
        return result;
      }

      // Wait for setupComplete
      const setupDeadline = performance.now() + SETUP_COMPLETE_TIMEOUT_MS;
      while (!t3Recorded && performance.now() < setupDeadline) {
        if (abortRef.current.aborted) break;
        await sleep(50);
      }
      if (!t3Recorded) {
        result.aborted = 'setup_complete_timeout';
        try { session.close(); } catch {}
        return result;
      }

      // Run TURNS_PER_SESSION turns on the same WS
      for (let turn = 1; turn <= TURNS_PER_SESSION; turn++) {
        if (abortRef.current.aborted) {
          result.turns.push({ turn, status: 'INVALID', reason: abortRef.current.reason ?? 'aborted' });
          break;
        }

        t4Recorded = false;
        hasTurnFinished = false;

        const turnPromise = new Promise<number>((res, rej) => {
          currentTurnFirstChunkResolver = res;
          currentTurnFirstChunkRejecter = rej;
        });

        try {
          session.sendRealtimeInput({ activityStart: {} });
        } catch (e) {
          result.turns.push({ turn, status: 'ERROR', reason: 'activityStart_' + (e as Error).message });
          break;
        }

        // Send chunks
        try {
          for (let off = 0; off < canned.length; off += CHUNK_BYTES) {
            const slice = canned.subarray(off, Math.min(off + CHUNK_BYTES, canned.length));
            session.sendRealtimeInput({
              media: {
                data: base64FromBytes(slice),
                mimeType: 'audio/pcm;rate=16000',
              },
            });
            // Small pacing to avoid head-of-line burst saturating uplink.
            await sleep(10);
          }
        } catch (e) {
          result.turns.push({ turn, status: 'ERROR', reason: 'media_send_' + (e as Error).message });
          break;
        }

        // Snapshot backpressure + send activityEnd
        try {
          const ws = (session as unknown as { conn?: { bufferedAmount?: number } }).conn;
          bufferedAtT4 = ws?.bufferedAmount ?? 0;
        } catch { bufferedAtT4 = -1; }

        try {
          session.sendRealtimeInput({ activityEnd: {} });
        } catch (e) {
          result.turns.push({ turn, status: 'ERROR', reason: 'activityEnd_' + (e as Error).message });
          break;
        }
        t4Recorded = true;
        activityEndAtMs = performance.now();

        let ttfaMs: number | undefined;
        try {
          ttfaMs = await Promise.race([
            turnPromise,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('first_chunk_timeout')), FIRST_CHUNK_TIMEOUT_MS)),
          ]);
        } catch (e) {
          result.turns.push({ turn, status: 'TIMEOUT', reason: (e as Error).message });
          break;
        }

        // Wait briefly for turn to complete so subsequent activityStart has clean state
        const turnDoneDeadline = performance.now() + 10_000;
        while (!hasTurnFinished && performance.now() < turnDoneDeadline) await sleep(50);

        result.turns.push({
          turn,
          tokenMs: Math.round(t1 - t0),
          wsMs:    Math.round(t2 - t1),
          setupMs: Math.round(t3 - t2),
          bufferedAtT4,
          ttfaMs:  Math.round(ttfaMs),
          totalMs: Math.round(performance.now() - t0),
          status: 'DONE',
        });
      }

      try { session.close(); } catch {}

      // Record COGS (approximate — input = canned duration × turns; output we don't measure here)
      const inSec = isoDuration(canned.length) * result.turns.filter((t) => t.status === 'DONE').length;
      await recordCogs(model, inSec, 0, device);

      return result;
    },
    [model, device, appendLog],
  );

  const onRun = useCallback(async () => {
    if (!preflightOk || !cannedRef.current) return;
    setRunState('running');
    setSessions([]);
    setBannerError(null);
    appendLog(`starting cell: model=${model}, sessions=${SESSIONS_PER_CELL}, turns=${TURNS_PER_SESSION}`);

    let consecutiveInvalid = 0;
    const collected: SessionResult[] = [];

    for (let i = 1; i <= SESSIONS_PER_CELL; i++) {
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID) {
        setBannerError(`Aborted: ${MAX_CONSECUTIVE_INVALID} consecutive invalid sessions — check network`);
        appendLog('ABORT: 3 consecutive invalids');
        break;
      }
      appendLog(`session ${i} start`);
      const r = await runOneSession(i);
      collected.push(r);
      setSessions([...collected]);
      const allInvalid = r.aborted || r.turns.length === 0 || r.turns.every((t) => t.status !== 'DONE');
      if (allInvalid) consecutiveInvalid += 1; else consecutiveInvalid = 0;
      appendLog(`session ${i} done: ${r.turns.length} turns, aborted=${r.aborted ?? 'no'}`);
    }
    setRunState('done');
  }, [model, preflightOk, runOneSession, appendLog]);

  const turn2Values = useMemo(() => {
    return sessions
      .map((s) => s.turns.find((t) => t.turn === 2 && t.status === 'DONE')?.ttfaMs)
      .filter((v): v is number => typeof v === 'number');
  }, [sessions]);

  const copyJson = useCallback(() => {
    const payload = {
      gitSha: '', // filled by CI/Vercel if wired; ok if blank in harness
      voiceModel: model,
      userAgent: navigator.userAgent,
      standaloneMode: standalone,
      network: {
        effectiveType: (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType ?? null,
      },
      timeOrigin: performance.timeOrigin,
      sessions,
      turn2Median: median(turn2Values),
      turn2Iqr: iqr(turn2Values),
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
    appendLog('copied JSON to clipboard');
  }, [model, standalone, sessions, turn2Values, appendLog]);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Spike A — Gemini Latency Gate</h2>

      <section style={{ border: '1px solid #ddd', padding: 12, borderRadius: 6, marginBottom: 16 }}>
        <div><strong>Device:</strong> {device} {standalone ? '· standalone PWA' : '· browser tab'}</div>
        <div><strong>Preflight:</strong>{' '}
          {preflightOk === null ? 'checking…' :
            preflightOk ? <span style={{ color: 'green' }}>ok</span> :
              <span style={{ color: 'crimson' }}>FAIL — {preflightError}</span>}
        </div>
        {preflightOk === false && (
          <div style={{ marginTop: 8, color: '#555' }}>
            If on iOS PWA: sign in to Safari regular tab first, then reinstall the PWA. Safari and standalone PWA have separate cookie jars.
          </div>
        )}
      </section>

      <section style={{ marginBottom: 16 }}>
        <label style={{ marginRight: 8 }}>Model:</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as ModelId)}
          disabled={runState === 'running'}
        >
          <option value="gemini-3.1-flash-live-preview">3.1 Flash Live (preview)</option>
          <option value="gemini-live-2.5-flash-native-audio">2.5 Flash Native Audio (GA)</option>
        </select>
        <button
          style={{ marginLeft: 12 }}
          onClick={onRun}
          disabled={!preflightOk || runState === 'running'}
        >
          {runState === 'running' ? 'Running…' : `Run ${SESSIONS_PER_CELL}-session cell`}
        </button>
        <button style={{ marginLeft: 8 }} onClick={copyJson} disabled={!sessions.length}>
          Copy JSON
        </button>
      </section>

      {bannerError && (
        <div style={{ padding: 12, background: '#ffe5e5', border: '1px solid #f99', borderRadius: 6, marginBottom: 16 }}>
          {bannerError}
        </div>
      )}

      <section style={{ marginBottom: 16 }}>
        <h3>Sessions</h3>
        {sessions.map((s) => (
          <div key={s.sessionIdx} style={{ marginBottom: 12 }}>
            <div>
              <strong>Session {s.sessionIdx}</strong>{' '}
              {s.aborted && <span style={{ color: 'crimson' }}>aborted: {s.aborted}</span>}
            </div>
            <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['turn', 'token_ms', 'ws_ms', 'setup_ms', 'buffered_at_t4', 'ttfa_ms', 'total_ms', 'status'].map((h) => (
                    <th key={h} style={{ border: '1px solid #ccc', padding: '2px 8px', textAlign: 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.turns.map((t) => {
                  const suspect = typeof t.bufferedAtT4 === 'number' && t.bufferedAtT4 > BUFFERED_SUSPECT_THRESHOLD;
                  const isT2 = t.turn === 2;
                  return (
                    <tr key={t.turn} style={{ background: isT2 ? '#fffbcc' : undefined, textDecoration: t.status === 'INVALID' ? 'line-through' : undefined }}>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.turn}</td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.tokenMs ?? '—'}</td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.wsMs ?? '—'}</td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.setupMs ?? '—'}</td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px', color: suspect ? 'crimson' : undefined }}>
                        {t.bufferedAtT4 ?? '—'}{suspect ? ' ⚠' : ''}
                      </td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px', fontWeight: isT2 ? 600 : 400 }}>{t.ttfaMs ?? '—'}</td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.totalMs ?? '—'}</td>
                      <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>
                        {t.status}{t.reason ? ` (${t.reason})` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Cell summary — turn-2 TTFA</h3>
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['n_valid', 'median_ms', 'iqr_ms'].map((h) => (
                <th key={h} style={{ border: '1px solid #ccc', padding: '2px 8px', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{turn2Values.length} / {SESSIONS_PER_CELL}</td>
              <td style={{ border: '1px solid #ccc', padding: '2px 8px', fontWeight: 600 }}>{median(turn2Values) ?? '—'}</td>
              <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{iqr(turn2Values)?.toFixed(0) ?? '—'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3>Log</h3>
        <pre style={{ background: '#f7f7f7', padding: 8, fontSize: 12, maxHeight: 240, overflow: 'auto' }}>
          {log.join('\n')}
        </pre>
      </section>
    </div>
  );
}
