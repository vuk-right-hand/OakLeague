// use-session-pipe — wires the pure reducer to Simli + Gemini + mic capture.
//
// Flow at the hook level:
//   1. Caller already POSTed /api/sessions/open; hands us the envelope.
//   2. Hook opens SimliBridge (pre-minted token path — R3-C2/P0-5) in parallel
//      with Gemini GoogleGenAI.live.connect.
//   3. Both pipes hit 'ready' → reducer flips to 'ready'; UI enables mic.
//   4. press-and-hold mic → activityStart + stream worklet frames → activityEnd.
//   5. Gemini onmessage audio part → base64 → PCM16 bytes → simliBridge.sendAudio.
//   6. Gemini interrupted → simliBridge.cancel() (pipe stays warm — R2-M4).
//   7. Heartbeat every 20s → /api/sessions/heartbeat; 410 → fatal_error.
//   8. visibilitychange → reducer; effect POSTs pause/resume.
//   9. Ticker: at maxSessionSeconds → POST /api/sessions/rollover; replace tokens.
//
// Tokens never enter React state. They live on a ref. PostHog captures go
// through captureSafe (R3-S2).

'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import * as Sentry from '@sentry/nextjs';
import { createSimliBridge } from '@/lib/avatar/simli-bridge';
import type { AvatarBridge, AvatarError } from '@/lib/avatar/avatar-bridge';
import { captureSafe } from '@/lib/posthog-safe-capture';
import {
  initialState,
  reduce,
  type Action,
  type SessionState,
} from './session-reducer';

// Envelope shape returned by POST /api/sessions/open and /api/sessions/rollover.
export type OpenEnvelope = {
  session_id: string;
  tier: 'free' | 'premium' | 'boardroom';
  avatar: { session_token: string; expires_at: string; face_id: string } | null;
  avatar_status: 'pending' | 'minted' | 'skipped_tier' | 'failed_mint' | 'failed_connect' | 'not_applicable';
  gemini: { token: string; model: string };
  max_duration_s: number;
  max_session_s: number;
};

export type UseSessionPipeArgs = {
  envelope: OpenEnvelope;
  creatorId: string;
  hookId: string;
  systemInstruction?: string;
  // Dev-only: client-side shortcut for the 15-min rollover flow. Reads
  // NEXT_PUBLIC_GEMINI_SESSION_CAP_S from window.__next env at mount; server
  // remains authoritative via envelope.max_session_s. (R3-S4)
  rolloverOverrideSeconds?: number;
};

const HEARTBEAT_MS = 20_000;
// Rate-limit-floor on the server is 10s; we poll at 20s to stay well clear.

const AUDIO_CONTEXT_RESUME_VERIFY_MS = 300;
// iOS WebKit: verify AudioContext.state === 'running' 300ms after resume()
// (R3-M4 — visibilitychange is not a user gesture).

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export type PipeHandle = {
  state: SessionState;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  startMic: () => void;
  stopMic: () => void;
  endSession: (reason: 'user_ended' | 'client_error') => Promise<void>;
  // Manual retry after reconnecting-overlay click (provides user gesture to
  // unlock AudioContext on iOS).
  retryAfterGesture: () => Promise<void>;
  lipsyncLatencyMs: number | null;
};

