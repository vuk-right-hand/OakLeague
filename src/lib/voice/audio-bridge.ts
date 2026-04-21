// AudioBridge — provider-agnostic voice session interface.
//
// Spike A implementation: GeminiBridge in server/voice-proxy/gemini-bridge.ts
// wraps @google/genai live.connect. Day 5+ swap target: LiveKit-wrapped
// version with same lifecycle. Keep this file provider-agnostic.
//
// Lifecycle (enforced by proxy state machine):
//   open → turnStart → audio in/out → turnEnd → (repeat) → close
//
// `cancel` is an interrupt during a live turn (barge-in path).

export type VoiceModelId =
  | 'gemini-2.5-flash-native-audio-preview-12-2025'
  | 'gemini-3.1-flash-live-preview';

export type OpenBridgeOptions = {
  model: VoiceModelId;
  /** Opaque identifier stamped into Sentry spans + COGS metadata. */
  sessionId: string;
  /** Free-form system prompt / persona seed. */
  systemInstruction?: string;
};

export type AudioChunk = {
  /** Raw LE mono PCM16 bytes. 16kHz inbound (mic), variable outbound. */
  bytes: Uint8Array;
  mimeType: string;
};

export type BridgeEvent =
  | { kind: 'setup_complete'; at: number }
  | { kind: 'audio_out'; at: number; chunk: AudioChunk }
  | { kind: 'turn_complete'; at: number }
  | { kind: 'interrupted'; at: number }
  | { kind: 'error'; at: number; message: string; fatal: boolean }
  | { kind: 'closed'; at: number; code?: number; reason?: string };

export type TurnEndMetrics = {
  /** Seconds of mic audio streamed inbound this turn. */
  inputSeconds: number;
  /** Seconds of synthesized audio streamed outbound this turn. */
  outputSeconds: number;
};

export interface AudioBridge {
  open(opts: OpenBridgeOptions): Promise<void>;

  /** Marks the start of a user turn. Manual-VAD mode (Spike A default). */
  turnStart(): void;

  /** Streams one inbound mic frame. 40ms PCM16 16kHz LE mono expected. */
  sendAudio(chunk: AudioChunk): void;

  /** Marks the end of a user turn and awaits the full model response. */
  turnEnd(): Promise<TurnEndMetrics>;

  /** Barge-in: cancel an in-flight model response. Safe mid-turn. */
  cancel(): void;

  /** Subscribe to bridge events. Returns unsubscribe. */
  on(listener: (e: BridgeEvent) => void): () => void;

  close(): Promise<void>;
}
