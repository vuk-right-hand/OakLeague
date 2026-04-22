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

// Side-by-side harness. Both <video> panels; blind-mode randomizes which
// provider is on which side, logs the mapping so Phase 3 scoring uses the
// same map. Per-run dual-timer: t0→t1 (buffering) and t1→t2 (handshake).
// SPIKE_B_PLAN.md Phase 1 + §Architecture.

type Side = 'left' | 'right';
type Outcome = 'idle' | 'opening' | 'ready' | 'sending' | 'error' | 'closed';

type RunTimers = {
  t0: number | null;
  t1: number | null;
  t2: number | null;
};

type SideState = {
  provider: AvatarProvider;
  status: Outcome;
  error?: string;
  errorCode?: AvatarErrorCode;
  timers: RunTimers;
  videoTrack: MediaStreamTrack | null;
};

type RunConfig = {
  clipId: string;
  iteration: number;
  simliChunkBytes: 6000 | 1920;
  device: string;
  network: string;
  blindMode: boolean;
};

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

function randomSideMap(): { left: AvatarProvider; right: AvatarProvider } {
  const flip = Math.random() < 0.5;
  return flip
    ? { left: 'simli', right: 'tavus' }
    : { left: 'tavus', right: 'simli' };
}

async function recordRun(args: {
  provider: AvatarProvider;
  clip: string;
  iteration: number;
  chunkSize: number | null;
  device: string;
  network: string;
  t0_t1_ms: number | null;
  t1_t2_ms: number | null;
  durationSeconds: number;
  reportedCostUsd: number;
  outcome: string;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: true; cost_usd: number } | { ok: false; error: string }> {
  const res = await fetch('/api/spike-b/record', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: args.provider,
      clip_id: args.clip,
      chunk_size_bytes: args.chunkSize,
      iteration: args.iteration,
      device: args.device,
      network: args.network,
      t0_t1_ms: args.t0_t1_ms,
      t1_t2_ms: args.t1_t2_ms,
      duration_seconds: args.durationSeconds,
      reported_cost_usd: args.reportedCostUsd,
      outcome: args.outcome,
      metadata: args.metadata ?? null,
    }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: false, error: `record_http_${res.status}:${errBody.error ?? '?'}` };
  }
  return (await res.json()) as { ok: true; cost_usd: number };
}

function attachTrackToVideo(videoEl: HTMLVideoElement | null, track: MediaStreamTrack | null) {
  if (!videoEl) return;
  if (!track) { videoEl.srcObject = null; return; }
  const existing = (videoEl.srcObject as MediaStream | null) ?? new MediaStream();
  existing.getVideoTracks().forEach((t) => existing.removeTrack(t));
  existing.addTrack(track);
  videoEl.srcObject = existing;
  videoEl.play().catch(() => { /* autoplay may block; operator click-to-play */ });
}

