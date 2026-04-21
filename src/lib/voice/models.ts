// Spike A voice model registry.
//
// Pinned version strings — Phase 0 verification 2026-04-21 confirmed both
// models are reachable on v1alpha via @google/genai SDK. `-latest` and bare
// `-preview` are banned per CLAUDE.md Hard Rules / Voice.
//
// Gate cleared 2026-04-21: 3.1 is primary, 2.5 retained as env-swap fallback.
// Both entries stay in ALLOWED_MODELS so `VOICE_MODEL_PRIMARY=<2.5 id>` redeploy
// is a 2-minute recovery if Google deprecates 3.1 preview. Do not delete either.

export type VoiceModelId =
  | 'gemini-2.5-flash-native-audio-preview-12-2025'
  | 'gemini-3.1-flash-live-preview';

export type VoiceModelEntry = {
  id: VoiceModelId;
  /** apiVersion passed to GoogleGenAI httpOptions. Phase 0: both on v1alpha. */
  apiVersion: 'v1alpha';
  /** Pricing per million tokens (2.5 native-audio 2026-04-21 rate card). */
  inputUsdPerMTokens: number;
  outputUsdPerMTokens: number;
};

export const ALLOWED_MODELS: Record<VoiceModelId, VoiceModelEntry> = {
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    id: 'gemini-2.5-flash-native-audio-preview-12-2025',
    apiVersion: 'v1alpha',
    inputUsdPerMTokens: 3,
    outputUsdPerMTokens: 12,
  },
  'gemini-3.1-flash-live-preview': {
    id: 'gemini-3.1-flash-live-preview',
    apiVersion: 'v1alpha',
    inputUsdPerMTokens: 3,
    outputUsdPerMTokens: 12,
  },
};

export function resolveModel(envValue: string | undefined): VoiceModelEntry {
  if (!envValue) throw new Error('voice model env var is empty');
  const entry = ALLOWED_MODELS[envValue as VoiceModelId];
  if (!entry) throw new Error(`voice model not in ALLOWED_MODELS: ${envValue}`);
  return entry;
}

/** Spike A env vars — see plan Decision 8 + .env.example. */
export function getPrimaryModel(): VoiceModelEntry {
  return resolveModel(process.env.VOICE_MODEL_PRIMARY);
}
export function getSecondaryModel(): VoiceModelEntry {
  return resolveModel(process.env.VOICE_MODEL_SECONDARY);
}
