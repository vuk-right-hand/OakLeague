'use client';

// Spike A proxy harness — drives the Fly proxy end-to-end with canned audio.
// Reuses /spike-a/canned-question.pcm (16kHz LE mono PCM16, 2-5s).
//
// Flow per session:
//   POST /api/voice/spike-a/ticket → { ticket, expiresAt }
//   WSS <proxy>?ticket=<>&model=<> → wait for { type:'ready' }
//   For each turn:
//     send { type:'turn_start' }
//     stream PCM in ~1s chunks as binary frames
//     send { type:'turn_end' }
//     t_firstAudio = first binary frame received after turn_end
//     TTFA = t_firstAudio - t_sentLast
//     wait for { type:'turn_complete' } before next turn
//
// Playback path: accumulate output bytes (Phase 2 doesn't play; Phase 3
// layers in Web Audio graph for mobile spot-check).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ModelId =
  | 'gemini-2.5-flash-native-audio-preview-12-2025'
  | 'gemini-3.1-flash-live-preview';

// EMPTY_RESPONSE = first_chunk_timeout but turn_complete arrived → Gemini
// decided not to emit audio (model behavior). TIMEOUT = neither audio nor
// turn_complete within budget → API-side silence (infrastructure/SLA).
// Splits the ~22% timeout bucket so we can tell model regression apart from
// API regression. See SPIKE_A_DEFERRED_FIXUP_PLAN.md "timeout diagnosis".
type Status = 'DONE' | 'ERROR' | 'TIMEOUT' | 'EMPTY_RESPONSE' | 'INVALID';

type TurnRow = {
  turn: number;
  ticketMs?: number;
  wsMs?: number;
  readyMs?: number;
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

const DEFAULT_TURNS_PER_SESSION = 5;
const SESSIONS_PER_CELL = 3;
const CHUNK_BYTES = 32_000; // ~1s @ 16kHz LE mono PCM16
const TICKET_TIMEOUT_MS = 5_000;
const WS_OPEN_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS   = 10_000;
const FIRST_CHUNK_TIMEOUT_MS = 15_000;
// Proxy's bridge.turnEnd timeout is 30s (server/voice-proxy/gemini-bridge.js).
// Harness budget must exceed it, else a slow-but-valid Gemini turn is
// mislabelled as turn_complete_timeout when the proxy would have delivered.
// Total: FIRST_CHUNK_TIMEOUT_MS (15s) + TURN_COMPLETE_TIMEOUT_MS (20s) = 35s.
const TURN_COMPLETE_TIMEOUT_MS = 20_000;
const INTER_SESSION_DELAY_MS = 1_500;

const PROXY_URL = process.env.NEXT_PUBLIC_VOICE_PROXY_URL || 'wss://oakleague-voice-proxy.fly.dev/voice/spike-a';

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export type CreatorOption = { id: string; handle: string; displayName: string };

async function fetchTicket(signal: AbortSignal, creatorId: string): Promise<{ ticket: string }> {
  const r = await fetch('/api/voice/spike-a/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creatorId }),
    signal,
  });
  if (!r.ok) throw new Error(`ticket_http_${r.status}`);
  const j = (await r.json()) as { ticket?: string };
  if (!j.ticket) throw new Error('ticket_missing');
  return { ticket: j.ticket };
}

async function loadCannedPcm(): Promise<Uint8Array> {
  const r = await fetch('/spike-a/canned-question.pcm', { cache: 'no-store' });
  if (!r.ok) throw new Error('canned_audio_fetch_failed');
  return new Uint8Array(await r.arrayBuffer());
}

function detectDevice(): string {
  if (typeof navigator === 'undefined') return 'server';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios-safari';
  if (/Android/.test(ua)) return 'android-chrome';
  return 'desktop';
}

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (i - lo));
}