export default function SpikeBClient({
  simliReplicaId,
  tavusReplicaId,
}: {
  simliReplicaId: string;
  tavusReplicaId: string;
}) {
  const [cfg, setCfg] = useState<RunConfig>({
    clipId: CLIP_LIBRARY[0].id,
    iteration: 1,
    simliChunkBytes: 6000,
    device: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 64) : 'server',
    network: 'wifi',
    blindMode: true,
  });

  // Side mapping — randomized per open() when blindMode. Stored so we can log
  // it along with the run (raters never see this; admin UI shows it after run).
  const sideMapRef = useRef<{ left: AvatarProvider; right: AvatarProvider }>({
    left: 'simli', right: 'tavus',
  });

  const [leftState, setLeftState] = useState<SideState>({
    provider: 'simli', status: 'idle', timers: { t0: null, t1: null, t2: null }, videoTrack: null,
  });
  const [rightState, setRightState] = useState<SideState>({
    provider: 'tavus', status: 'idle', timers: { t0: null, t1: null, t2: null }, videoTrack: null,
  });

  const leftBridgeRef = useRef<AvatarBridge | null>(null);
  const rightBridgeRef = useRef<AvatarBridge | null>(null);
  const leftVideoRef = useRef<HTMLVideoElement | null>(null);
  const rightVideoRef = useRef<HTMLVideoElement | null>(null);

  const [log, setLog] = useState<string[]>([]);
  const appendLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toISOString()} — ${line}`, ...prev].slice(0, 200));
  }, []);

  const setSide = useCallback((side: Side, patch: Partial<SideState>) => {
    (side === 'left' ? setLeftState : setRightState)((prev) => ({ ...prev, ...patch }));
  }, []);

  const openSide = useCallback(async (side: Side, provider: AvatarProvider) => {
    const replicaId = provider === 'simli' ? simliReplicaId : tavusReplicaId;
    if (!replicaId) {
      setSide(side, { status: 'error', error: `${provider} replica id not set in env` });
      return;
    }

    setSide(side, {
      provider,
      status: 'opening',
      error: undefined,
      timers: { t0: null, t1: null, t2: null },
      videoTrack: null,
    });

    const bridgeHandlers = {
      onReady: () => {
        setSide(side, { status: 'ready' });
        appendLog(`${side}/${provider} ready`);
      },
      onVideoTrack: (track: MediaStreamTrack) => {
        const t2 = performance.now();
        // Read t1 from current state snapshot for the log — functional update
        // below captures t2 for recording. appendLog must be outside the updater
        // (StrictMode double-invokes updaters; side-effects inside log twice).
        const curState = side === 'left' ? leftState : rightState;
        const delta = curState.timers.t1 != null ? Math.round(t2 - curState.timers.t1) : null;
        appendLog(`${side}/${provider} video-track (t2); t1→t2=${delta != null ? `${delta}ms` : 'audio not sent yet'}`);
        (side === 'left' ? setLeftState : setRightState)((prev) => ({
          ...prev, timers: { ...prev.timers, t2 }, videoTrack: track,
        }));
        const el = side === 'left' ? leftVideoRef.current : rightVideoRef.current;
        attachTrackToVideo(el, track);
      },
      onError: (err: AvatarError) => {
        setSide(side, { status: 'error', errorCode: err.code, error: `${err.code}: ${err.message}` });
        appendLog(`${side}/${provider} error ${err.code}: ${err.message}`);
      },
      onFirstAudioSent: () => {
        const t1 = performance.now();
        (side === 'left' ? setLeftState : setRightState)((prev) => ({
          ...prev,
          timers: { ...prev.timers, t1 },
        }));
        appendLog(`${side}/${provider} first-audio-sent (t1)`);
      },
    };

    const bridge: AvatarBridge =
      provider === 'simli'
        ? createSimliBridge(bridgeHandlers)
        : createTavusBridge(bridgeHandlers);

    (side === 'left' ? leftBridgeRef : rightBridgeRef).current = bridge;

    const t0 = performance.now();
    const videoEl = (side === 'left' ? leftVideoRef : rightVideoRef).current ?? undefined;
    try {
      await bridge.open({
        replicaId,
        simliChunkBytes: provider === 'simli' ? cfg.simliChunkBytes : undefined,
        videoEl,
      });
      setSide(side, { timers: { t0, t1: null, t2: null } });
      appendLog(`${side}/${provider} session open (t1 pending first audio, t2 pending first frame)`);
    } catch (e) {
      appendLog(`${side}/${provider} open threw: ${(e as Error).message ?? String(e)}`);
    }
  }, [appendLog, cfg.simliChunkBytes, setSide, simliReplicaId, tavusReplicaId]);

  const openBoth = useCallback(async () => {
    const map = cfg.blindMode ? randomSideMap() : { left: 'simli' as AvatarProvider, right: 'tavus' as AvatarProvider };
    sideMapRef.current = map;
    appendLog(`side map: left=${map.left} right=${map.right}`);
    await Promise.all([openSide('left', map.left), openSide('right', map.right)]);
  }, [appendLog, cfg.blindMode, openSide]);

  // Generate a 440Hz tone at 16kHz PCM16 LE mono and send it to a bridge.
  // Simli is audio→video: it won't render frames until it receives audio.
  // This button wakes the avatar and triggers the video pipeline.
  const sendTestAudio = useCallback((side: Side) => {
    const bridge = side === 'left' ? leftBridgeRef.current : rightBridgeRef.current;
    if (!bridge) { appendLog(`${side}: no bridge`); return; }
    const SAMPLE_RATE = 16000;
    const DURATION_S = 2;
    const FREQ = 440;
    const AMPLITUDE = 0.4;
    const numSamples = SAMPLE_RATE * DURATION_S;
    const buf = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      buf[i] = Math.round(Math.sin(2 * Math.PI * FREQ * i / SAMPLE_RATE) * AMPLITUDE * 32767);
    }
    const chunkBytes = cfg.simliChunkBytes;
    const chunkSamples = chunkBytes / 2; // Int16 = 2 bytes per sample
    let offset = 0;
    while (offset < numSamples) {
      const slice = buf.slice(offset, offset + chunkSamples);
      bridge.sendAudio(slice.buffer);
      offset += chunkSamples;
    }
    appendLog(`${side} sent 2s 440Hz test tone (${Math.ceil(numSamples / chunkSamples)} chunks @ ${chunkBytes}B)`);
  }, [appendLog, cfg.simliChunkBytes]);

  const closeAll = useCallback(() => {
    leftBridgeRef.current?.close();
    rightBridgeRef.current?.close();
    leftBridgeRef.current = null;
    rightBridgeRef.current = null;
    setLeftState((s) => ({ ...s, status: 'closed', videoTrack: null }));
    setRightState((s) => ({ ...s, status: 'closed', videoTrack: null }));
    appendLog('closed both sides');
  }, [appendLog]);

  const recordSide = useCallback(async (side: Side) => {
    const s = side === 'left' ? leftState : rightState;
    const t0t1 = s.timers.t0 != null && s.timers.t1 != null ? Math.round(s.timers.t1 - s.timers.t0) : null;
    const t1t2 = s.timers.t1 != null && s.timers.t2 != null ? Math.round(s.timers.t2 - s.timers.t1) : null;
    // Duration/cost are best-effort from clip length; the record route clamps DOWN.
    const duration = 8; // upper bound of clip library; route validates.
    const reportedCost = 0; // bridge does not yet report; clamp-down still applies.
    const outcome = s.status === 'error' ? (s.errorCode ?? 'other') : 'ok';
    const metadata =
      s.status === 'error'
        ? { source: 'spike_b_harness', outcome_raw: s.error ?? 'unknown' }
        : { source: 'spike_b_harness' };
    const r = await recordRun({
      provider: s.provider,
      clip: cfg.clipId,
      iteration: cfg.iteration,
      chunkSize: s.provider === 'simli' ? cfg.simliChunkBytes : null,
      device: cfg.device,
      network: cfg.network,
      t0_t1_ms: t0t1,
      t1_t2_ms: t1t2,
      durationSeconds: duration,
      reportedCostUsd: reportedCost,
      outcome,
      metadata,
    });
    appendLog(
      r.ok
        ? `${side}/${s.provider} recorded (clamped cost $${r.cost_usd.toFixed(6)})`
        : `${side}/${s.provider} record failed: ${r.error}`,
    );
  }, [appendLog, cfg.clipId, cfg.device, cfg.iteration, cfg.network, cfg.simliChunkBytes, leftState, rightState]);

  const sideMap = sideMapRef.current;
  const mapBadge = useMemo(
    () => `left=${cfg.blindMode ? '(hidden)' : sideMap.left}, right=${cfg.blindMode ? '(hidden)' : sideMap.right}`,
    [cfg.blindMode, sideMap.left, sideMap.right],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Spike B — Avatar Provider Harness</h1>
      <p style={{ opacity: 0.8, fontSize: 13 }}>
        SPIKE_B_PLAN.md Phase 1 smoke. Both providers open in parallel.
        Left/right mapping: <code>{mapBadge}</code>. Blind mode randomizes per <code>Open both</code>.
      </p>

      <fieldset style={{ padding: 12, border: '1px solid #ccc', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label>
          Clip&nbsp;
          <select
            value={cfg.clipId}
            onChange={(e) => setCfg({ ...cfg, clipId: e.target.value })}
          >
            {CLIP_LIBRARY.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label>
          Iter&nbsp;
          <input
            type="number" min={1} max={100} value={cfg.iteration}
            onChange={(e) => setCfg({ ...cfg, iteration: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
            style={{ width: 60 }}
          />
        </label>
        <label>
          Simli chunk&nbsp;
          <select
            value={cfg.simliChunkBytes}
            onChange={(e) => setCfg({ ...cfg, simliChunkBytes: Number(e.target.value) as 6000 | 1920 })}
          >
            <option value={6000}>6000B (187ms)</option>
            <option value={1920}>1920B (60ms)</option>
          </select>
        </label>
        <label>
          Network&nbsp;
          <select value={cfg.network} onChange={(e) => setCfg({ ...cfg, network: e.target.value })}>
            <option>wifi</option>
            <option>lte</option>
            <option>5g</option>
            <option>ethernet</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox" checked={cfg.blindMode}
            onChange={(e) => setCfg({ ...cfg, blindMode: e.target.checked })}
          /> Blind mode
        </label>
      </fieldset>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={openBoth}>Open both</button>
        <button onClick={closeAll}>Close both</button>
        <button onClick={() => sendTestAudio('left')}>Send audio L</button>
        <button onClick={() => sendTestAudio('right')}>Send audio R</button>
        <button onClick={() => recordSide('left')}>Record left</button>
        <button onClick={() => recordSide('right')}>Record right</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SidePanel name="left"  state={leftState}  videoRef={leftVideoRef} />
        <SidePanel name="right" state={rightState} videoRef={rightVideoRef} />
      </div>

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
  const t0t1 =
    state.timers.t0 != null && state.timers.t1 != null
      ? `${Math.round(state.timers.t1 - state.timers.t0)}ms`
      : '—';
  const t1t2 =
    state.timers.t1 != null && state.timers.t2 != null
      ? `${Math.round(state.timers.t2 - state.timers.t1)}ms`
      : '—';

  return (
    <div style={{ border: '1px solid #ccc', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong>{name.toUpperCase()}</strong>
        <span>
          <code>{state.provider}</code> · {state.status}
        </span>
      </div>
      <video
        ref={videoRef}
        style={{ width: '100%', aspectRatio: '9 / 16', background: '#000' }}
        playsInline muted
      />
      <div style={{ fontSize: 12 }}>
        t0→t1: {t0t1} · t1→t2: {t1t2}
      </div>
      {state.error && <div style={{ color: 'crimson', fontSize: 12 }}>{state.error}</div>}
    </div>
  );
}
