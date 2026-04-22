'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AvatarBridge,
  AvatarError,
  AvatarErrorCode,
  AvatarProvider,
} from '@/lib/avatar/avatar-bridge';
import { createSimliBridge } from '@/lib/avatar/simli-bridge';
import { createTavusBridge } from '@/lib/avatar/tavus-bridge';

// ── helpers (outside component, no React deps) ───────────────────────────────

async function resampleTo16kMono(encoded: ArrayBuffer): Promise<ArrayBuffer> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(encoded.slice(0));
  await ctx.close();
  const TARGET = 16000;
  const offCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET), TARGET);
  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start();
  const rendered = await offCtx.startRendering();
  const f32 = rendered.getChannelData(0);
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  }
  return i16.buffer;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function bestVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function attachTrackToVideo(videoEl: HTMLVideoElement | null, track: MediaStreamTrack | null) {
  if (!videoEl) return;
  if (!track) { videoEl.srcObject = null; return; }
  const existing = (videoEl.srcObject as MediaStream | null) ?? new MediaStream();
  existing.getVideoTracks().forEach((t) => existing.removeTrack(t));
  existing.addTrack(track);
  videoEl.srcObject = existing;
  videoEl.play().catch(() => { /* autoplay may block; user interaction unlocks */ });
}

// ── types ────────────────────────────────────────────────────────────────────

type Side = 'left' | 'right';
type Outcome = 'idle' | 'opening' | 'warming' | 'ready' | 'sending' | 'error' | 'closed';
type MicState = 'idle' | 'recording' | 'ready';

type RunTimers = { t0: number | null; t1: number | null; t2: number | null };

type SideState = {
  provider: AvatarProvider;
  status: Outcome;
  error?: string;
  errorCode?: AvatarErrorCode;
  timers: RunTimers;
  videoTrack: MediaStreamTrack | null;
  videoRec: boolean;
};

type RunConfig = {
  clipId: string;
  iteration: number;
  simliChunkBytes: 6000 | 1920;
  device: string;
  network: string;
  blindMode: boolean;
};

// ── clip library ─────────────────────────────────────────────────────────────

const CLIP_LIBRARY = [
  { id: '01_greeting',   label: '01 — "Hey, welcome to OakLeague."' },
  { id: '02_papa_bear',  label: '02 — "Papa Bear packed bags." (/p/,/b/)' },
  { id: '03_seashells',  label: '03 — "She sells seashells." (fricatives)' },
  { id: '04_vowel_hold', label: '04 — "Oooo, ahhhh, eeee."' },
  { id: '05_laugh',      label: '05 — "Ha. Ha ha ha. Hahaha!"' },
  { id: '06_fast',       label: '06 — "I really really really mean it."' },
  { id: '07_question',   label: '07 — "Wait… are you serious?"' },
  { id: '08_przemyslaw', label: '08 — "His name is Przemysław."' },
  { id: '09_emphasis',   label: '09 — "Look. I need you to listen."' },
  { id: '10_whisper',    label: '10 — loud whisper between you and me' },
];

// ── API helpers ───────────────────────────────────────────────────────────────

function randomSideMap(): { left: AvatarProvider; right: AvatarProvider } {
  return Math.random() < 0.5
    ? { left: 'simli', right: 'tavus' }
    : { left: 'tavus', right: 'simli' };
}

async function recordRun(args: {
  provider: AvatarProvider; clip: string; iteration: number;
  chunkSize: number | null; device: string; network: string;
  t0_t1_ms: number | null; t1_t2_ms: number | null;
  durationSeconds: number; reportedCostUsd: number;
  outcome: string; metadata?: Record<string, unknown>;
}): Promise<{ ok: true; cost_usd: number } | { ok: false; error: string }> {
  const res = await fetch('/api/spike-b/record', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: args.provider, clip_id: args.clip,
      chunk_size_bytes: args.chunkSize, iteration: args.iteration,
      device: args.device, network: args.network,
      t0_t1_ms: args.t0_t1_ms, t1_t2_ms: args.t1_t2_ms,
      duration_seconds: args.durationSeconds, reported_cost_usd: args.reportedCostUsd,
      outcome: args.outcome, metadata: args.metadata ?? null,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: false, error: `record_http_${res.status}:${body.error ?? '?'}` };
  }
  return (await res.json()) as { ok: true; cost_usd: number };
}