export function useSessionPipe(args: UseSessionPipeArgs): PipeHandle {
  const [state, dispatch] = useReducer(reduce, {
    ...initialState,
    sessionId: args.envelope.session_id,
    tier: args.envelope.tier,
    avatarStatus: args.envelope.avatar_status,
    maxSessionSeconds:
      args.rolloverOverrideSeconds && args.rolloverOverrideSeconds > 0
        ? Math.min(args.rolloverOverrideSeconds, args.envelope.max_session_s)
        : args.envelope.max_session_s,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refs for things that must not trigger re-renders and must survive
  // reducer updates. Tokens live HERE (never in state).
  const bridgeRef = useRef<AvatarBridge | null>(null);
  const geminiRef = useRef<Session | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const ephemeralTokenRef = useRef<string>(args.envelope.gemini.token);
  const modelRef = useRef<string>(args.envelope.gemini.model);
  const preMintedSimliRef = useRef<string | null>(args.envelope.avatar?.session_token ?? null);
  const sessionIdRef = useRef<string>(args.envelope.session_id);
  const closedRef = useRef<boolean>(false);
  const rollingOverRef = useRef<boolean>(false);
  const lipsyncLatencyRef = useRef<number | null>(null);
  // Playback of Gemini audio chunks via the Web Audio API route goes directly
  // to the Simli bridge — we don't play Gemini audio to the user locally.
  // The avatar speaks.

  function dispatchRef(a: Action) {
    if (closedRef.current && a.kind !== 'closed_ack') return;
    dispatch(a);
  }

  // ── Boot: open both pipes in parallel ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    dispatch({ kind: 'boot_started' });

    // Avatar not expected? Mark satisfied.
    if (args.envelope.avatar_status !== 'minted' && args.envelope.avatar_status !== 'pending') {
      dispatch({ kind: 'avatar_not_expected' });
    }

    // 1. Simli bridge — production path: pass preMintedSessionToken. If not
    //    minted server-side, skip entirely (voice-only fallback).
    async function openAvatar(): Promise<void> {
      if (!args.envelope.avatar || args.envelope.avatar_status !== 'minted') {
        return; // voice-only
      }
      const bridge = createSimliBridge({
        onReady: () => {
          if (cancelled) return;
          dispatchRef({ kind: 'avatar_ready' });
          captureSafe('session_ready', { surface: 'avatar', session_id: sessionIdRef.current });
        },
        onError: (err: AvatarError) => {
          if (cancelled) return;
          Sentry.captureException(new Error(`avatar_${err.code}`), {
            extra: { session_id: sessionIdRef.current, err_code: err.code, recoverable: err.recoverable },
          });
          dispatchRef({ kind: 'fatal_error', message: `avatar: ${err.code}` });
        },
        onLipsyncLatency: (ms) => {
          lipsyncLatencyRef.current = ms;
          captureSafe('simli_lipsync_latency_ms', { ms, session_id: sessionIdRef.current });
        },
      });
      bridgeRef.current = bridge;
      try {
        await bridge.open({
          replicaId: args.envelope.avatar.face_id,
          preMintedSessionToken: preMintedSimliRef.current ?? undefined,
          videoEl: videoRef.current ?? undefined,
          audioEl: audioRef.current ?? undefined,
        });
      } catch (e) {
        // onError path already dispatched; nothing to do here.
        Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: 'simli_open' } });
      }
    }

    // 2. Gemini Live WS — @google/genai live.connect.
    async function openGemini(): Promise<void> {
      try {
        const client = new GoogleGenAI({
          apiKey: ephemeralTokenRef.current,
          httpOptions: { apiVersion: 'v1alpha' },
        });
        const session = await client.live.connect({
          model: modelRef.current,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction:
              args.systemInstruction ??
              'You are a helpful mentor. Answer in concise spoken English.',
            // Server-VAD (automatic) — user taps and holds mic, but Gemini
            // decides when they stopped. Simpler than manual VAD in-browser.
            realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
          },
          callbacks: {
            onopen: () => { /* WS open — wait for setupComplete */ },
            onmessage: (m: LiveServerMessage) => {
              if (cancelled) return;
              if (m.setupComplete) {
                dispatchRef({ kind: 'gemini_setup_complete' });
                captureSafe('session_ready', { surface: 'gemini', session_id: sessionIdRef.current });
                return;
              }
              // Interruption: Gemini cancels its in-flight response. We keep
              // the pipe warm: simli.cancel() clears its playback buffer.
              if (m.serverContent?.interrupted) {
                dispatchRef({ kind: 'gemini_interrupted' });
                try { bridgeRef.current?.cancel(); } catch { /* bridge already closed */ }
                captureSafe('barge_in', { session_id: sessionIdRef.current });
              }
              const parts = m.serverContent?.modelTurn?.parts ?? [];
              let gotAudio = false;
              for (const p of parts) {
                if (p.inlineData?.mimeType?.startsWith('audio/pcm') && p.inlineData.data) {
                  gotAudio = true;
                  const bytes = base64ToBytes(p.inlineData.data);
                  try { bridgeRef.current?.sendAudio(bytes.buffer as ArrayBuffer); } catch { /* bridge closed */ }
                }
              }
              if (gotAudio) dispatchRef({ kind: 'gemini_audio_chunk' });
              if (m.serverContent?.turnComplete) {
                dispatchRef({ kind: 'gemini_turn_complete' });
              }
            },
            onerror: (ev: ErrorEvent) => {
              if (cancelled) return;
              Sentry.captureException(new Error(ev?.message ?? 'gemini_ws_error'), {
                extra: { session_id: sessionIdRef.current },
              });
              dispatchRef({ kind: 'ws_closed', wasClean: false });
            },
            onclose: (ev: CloseEvent) => {
              if (cancelled) return;
              dispatchRef({ kind: 'ws_closed', wasClean: ev.wasClean });
            },
          },
        });
        geminiRef.current = session;
      } catch (e) {
        Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: 'gemini_open' } });
        dispatchRef({ kind: 'fatal_error', message: 'gemini_connect_failed' });
      }
    }

    void openAvatar();
    void openGemini();

    return () => {
      cancelled = true;
    };
    // Intentionally run once per mount — envelope is stable until rollover
    // which handles re-open internally via a dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== 'ready' && state.phase !== 'listening' && state.phase !== 'speaking') return;
    const t = window.setInterval(async () => {
      try {
        const r = await fetch('/api/sessions/heartbeat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });
        if (r.status === 410) {
          dispatchRef({ kind: 'fatal_error', message: 'session_dead' });
        }
      } catch { /* transient network — next tick retries */ }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(t);
  }, [state.phase]);

  // ── Visibility handling (pause/resume + iOS AudioContext recovery) ─────────
  useEffect(() => {
    function onVisibility() {
      if (document.hidden) {
        dispatchRef({ kind: 'visibility_hidden' });
        // Stop mic frame delivery but keep AudioContext + worklet alive to
        // avoid full re-initialization on resume.
        try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = false)); } catch {}
        fetch('/api/sessions/pause', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        }).catch(() => {});
      } else {
        dispatchRef({ kind: 'visibility_visible' });
        try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = true)); } catch {}
        fetch('/api/sessions/resume', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        }).catch(() => {});
        // iOS WebKit: AudioContext stays suspended unless we resume() AND
        // verify state === 'running' 300ms later. visibilitychange is not
        // a user gesture — if verification fails, prompt for one (R3-M4).
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
          window.setTimeout(() => {
            if (audioCtxRef.current && audioCtxRef.current.state !== 'running') {
              dispatchRef({ kind: 'audio_context_failed' });
            }
          }, AUDIO_CONTEXT_RESUME_VERIFY_MS);
        }
        // PC/WS health check — if either is dead, show reconnect.
        // Gemini SDK does not expose PC; we rely on 'closed' callbacks already
        // firing ws_closed. Same for avatar's RTC: SimliBridge surfaces via
        // onError → fatal_error.
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ── Rollover timer (15-min Gemini cap) ─────────────────────────────────────
  useEffect(() => {
    if (!state.openedAtMs || state.phase === 'closed' || state.phase === 'closing') return;
    const elapsed = Date.now() - state.openedAtMs;
    const remainingMs = Math.max(0, state.maxSessionSeconds * 1000 - elapsed);
    const t = window.setTimeout(() => {
      if (closedRef.current || rollingOverRef.current) return;
      rollingOverRef.current = true;
      dispatchRef({ kind: 'rollover_requested' });
      (async () => {
        try {
          // Tear down old pipes first — new tokens from the rollover envelope
          // will re-open fresh.
          try { geminiRef.current?.close(); } catch {}
          geminiRef.current = null;
          try { bridgeRef.current?.close(); } catch {}
          bridgeRef.current = null;
          const r = await fetch('/api/sessions/rollover', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              old_session_id: sessionIdRef.current,
              creator_id: args.creatorId,
              hook_id: args.hookId,
              model: modelRef.current,
            }),
          });
          if (!r.ok) {
            dispatchRef({ kind: 'rollover_failed', message: `rollover_${r.status}` });
            return;
          }
          const env = (await r.json()) as OpenEnvelope;
          // Swap in new tokens + session id on the refs.
          ephemeralTokenRef.current = env.gemini.token;
          modelRef.current = env.gemini.model;
          sessionIdRef.current = env.session_id;
          preMintedSimliRef.current = env.avatar?.session_token ?? null;
          dispatchRef({
            kind: 'rollover_complete',
            newSessionId: env.session_id,
            tier: env.tier,
            avatarStatus: env.avatar_status,
            maxSessionSeconds: env.max_session_s,
          });
          // Re-open both pipes with the new tokens. Inline here so the
          // rollingOverRef gate applies.
          await reopenAfterRollover(env);
        } catch (e) {
          Sentry.captureException(e, { extra: { op: 'rollover', session_id: sessionIdRef.current } });
          dispatchRef({ kind: 'rollover_failed', message: 'rollover_network' });
        } finally {
          rollingOverRef.current = false;
        }
      })();
    }, remainingMs);
    return () => window.clearTimeout(t);
  }, [state.openedAtMs, state.maxSessionSeconds, state.phase, args.creatorId, args.hookId]);

  async function reopenAfterRollover(env: OpenEnvelope): Promise<void> {
    // Simli re-open
    if (env.avatar && env.avatar_status === 'minted') {
      const bridge = createSimliBridge({
        onReady: () => dispatchRef({ kind: 'avatar_ready' }),
        onError: (err) => {
          Sentry.captureException(new Error(`avatar_${err.code}`), {
            extra: { session_id: sessionIdRef.current, op: 'rollover_reopen' },
          });
          dispatchRef({ kind: 'fatal_error', message: `avatar: ${err.code}` });
        },
        onLipsyncLatency: (ms) => { lipsyncLatencyRef.current = ms; },
      });
      bridgeRef.current = bridge;
      try {
        await bridge.open({
          replicaId: env.avatar.face_id,
          preMintedSessionToken: env.avatar.session_token,
          videoEl: videoRef.current ?? undefined,
          audioEl: audioRef.current ?? undefined,
        });
      } catch { /* handled in onError */ }
    } else {
      dispatchRef({ kind: 'avatar_not_expected' });
    }
    // Gemini re-open
    try {
      const client = new GoogleGenAI({
        apiKey: env.gemini.token,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      const session = await client.live.connect({
        model: env.gemini.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction:
            args.systemInstruction ??
            'You are a helpful mentor. Answer in concise spoken English.',
          realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
        },
        callbacks: {
          onopen: () => { /* wait for setupComplete */ },
          onmessage: (m: LiveServerMessage) => {
            if (m.setupComplete) { dispatchRef({ kind: 'gemini_setup_complete' }); return; }
            if (m.serverContent?.interrupted) {
              dispatchRef({ kind: 'gemini_interrupted' });
              try { bridgeRef.current?.cancel(); } catch {}
            }
            const parts = m.serverContent?.modelTurn?.parts ?? [];
            let got = false;
            for (const p of parts) {
              if (p.inlineData?.mimeType?.startsWith('audio/pcm') && p.inlineData.data) {
                got = true;
                const bytes = base64ToBytes(p.inlineData.data);
                try { bridgeRef.current?.sendAudio(bytes.buffer as ArrayBuffer); } catch {}
              }
            }
            if (got) dispatchRef({ kind: 'gemini_audio_chunk' });
            if (m.serverContent?.turnComplete) dispatchRef({ kind: 'gemini_turn_complete' });
          },
          onerror: () => dispatchRef({ kind: 'ws_closed', wasClean: false }),
          onclose: (ev: CloseEvent) => dispatchRef({ kind: 'ws_closed', wasClean: ev.wasClean }),
        },
      });
      geminiRef.current = session;
    } catch (e) {
      Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: 'rollover_reopen_gemini' } });
      dispatchRef({ kind: 'fatal_error', message: 'gemini_reopen_failed' });
    }
  }

  // ── Mic ────────────────────────────────────────────────────────────────────
  const startMic = useCallback((): void => {
    if (state.phase !== 'ready' && state.phase !== 'speaking') return;
    dispatchRef({ kind: 'mic_started' });
    (async () => {
      try {
        if (!audioCtxRef.current) {
          const Ctx: typeof AudioContext =
            (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
              .AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          audioCtxRef.current = new Ctx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') await ctx.resume();
        if (!micStreamRef.current) {
          micStreamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            video: false,
          });
        }
        if (!workletNodeRef.current) {
          await ctx.audioWorklet.addModule('/worklets/mic-processor.js');
          const src = ctx.createMediaStreamSource(micStreamRef.current);
          const node = new AudioWorkletNode(ctx, 'mic-processor');
          node.port.onmessage = (ev) => {
            const pcm = ev.data?.pcm as ArrayBuffer | undefined;
            if (!pcm || !geminiRef.current) return;
            try {
              geminiRef.current.sendRealtimeInput({
                audio: {
                  data: bytesToBase64(new Uint8Array(pcm)),
                  mimeType: 'audio/pcm;rate=16000',
                },
              });
            } catch { /* WS closed mid-frame — next visibility tick will reconcile */ }
          };
          src.connect(node);
          // Do NOT connect node to ctx.destination — would loop mic back.
          workletNodeRef.current = node;
        }
        micStreamRef.current.getTracks().forEach((t) => (t.enabled = true));
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'start_mic', session_id: sessionIdRef.current } });
        dispatchRef({ kind: 'fatal_error', message: 'mic_failed' });
      }
    })();
  }, [state.phase]);

  const stopMic = useCallback((): void => {
    if (state.phase !== 'listening') return;
    dispatchRef({ kind: 'mic_stopped' });
    try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = false)); } catch {}
  }, [state.phase]);

  // ── End session ────────────────────────────────────────────────────────────
  const endSession = useCallback(async (reason: 'user_ended' | 'client_error') => {
    if (closedRef.current) return;
    closedRef.current = true;
    dispatch({ kind: 'user_close' });
    try { workletNodeRef.current?.port.postMessage({ type: 'stop' }); } catch {}
    try { workletNodeRef.current?.disconnect(); } catch {}
    workletNodeRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micStreamRef.current = null;
    try { await audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    try { geminiRef.current?.close(); } catch {}
    geminiRef.current = null;
    try { bridgeRef.current?.close(); } catch {}
    bridgeRef.current = null;
    try {
      await fetch('/api/sessions/close', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionIdRef.current, end_reason: reason }),
      });
    } catch { /* best-effort — reaper catches orphans */ }
    captureSafe('session_close', { end_reason: reason, session_id: sessionIdRef.current });
    dispatch({ kind: 'closed_ack' });
  }, []);

  // ── Retry after user gesture (for iOS AudioContext) ────────────────────────
  const retryAfterGesture = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }
    // If WS is dead, user must tap to start a new session — we don't silently
    // re-open here (avoids phantom double-sessions on flaky networks).
    // Closing the page and re-opening from the hook invokes the reducer's
    // close path cleanly.
  }, []);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      if (!closedRef.current) {
        closedRef.current = true;
        try { workletNodeRef.current?.port.postMessage({ type: 'stop' }); } catch {}
        try { workletNodeRef.current?.disconnect(); } catch {}
        try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
        try { audioCtxRef.current?.close(); } catch {}
        try { geminiRef.current?.close(); } catch {}
        try { bridgeRef.current?.close(); } catch {}
        // Best-effort close so we don't orphan the row. beacon-style because
        // the effect cleanup may run during pagehide.
        if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
          try {
            const blob = new Blob(
              [JSON.stringify({ session_id: sessionIdRef.current, end_reason: 'user_ended' })],
              { type: 'application/json' },
            );
            navigator.sendBeacon('/api/sessions/close', blob);
          } catch {}
        }
      }
    };
  }, []);

  return {
    state,
    videoRef,
    audioRef,
    startMic,
    stopMic,
    endSession,
    retryAfterGesture,
    lipsyncLatencyMs: lipsyncLatencyRef.current,
  };
}
