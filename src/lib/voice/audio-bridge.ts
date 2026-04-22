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
  /**
   * Pipeline α': request Gemini 3.1 Flash Live to emit
   * serverContent.outputTranscription.text chunks alongside AUDIO output.
   * Bridge implementations forward them as `output_transcription_chunk`
   * events and the proxy feeds the text into Cartesia TTS.
   * Default: false (plain audio-out, Spike-A compatible).
   */
  enableOutputTranscription?: boolean;
  /**
   * Optional: enable Gemini's inputAudioTranscription. Emitted as
   * `input_transcription_chunk` events. Useful for persisted session
   * transcripts; not required for α' voice playback.
   */
  enableInputTranscription?: boolean;
};

export type AudioChunk = {
  /** Raw LE mono PCM16 bytes. 16kHz inbound (mic), variable outbound. */
  bytes: Uint8Array;
  mimeType: string;
};

export type BridgeEvent =
  | { kind: 'setup_complete'; at: number }
  | { kind: 'audio_out'; at: number; chunk: AudioChunk }
  // Pipeline α': streaming transcript of the model's own audio output.
  // Emitted only when the bridge is opened with `enableOutputTranscription`.
  // Proxy pipes `text` into Cartesia TTS; the audio_out bytes are discarded.
  | { kind: 'output_transcription_chunk'; at: number; text: string }
  // User-speech transcript emitted alongside the server's inputTranscription
  // events (populated in production when Gemini is configured with
  // inputAudioTranscription:{}). Useful for session transcripts + moderation.
  | { kind: 'input_transcription_chunk'; at: number; text: string }
  | { kind: 'turn_complete'; at: number }
  | { kind: 'interrupted'; at: number }
  | { kind: 'error'; at: number; message: string; fatal: boolean }
  | { kind: 'closed'; at: number; code?: number; reason?: string };

export type TurnEndMetrics = {
  /** Seconds of mic audio streamed inbound this turn. */
  inputSeconds: number;
  /** Seconds of synthesized audio streamed outbound this turn (Gemini's,
   *  discarded in Pipeline α'). Kept on the metrics shape so the cogs RPC's
   *  leg 2 (audio-out tokens) can be correlated with wall-clock seconds in
   *  the admin dashboard. */
  outputSeconds: number;
  /** Concatenated outputTranscription text accumulated across the turn.
   *  Pipeline α' uses this as the authoritative text for Cartesia billing
   *  (leg 3 = characters). Empty string when bridge was opened without
   *  `enableOutputTranscription`. */
  outputTranscript?: string;
};

/**
 * One prior-turn summary consumed by `seedContents` on resume. Role 'model'
 * maps to Gemini's assistant slot; 'user' to the user slot.
 */
export type ReplayTurn = { role: 'user' | 'model'; text: string };

export interface AudioBridge {
  open(opts: OpenBridgeOptions): Promise<void>;

  /**
   * Seed prior-conversation history once, post-open, pre-turnStart. Awaited.
   * Implementations MUST resolve when the seed ack (or a 2s safety timeout)
   * lands; `turnComplete:false` so no response is triggered by the seed.
   *
   * Call order (locked): open → await seedContents? → turnStart.
   *
   * Future STT-only bridges SHOULD implement as a no-op — history lives in
   * whichever downstream bridge owns the reasoning turn.
   */
  seedContents?(turns: ReplayTurn[]): Promise<void>;

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