// ── component ─────────────────────────────────────────────────────────────────

export default function SpikeBClient({
  simliReplicaId,
  tavusReplicaId,
}: {
  simliReplicaId: string;
  tavusReplicaId: string;
}) {
  // config
  const [cfg, setCfg] = useState<RunConfig>({
    clipId: CLIP_LIBRARY[0].id, iteration: 1, simliChunkBytes: 6000,
    device: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 64) : 'server',
    network: 'wifi', blindMode: true,
  });

  const sideMapRef = useRef<{ left: AvatarProvider; right: AvatarProvider }>({
    left: 'simli', right: 'tavus',
  });

  // side state
  const [leftState, setLeftState] = useState<SideState>({
    provider: 'simli', status: 'idle', timers: { t0: null, t1: null, t2: null },
    videoTrack: null, videoRec: false,
  });
  const [rightState, setRightState] = useState<SideState>({
    provider: 'tavus', status: 'idle', timers: { t0: null, t1: null, t2: null },
    videoTrack: null, videoRec: false,
  });

  // bridge / DOM refs
  const leftBridgeRef = useRef<AvatarBridge | null>(null);
  const rightBridgeRef = useRef<AvatarBridge | null>(null);
  const leftVideoRef = useRef<HTMLVideoElement | null>(null);
  const rightVideoRef = useRef<HTMLVideoElement | null>(null);
  const leftAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const rightAudioTrackRef = useRef<MediaStreamTrack | null>(null);

  // mic recording
  const [micState, setMicState] = useState<MicState>('idle');
  const [clipDurS, setClipDurS] = useState(0);
  const [clipReady, setClipReady] = useState(false);
  const clipBufRef = useRef<ArrayBuffer | null>(null);
  const micRef = useRef<{ recorder: MediaRecorder | null; chunks: Blob[] }>({
    recorder: null, chunks: [],
  });

  // video recording per side
  const videoRecRef = useRef<{
    left: { recorder: MediaRecorder | null; chunks: Blob[] };
    right: { recorder: MediaRecorder | null; chunks: Blob[] };
  }>({ left: { recorder: null, chunks: [] }, right: { recorder: null, chunks: [] } });

  // log
  const [log, setLog] = useState<string[]>([]);
  const appendLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toISOString()} — ${line}`, ...prev].slice(0, 200));
  }, []);

  const setSide = useCallback((side: Side, patch: Partial<SideState>) => {
    (side === 'left' ? setLeftState : setRightState)((prev) => ({ ...prev, ...patch }));
  }, []);

  // ── open ────────────────────────────────────────────────────────────────────

  const openSide = useCallback(async (side: Side, provider: AvatarProvider) => {
    const replicaId = provider === 'simli' ? simliReplicaId : tavusReplicaId;
    if (!replicaId) {
      setSide(side, { status: 'error', error: `${provider} replica id not set in env` });
      return;
    }
    setSide(side, {
      provider, status: 'opening', error: undefined,
      timers: { t0: null, t1: null, t2: null }, videoTrack: null, videoRec: false,
    });
    (side === 'left' ? leftAudioTrackRef : rightAudioTrackRef).current = null;

    const bridgeHandlers = {
      onReady: () => {
        setSide(side, { status: 'warming' });
        appendLog(`${side}/${provider} connected — warming up lipsync…`);
      },
      onVideoTrack: (track: MediaStreamTrack) => {
        const t2 = performance.now();
        const curTimers = (side === 'left' ? leftState : rightState).timers;
        const delta = curTimers.t1 != null ? Math.round(t2 - curTimers.t1) : null;
        appendLog(`${side}/${provider} video-track (t2); t1→t2=${delta != null ? `${delta}ms` : 'audio not sent yet'}`);
        (side === 'left' ? setLeftState : setRightState)((prev) => ({
          ...prev, timers: { ...prev.timers, t2 }, videoTrack: track,
        }));
        attachTrackToVideo((side === 'left' ? leftVideoRef : rightVideoRef).current, track);
      },
      onAudioTrack: (track: MediaStreamTrack) => {
        (side === 'left' ? leftAudioTrackRef : rightAudioTrackRef).current = track;
        appendLog(`${side}/${provider} audio-track received`);
      },
      onError: (err: AvatarError) => {
        setSide(side, { status: 'error', errorCode: err.code, error: `${err.code}: ${err.message}` });
        appendLog(`${side}/${provider} error ${err.code}: ${err.message}`);
      },
      onFirstAudioSent: () => {
        const t1 = performance.now();
        (side === 'left' ? setLeftState : setRightState)((prev) => ({
          ...prev, timers: { ...prev.timers, t1 },
        }));
        appendLog(`${side}/${provider} first-audio-sent (t1)`);
      },
    };

    const bridge: AvatarBridge =
      provider === 'simli' ? createSimliBridge(bridgeHandlers) : createTavusBridge(bridgeHandlers);
    (side === 'left' ? leftBridgeRef : rightBridgeRef).current = bridge;

    const t0 = performance.now();
    const videoEl = (side === 'left' ? leftVideoRef : rightVideoRef).current ?? undefined;
    try {
      await bridge.open({ replicaId, simliChunkBytes: provider === 'simli' ? cfg.simliChunkBytes : undefined, videoEl });
      setSide(side, { timers: { t0, t1: null, t2: null } });

      // Send 2s of PCM silence so Simli's lipsync engine calibrates before first real clip.
      // Without this, clips 1-3 feel desync'd; by clip 4 the stream self-corrects.
      const WARMUP_S = 2;
      const silence = new Int16Array(WARMUP_S * 16000); // zeros
      const cs = cfg.simliChunkBytes / 2;
      for (let off = 0; off < silence.length; off += cs) {
        bridge.sendAudio(silence.slice(off, off + cs).buffer);
      }
      appendLog(`${side}/${provider} warmup queued (${WARMUP_S}s silence) — ready in ~${WARMUP_S}s`);
      await new Promise<void>((resolve) => setTimeout(resolve, WARMUP_S * 1000));
      const liveBridge = (side === 'left' ? leftBridgeRef : rightBridgeRef).current;
      if (liveBridge === bridge) {
        setSide(side, { status: 'ready' });
        appendLog(`${side}/${provider} warmed up — ready for clips`);
      }
    } catch (e) {
      appendLog(`${side}/${provider} open threw: ${(e as Error).message ?? String(e)}`);
    }
  }, [appendLog, cfg.simliChunkBytes, leftState, rightState, setSide, simliReplicaId, tavusReplicaId]);

  const openBoth = useCallback(async () => {
    const map = cfg.blindMode ? randomSideMap() : { left: 'simli' as AvatarProvider, right: 'tavus' as AvatarProvider };
    sideMapRef.current = map;
    appendLog(`side map: left=${map.left} right=${map.right}`);
    await Promise.all([openSide('left', map.left), openSide('right', map.right)]);
  }, [appendLog, cfg.blindMode, openSide]);

  // ── mic recording ────────────────────────────────────────────────────────────

  const startMicRec = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      micRef.current.chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) micRef.current.chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          const blob = new Blob(micRef.current.chunks, { type: mimeType });
          const pcm = await resampleTo16kMono(await blob.arrayBuffer());
          clipBufRef.current = pcm;
          const dur = +(pcm.byteLength / 2 / 16000).toFixed(1);
          setClipDurS(dur);
          setClipReady(true);
          setMicState('ready');
          appendLog(`clip ready: ${dur}s · ${(pcm.byteLength / 1024).toFixed(0)}KB @ 16kHz PCM16`);
        } catch (err) {
          appendLog(`clip decode failed: ${(err as Error).message}`);
          setMicState('idle');
        }
      };
      recorder.start();
      micRef.current.recorder = recorder;
      setMicState('recording');
      setClipReady(false);
      appendLog('mic recording…');
    } catch (err) {
      appendLog(`mic access failed: ${(err as Error).message}`);
    }
  }, [appendLog]);

  const stopMicRec = useCallback(() => {
    micRef.current.recorder?.stop();
    micRef.current.recorder = null;
  }, []);

  // ── send clip audio ───────────────────────────────────────────────────────────

  const sendClipAudio = useCallback((side: Side) => {
    const bridge = side === 'left' ? leftBridgeRef.current : rightBridgeRef.current;
    const buf = clipBufRef.current;
    if (!bridge) { appendLog(`${side}: no bridge — open first`); return; }
    if (!buf) { appendLog(`${side}: no clip — record first`); return; }
    const i16 = new Int16Array(buf);
    const chunkSamples = cfg.simliChunkBytes / 2;
    const numChunks = Math.ceil(i16.length / chunkSamples);
    for (let offset = 0; offset < i16.length; offset += chunkSamples) {
      bridge.sendAudio(i16.slice(offset, offset + chunkSamples).buffer);
    }
    appendLog(`${side} sent clip ${cfg.clipId} (${numChunks} chunks @ ${cfg.simliChunkBytes}B)`);
  }, [appendLog, cfg.clipId, cfg.simliChunkBytes]);

  // ── test tone (keep for quick wake-up testing) ────────────────────────────────

  const sendTestTone = useCallback((side: Side) => {
    const bridge = side === 'left' ? leftBridgeRef.current : rightBridgeRef.current;
    if (!bridge) { appendLog(`${side}: no bridge`); return; }
    const SR = 16000; const DUR = 2; const FREQ = 440; const AMP = 0.4;
    const n = SR * DUR;
    const buf = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      buf[i] = Math.round(Math.sin(2 * Math.PI * FREQ * i / SR) * AMP * 32767);
    }
    const cs = cfg.simliChunkBytes / 2;
    for (let offset = 0; offset < n; offset += cs) {
      bridge.sendAudio(buf.slice(offset, offset + cs).buffer);
    }
    appendLog(`${side} sent 440Hz test tone (${Math.ceil(n / cs)} chunks)`);
  }, [appendLog, cfg.simliChunkBytes]);

  // ── video recording ───────────────────────────────────────────────────────────

  const startVideoRec = useCallback((side: Side) => {
    const videoEl = (side === 'left' ? leftVideoRef : rightVideoRef).current;
    const audioTrack = (side === 'left' ? leftAudioTrackRef : rightAudioTrackRef).current;
    if (!videoEl?.srcObject) { appendLog(`${side}: no video stream yet`); return; }

    const videoTracks = (videoEl.srcObject as MediaStream).getVideoTracks();
    const tracks = audioTrack ? [...videoTracks, audioTrack] : videoTracks;
    const stream = new MediaStream(tracks);
    const mimeType = bestVideoMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const state = videoRecRef.current[side];
    state.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) state.chunks.push(e.data); };
    recorder.onstop = () => {
      const provider = side === 'left' ? leftState.provider : rightState.provider;
      const blob = new Blob(state.chunks, { type: 'video/webm' });
      downloadBlob(blob, `spike-b_${cfg.clipId}_${provider}_${side}_iter${cfg.iteration}.webm`);
      appendLog(`${side} video saved · ${(blob.size / 1024).toFixed(0)}KB · audio=${!!audioTrack}`);
      setSide(side, { videoRec: false });
    };
    recorder.start(100);
    state.recorder = recorder;
    setSide(side, { videoRec: true });
    appendLog(`${side} video rec started (${mimeType || 'default'}, audio=${!!audioTrack})`);
  }, [appendLog, cfg.clipId, cfg.iteration, leftState.provider, rightState.provider, setSide]);

  const stopVideoRec = useCallback((side: Side) => {
    videoRecRef.current[side].recorder?.stop();
    videoRecRef.current[side].recorder = null;
  }, []);

  // ── close ─────────────────────────────────────────────────────────────────────

  const closeAll = useCallback(() => {
    (['left', 'right'] as Side[]).forEach((side) => {
      const s = videoRecRef.current[side];
      if (s.recorder) { s.recorder.stop(); s.recorder = null; }
    });
    leftBridgeRef.current?.close();
    rightBridgeRef.current?.close();
    leftBridgeRef.current = null;
    rightBridgeRef.current = null;
    setLeftState((s) => ({ ...s, status: 'closed', videoTrack: null, videoRec: false }));
    setRightState((s) => ({ ...s, status: 'closed', videoTrack: null, videoRec: false }));
    appendLog('closed both sides');
  }, [appendLog]);

  // ── record run ────────────────────────────────────────────────────────────────

  const recordSide = useCallback(async (side: Side) => {
    const s = side === 'left' ? leftState : rightState;
    const t0t1 = s.timers.t0 != null && s.timers.t1 != null ? Math.round(s.timers.t1 - s.timers.t0) : null;
    const t1t2 = s.timers.t1 != null && s.timers.t2 != null ? Math.round(s.timers.t2 - s.timers.t1) : null;
    const duration = clipDurS > 0 ? clipDurS : 8;
    const outcome = s.status === 'error' ? (s.errorCode ?? 'other') : 'ok';
    const metadata = s.status === 'error'
      ? { source: 'spike_b_harness', outcome_raw: s.error ?? 'unknown' }
      : { source: 'spike_b_harness' };
    const r = await recordRun({
      provider: s.provider, clip: cfg.clipId, iteration: cfg.iteration,
      chunkSize: s.provider === 'simli' ? cfg.simliChunkBytes : null,
      device: cfg.device, network: cfg.network,
      t0_t1_ms: t0t1, t1_t2_ms: t1t2,
      durationSeconds: duration, reportedCostUsd: 0,
      outcome, metadata,
    });
    appendLog(r.ok
      ? `${side}/${s.provider} recorded (clamped $${r.cost_usd.toFixed(6)})`
      : `${side}/${s.provider} record failed: ${r.error}`);
  }, [appendLog, cfg, clipDurS, leftState, rightState]);

  // ── render ────────────────────────────────────────────────────────────────────

  const sideMap = sideMapRef.current;
  const mapBadge = useMemo(
    () => `left=${cfg.blindMode ? '(hidden)' : sideMap.left}, right=${cfg.blindMode ? '(hidden)' : sideMap.right}`,
    [cfg.blindMode, sideMap.left, sideMap.right],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Spike B — Avatar Provider Harness</h1>
      <p style={{ opacity: 0.8, fontSize: 13 }}>
        Phase 2 · side map: <code>{mapBadge}</code>
      </p>

      {/* ── Config ── */}
      <fieldset style={{ padding: 12, border: '1px solid #ccc', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label>
          Clip&nbsp;
          <select value={cfg.clipId} onChange={(e) => setCfg({ ...cfg, clipId: e.target.value })}>
            {CLIP_LIBRARY.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label>
          Iter&nbsp;
          <input type="number" min={1} max={100} value={cfg.iteration}
            onChange={(e) => setCfg({ ...cfg, iteration: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
            style={{ width: 60 }} />
        </label>
        <label>
          Simli chunk&nbsp;
          <select value={cfg.simliChunkBytes} onChange={(e) => setCfg({ ...cfg, simliChunkBytes: Number(e.target.value) as 6000 | 1920 })}>
            <option value={6000}>6000B (187ms)</option>
            <option value={1920}>1920B (60ms)</option>
          </select>
        </label>
        <label>
          Network&nbsp;
          <select value={cfg.network} onChange={(e) => setCfg({ ...cfg, network: e.target.value })}>
            <option>wifi</option><option>lte</option><option>5g</option><option>ethernet</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={cfg.blindMode}
            onChange={(e) => setCfg({ ...cfg, blindMode: e.target.checked })} /> Blind mode
        </label>
      </fieldset>

      {/* ── Mic / clip audio ── */}
      <fieldset style={{ padding: 12, border: '2px solid #c80', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ fontSize: 13, minWidth: 80 }}>Clip audio</strong>
        <span style={{ fontSize: 12, opacity: 0.7, flex: 1, minWidth: 180 }}>
          {CLIP_LIBRARY.find((c) => c.id === cfg.clipId)?.label}
        </span>
        {micState !== 'recording' ? (
          <button onClick={startMicRec}
            style={{ background: '#c00', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 4, cursor: 'pointer' }}>
            ⏺ {micState === 'ready' ? 'Re-rec' : 'Rec'}
          </button>
        ) : (
          <button onClick={stopMicRec}
            style={{ background: '#900', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 4, cursor: 'pointer' }}>
            ⏹ Stop
          </button>
        )}
        {micState === 'ready' && (
          <span style={{ fontSize: 12, color: 'green', whiteSpace: 'nowrap' }}>✓ {clipDurS}s ready</span>
        )}
        <span style={{ borderLeft: '1px solid #ccc', height: 24 }} />
        <button onClick={() => sendClipAudio('left')} disabled={!clipReady}>▶ Send L</button>
        <button onClick={() => sendClipAudio('right')} disabled={!clipReady}>▶ Send R</button>
        <button onClick={() => { sendClipAudio('left'); sendClipAudio('right'); }} disabled={!clipReady}
          style={{ fontWeight: 'bold' }}>▶ Send both</button>
      </fieldset>

      {/* ── Session controls ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={openBoth}>Open both</button>
        <button onClick={closeAll}>Close both</button>
        <button onClick={() => sendTestTone('left')}>Tone L</button>
        <button onClick={() => sendTestTone('right')}>Tone R</button>
        <span style={{ borderLeft: '1px solid #ccc', height: 24 }} />
        {/* Video capture — one button per side, toggles rec on/off */}
        {!leftState.videoRec ? (
          <button onClick={() => startVideoRec('left')} disabled={leftState.status !== 'ready'}
            style={{ background: '#222', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 4, cursor: 'pointer' }}>
            ⏺ Rec video L
          </button>
        ) : (
          <button onClick={() => stopVideoRec('left')}
            style={{ background: 'crimson', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
            ⏹ Stop + save L
          </button>
        )}
        {!rightState.videoRec ? (
          <button onClick={() => startVideoRec('right')} disabled={rightState.status !== 'ready'}
            style={{ background: '#222', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 4, cursor: 'pointer' }}>
            ⏺ Rec video R
          </button>
        ) : (
          <button onClick={() => stopVideoRec('right')}
            style={{ background: 'crimson', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
            ⏹ Stop + save R
          </button>
        )}
        <span style={{ borderLeft: '1px solid #ccc', height: 24 }} />
        <button onClick={() => recordSide('left')}>Record left</button>
        <button onClick={() => recordSide('right')}>Record right</button>
      </div>

      {/* ── Side panels ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SidePanel name="left" state={leftState} videoRef={leftVideoRef} />
        <SidePanel name="right" state={rightState} videoRef={rightVideoRef} />
      </div>

      {/* ── Log ── */}
      <details>
        <summary>Log ({log.length})</summary>
        <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 11 }}>{log.join('\n')}</pre>
      </details>
    </div>
  );
}

function SidePanel({
  name, state, videoRef,
}: {
  name: Side;
  state: SideState;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
}) {
  const t0t1 = state.timers.t0 != null && state.timers.t1 != null
    ? `${Math.round(state.timers.t1 - state.timers.t0)}ms` : '—';
  const t1t2 = state.timers.t1 != null && state.timers.t2 != null
    ? `${Math.round(state.timers.t2 - state.timers.t1)}ms` : '—';

  return (
    <div style={{ border: '1px solid #ccc', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{name.toUpperCase()}</strong>
        <span style={{ fontSize: 13 }}>
          <code>{state.provider}</code> · {state.status}
          {state.status === 'warming' && <span style={{ color: '#c80', marginLeft: 6 }}>⏳ 2s</span>}
          {state.videoRec && <span style={{ color: 'crimson', marginLeft: 6, fontWeight: 'bold' }}>⏺ REC</span>}
        </span>
      </div>
      <video ref={videoRef}
        style={{ width: '100%', aspectRatio: '9 / 16', background: '#111' }}
        playsInline muted autoPlay />
      <div style={{ fontSize: 12 }}>
        t0→t1: {t0t1} · t1→t2: {t1t2}
      </div>
      {state.error && <div style={{ color: 'crimson', fontSize: 12 }}>{state.error}</div>}
    </div>
  );
}