export default function ProxyClient({ creators }: { creators: CreatorOption[] }) {
  const [model, setModel] = useState<ModelId>('gemini-2.5-flash-native-audio-preview-12-2025');
  const [creatorId, setCreatorId] = useState<string>(creators[0]?.id ?? '');
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState<SessionResult[]>([]);
  const [log, setLog] = useState<string[]>([]);
  // Configurable per-session turn count. Set to 1 to test cold-only turns
  // (eliminates "model gets bored of identical input" degradation hypothesis
  // — see SPIKE_A_DEFERRED_FIXUP_PLAN.md priming spike test).
  const [turnsPerSession, setTurnsPerSession] = useState<number>(DEFAULT_TURNS_PER_SESSION);
  // Sleep between turn_complete and the next turn_start. Originally added as
  // a 2026-05-02 probe for the manual-VAD multi-turn regression (forum
  // discuss.ai.google.dev/t/142838); 500ms didn't help, so the proxy moved
  // to auto-VAD with `audioStreamEnd`. Kept as a knob for future post-turn
  // pacing experiments. Default 0 = no delay.
  const [interTurnDelayMs, setInterTurnDelayMs] = useState<number>(0);
  const cannedRef = useRef<Uint8Array | null>(null);
  // sessionIdx → list of binary audio frames captured from the proxy. Kept
  // in a ref (not state) — audio buffers are large and should not trigger
  // re-renders. Cleared on each new run.
  const sessionAudioRef = useRef<Map<number, Uint8Array[]>>(new Map());
  const device = useMemo(detectDevice, []);

  const append = useCallback((s: string) => {
    setLog((p) => [...p.slice(-199), `[${new Date().toISOString().slice(11, 23)}] ${s}`]);
  }, []);

  useEffect(() => {
    loadCannedPcm()
      .then((buf) => { cannedRef.current = buf; append(`canned pcm loaded: ${buf.length}B`); })
      .catch((e) => append(`canned FAIL: ${(e as Error).message}`));
  }, [append]);

  const runOneSession = useCallback(async (sessionIdx: number): Promise<SessionResult> => {
    const result: SessionResult = { sessionIdx, turns: [] };
    const canned = cannedRef.current!;
    sessionAudioRef.current.set(sessionIdx, []);

    // 1. Ticket
    const t0 = performance.now();
    let ticket: string;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort('ticket_timeout'), TICKET_TIMEOUT_MS);
      ticket = (await fetchTicket(ac.signal, creatorId)).ticket;
      clearTimeout(to);
    } catch (e) {
      result.aborted = 'ticket_' + (e as Error).message;
      return result;
    }
    const t1 = performance.now();

    // 2. WS open
    const url = `${PROXY_URL}?ticket=${encodeURIComponent(ticket)}&model=${encodeURIComponent(model)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    type Pending = {
      turnFirstAudio?: (ms: number) => void;
      turnFirstAudioReject?: (e: Error) => void;
      turnComplete?: () => void;
      turnCompleteReject?: (e: Error) => void;
    };
    const pending: Pending = {};
    let ready = false;
    type CloseInfo = { code?: number; reason?: string };
    // proxyError is populated when the proxy sends {type:'error', code, op}
    // — usually followed by a WS close (e.g. 4006 quota_state_inconsistent).
    // K3 audit fix: previously we only logged it, so the turn loop sat on
    // firstAudioP/turnCompleteP until their 15s/23s timeouts and reported a
    // generic TIMEOUT instead of the real reason.
    const state: { closeInfo: CloseInfo | null; proxyError: string | null } =
      { closeInfo: null, proxyError: null };
    let lastSentAtMs = 0;
    let firstAudioRecvAtMs = 0;

    const abortPending = (reason: string) => {
      pending.turnFirstAudioReject?.(new Error(reason));
      pending.turnCompleteReject?.(new Error(reason));
      pending.turnFirstAudio = undefined;
      pending.turnFirstAudioReject = undefined;
      pending.turnComplete = undefined;
      pending.turnCompleteReject = undefined;
    };

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        // Binary: TTS audio frame from Gemini (24kHz LE PCM16 mono per SDK).
        // Capture for playback so we can verify the model is actually
        // answering, not emitting garbage. Each ev.data is an ArrayBuffer.
        const frames = sessionAudioRef.current.get(sessionIdx);
        if (frames) frames.push(new Uint8Array(ev.data as ArrayBuffer));

        if (lastSentAtMs && !firstAudioRecvAtMs) {
          firstAudioRecvAtMs = performance.now();
          pending.turnFirstAudio?.(firstAudioRecvAtMs - lastSentAtMs);
          pending.turnFirstAudio = undefined;
          pending.turnFirstAudioReject = undefined;
        }
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ready') ready = true;
        else if (msg.type === 'turn_complete') {
          pending.turnComplete?.();
          pending.turnComplete = undefined;
          pending.turnCompleteReject = undefined;
        }
        else if (msg.type === 'error') {
          const tag = msg.code || msg.message || 'unknown';
          state.proxyError = `${msg.op || 'unknown_op'}:${tag}`;
          append(`proxy error: ${state.proxyError}`);
          abortPending(`proxy_error_${tag}`);
        }
        else if (msg.type === 'upstream_closed') append(`upstream closed: ${msg.reason}`);
      } catch {}
    });

    ws.addEventListener('close', (ev) => {
      state.closeInfo = { code: ev.code, reason: ev.reason };
      abortPending(`ws_closed_${ev.code}`);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('ws_open_timeout')), WS_OPEN_TIMEOUT_MS);
        ws.addEventListener('open', () => { clearTimeout(to); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('ws_error')); }, { once: true });
      });
    } catch (e) {
      result.aborted = 'ws_' + (e as Error).message + (state.closeInfo ? `_${state.closeInfo.code}_${state.closeInfo.reason}` : '');
      try { ws.close(); } catch {}
      return result;
    }
    const t2 = performance.now();

    // 3. Wait for { type:'ready' }
    const readyDeadline = performance.now() + READY_TIMEOUT_MS;
    while (!ready && !state.closeInfo && performance.now() < readyDeadline) await sleep(30);
    if (!ready) {
      result.aborted = 'ready_timeout' + (state.closeInfo ? `_${state.closeInfo.code}_${state.closeInfo.reason}` : '');
      try { ws.close(); } catch {}
      return result;
    }
    const t3 = performance.now();

    // 4. Run turns
    for (let turn = 1; turn <= turnsPerSession; turn++) {
      if (state.closeInfo) {
        result.turns.push({ turn, status: 'INVALID', reason: `ws_closed_${state.closeInfo.code}` });
        break;
      }

      firstAudioRecvAtMs = 0;
      lastSentAtMs = 0;

      const turnStart = performance.now();
      const firstAudioP = new Promise<number>((res, rej) => {
        pending.turnFirstAudio = res;
        pending.turnFirstAudioReject = rej;
        setTimeout(() => rej(new Error('first_chunk_timeout')), FIRST_CHUNK_TIMEOUT_MS);
      });
      const turnCompleteP = new Promise<void>((res, rej) => {
        pending.turnComplete = res;
        pending.turnCompleteReject = rej;
        setTimeout(() => rej(new Error('turn_complete_timeout')), FIRST_CHUNK_TIMEOUT_MS + TURN_COMPLETE_TIMEOUT_MS);
      });
      // Suppress unhandled-rejection overlay when we `break` on firstAudio
      // timeout and never await turnCompleteP — the ws.close(1000) at session
      // end calls abortPending which rejects both. The real `await` below
      // still sees the rejection on the happy path.
      firstAudioP.catch(() => {});
      turnCompleteP.catch(() => {});

      try {
        ws.send(JSON.stringify({ type: 'turn_start' }));
        for (let off = 0; off < canned.length; off += CHUNK_BYTES) {
          const slice = canned.subarray(off, Math.min(off + CHUNK_BYTES, canned.length));
          ws.send(slice);
          await sleep(10);
        }
        lastSentAtMs = performance.now();
        ws.send(JSON.stringify({ type: 'turn_end' }));
      } catch (e) {
        result.turns.push({ turn, status: 'ERROR', reason: 'send_' + (e as Error).message });
        break;
      }

      let ttfaMs: number | undefined;
      let firstAudioErr: Error | null = null;
      try { ttfaMs = await firstAudioP; } catch (e) { firstAudioErr = e as Error; }

      if (firstAudioErr) {
        // No audio frame within FIRST_CHUNK_TIMEOUT_MS. Race turn_complete
        // (still has ~TURN_COMPLETE_TIMEOUT_MS budget remaining) to split:
        //   turn_complete arrived  → EMPTY_RESPONSE (model emitted nothing)
        //   turn_complete rejects via abortPending (ws close / proxy error)
        //                         → ERROR with the real cause
        //   turn_complete also missing → TIMEOUT (API-side silence)
        try {
          await turnCompleteP;
          result.turns.push({
            turn,
            ticketMs: Math.round(t1 - t0),
            wsMs:     Math.round(t2 - t1),
            readyMs:  Math.round(t3 - t2),
            totalMs:  Math.round(performance.now() - turnStart),
            status: 'EMPTY_RESPONSE',
            reason:  firstAudioErr.message,
          });
          continue;
        } catch (e2) {
          // If a proxy error or WS close interrupted the race, that's the
          // real cause — don't bucket as API timeout.
          if (state.proxyError) {
            result.turns.push({ turn, status: 'ERROR', reason: state.proxyError });
          } else if (state.closeInfo !== null) {
            const ci = state.closeInfo as CloseInfo;
            result.turns.push({
              turn,
              status: 'ERROR',
              reason: `ws_closed_${ci.code ?? 'unknown'}`,
            });
          } else {
            result.turns.push({
              turn,
              status: 'TIMEOUT',
              reason: `${firstAudioErr.message}|${(e2 as Error).message}`,
            });
          }
          break;
        }
      }

      try { await turnCompleteP; } catch (e) {
        result.turns.push({ turn, status: 'ERROR', reason: (e as Error).message });
        break;
      }

      result.turns.push({
        turn,
        ticketMs: Math.round(t1 - t0),
        wsMs:     Math.round(t2 - t1),
        readyMs:  Math.round(t3 - t2),
        ttfaMs:   Math.round(ttfaMs!),
        totalMs:  Math.round(performance.now() - turnStart),
        status: 'DONE',
      });

      // Inter-turn cool-down — workaround for Gemini Live manual-VAD turn-2
      // regression (see interTurnDelayMs comment near useState).
      if (interTurnDelayMs > 0 && turn < turnsPerSession) await sleep(interTurnDelayMs);
    }

    try { ws.close(1000, 'session_done'); } catch {}
    return result;
  }, [model, creatorId, append, turnsPerSession, interTurnDelayMs]);

  const playSessionAudio = useCallback(async (sessionIdx: number) => {
    const frames = sessionAudioRef.current.get(sessionIdx);
    if (!frames || frames.length === 0) {
      append(`session ${sessionIdx}: no audio captured`);
      return;
    }
    const totalBytes = frames.reduce((n, f) => n + f.length, 0);
    const merged = new Uint8Array(totalBytes);
    let off = 0;
    for (const f of frames) { merged.set(f, off); off += f.length; }

    // Gemini Live emits 24kHz LE PCM16 mono per SDK docs.
    const SAMPLE_RATE = 24_000;
    const samples = totalBytes / 2;
    const float32 = new Float32Array(samples);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    for (let i = 0; i < samples; i++) float32[i] = view.getInt16(i * 2, true) / 32768;

    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, samples, SAMPLE_RATE);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    append(`session ${sessionIdx}: playing ${(samples / SAMPLE_RATE).toFixed(2)}s of audio`);
  }, [append]);

  const onRun = useCallback(async () => {
    if (!cannedRef.current) return;
    setRunning(true);
    setSessions([]);
    sessionAudioRef.current.clear();
    append(`starting proxy cell: model=${model}, sessions=${SESSIONS_PER_CELL}, turns=${turnsPerSession}`);
    const collected: SessionResult[] = [];
    for (let i = 1; i <= SESSIONS_PER_CELL; i++) {
      append(`session ${i} start`);
      const r = await runOneSession(i);
      collected.push(r);
      setSessions([...collected]);
      append(`session ${i} done: ${r.turns.length} turns, aborted=${r.aborted ?? 'no'}`);
      if (i < SESSIONS_PER_CELL) await sleep(INTER_SESSION_DELAY_MS);
    }
    setRunning(false);
  }, [model, runOneSession, append]);

  const ttfas = useMemo(() => sessions.flatMap((s) => s.turns.filter((t) => t.status === 'DONE').map((t) => t.ttfaMs!)), [sessions]);
  const statusCounts = useMemo(() => {
    const c: Record<Status, number> = { DONE: 0, ERROR: 0, TIMEOUT: 0, EMPTY_RESPONSE: 0, INVALID: 0 };
    for (const s of sessions) for (const t of s.turns) c[t.status]++;
    return c;
  }, [sessions]);

  const copyJson = useCallback(() => {
    navigator.clipboard?.writeText(JSON.stringify({
      model, device, ua: navigator.userAgent, proxy: PROXY_URL, sessions,
      p50: pct(ttfas, 0.5), p90: pct(ttfas, 0.9), n: ttfas.length,
    }, null, 2));
  }, [model, device, sessions, ttfas]);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Spike A — Proxy TTFA (Fly)</h2>

      <section style={{ border: '1px solid #ddd', padding: 12, borderRadius: 6, marginBottom: 16 }}>
        <div><strong>Device:</strong> {device}</div>
        <div><strong>Proxy:</strong> <code>{PROXY_URL}</code></div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8 }}>
          <label style={{ marginRight: 8 }}>Creator:</label>
          {creators.length === 0 ? (
            <span style={{ color: 'crimson' }}>no creators — complete invite → application → approval first</span>
          ) : (
            <select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} disabled={running}>
              {creators.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName} (@{c.handle})</option>
              ))}
            </select>
          )}
        </div>
        <label style={{ marginRight: 8 }}>Model:</label>
        <select value={model} onChange={(e) => setModel(e.target.value as ModelId)} disabled={running}>
          <option value="gemini-2.5-flash-native-audio-preview-12-2025">2.5 native-audio (v1alpha, preview-12-2025)</option>
          <option value="gemini-3.1-flash-live-preview">3.1 Flash Live (preview)</option>
        </select>
        <label style={{ marginLeft: 12 }}>Turns/session:</label>
        <input
          type="number"
          min={1}
          max={20}
          value={turnsPerSession}
          onChange={(e) => {
            const n = Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1)));
            setTurnsPerSession(n);
          }}
          disabled={running}
          style={{ marginLeft: 6, width: 56 }}
        />
        <label style={{ marginLeft: 12 }}>Inter-turn ms:</label>
        <input
          type="number"
          min={0}
          max={5000}
          step={100}
          value={interTurnDelayMs}
          onChange={(e) => {
            const n = Math.max(0, Math.min(5000, Math.floor(Number(e.target.value) || 0)));
            setInterTurnDelayMs(n);
          }}
          disabled={running}
          style={{ marginLeft: 6, width: 72 }}
          title="Sleep between turn_complete and next turn_start (Gemini Live manual-VAD workaround probe)"
        />
        <button style={{ marginLeft: 12 }} onClick={onRun} disabled={running || !creatorId}>
          {running ? 'Running…' : `Run ${SESSIONS_PER_CELL}×${turnsPerSession} cell`}
        </button>
        <button style={{ marginLeft: 8 }} onClick={copyJson} disabled={!sessions.length}>Copy JSON</button>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Aggregate TTFA</h3>
        <div>n={ttfas.length} · p50={pct(ttfas, 0.5) ?? '—'}ms · p90={pct(ttfas, 0.9) ?? '—'}ms</div>
        <div style={{ marginTop: 4, fontSize: 13 }}>
          DONE={statusCounts.DONE} · EMPTY_RESPONSE={statusCounts.EMPTY_RESPONSE} · TIMEOUT={statusCounts.TIMEOUT} · ERROR={statusCounts.ERROR} · INVALID={statusCounts.INVALID}
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Sessions</h3>
        {sessions.map((s) => (
          <div key={s.sessionIdx} style={{ marginBottom: 12 }}>
            <div>
              <strong>Session {s.sessionIdx}</strong>
              <button
                onClick={() => playSessionAudio(s.sessionIdx)}
                style={{ marginLeft: 8, fontSize: 12 }}
                title="Play all TTS audio frames received for this session"
              >▶ Play audio</button>
              {s.aborted && <span style={{ color: 'crimson', marginLeft: 8 }}>aborted: {s.aborted}</span>}
            </div>
            <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['turn', 'ticket_ms', 'ws_ms', 'ready_ms', 'ttfa_ms', 'total_ms', 'status'].map((h) => (
                <th key={h} style={{ border: '1px solid #ccc', padding: '2px 8px', textAlign: 'left' }}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {s.turns.map((t) => (
                  <tr key={t.turn}>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.turn}</td>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.ticketMs ?? '—'}</td>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.wsMs ?? '—'}</td>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.readyMs ?? '—'}</td>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px', fontWeight: 600 }}>{t.ttfaMs ?? '—'}</td>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.totalMs ?? '—'}</td>
                    <td style={{ border: '1px solid #ccc', padding: '2px 8px' }}>{t.status}{t.reason ? ` (${t.reason})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section>
        <h3>Log</h3>
        <pre style={{ background: '#f7f7f7', padding: 8, fontSize: 12, maxHeight: 240, overflow: 'auto' }}>{log.join('\n')}</pre>
      </section>
    </div>
  );
}
