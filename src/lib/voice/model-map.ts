// Voice model enum ↔ wire-form bridge. Single source of truth for the TS side.
// Postgres side lives in `voice_model_wire_value(voice_model)` (migration 0034,
// amended by 20260502000001 to align 2.5 preview suffix).
// Parity enforced by tests/model-map-parity.spec.ts (R4-M3).
//
// - Enum values (underscored) are what the `voice_model` Postgres type stores.
// - Wire values (hyphenated) are what Google's Live API accepts on the client.
// `/api/sessions/open` translates wire → enum BEFORE calling session_open RPC,
// and wire-form is returned in the response envelope for the client.
//
// DON'T add aliases or normalize case. If Google ships a new preview string,
// add it as a new enum value and bump the migration — drift is how we pinned
// the wrong model in Spike A (see .claude_learnings.md 2026-04-21).

export const VOICE_MODEL_ENUMS = [
  'gemini_3_1_flash_live_preview',
  'gemini_live_2_5_flash_native_audio',
] as const;

export type VoiceModelEnum = (typeof VOICE_MODEL_ENUMS)[number];

export const ENUM_TO_WIRE: Record<VoiceModelEnum, string> = {
  gemini_3_1_flash_live_preview: 'gemini-3.1-flash-live-preview',
  gemini_live_2_5_flash_native_audio: 'gemini-2.5-flash-native-audio-preview-12-2025',
};

export const WIRE_TO_ENUM: Record<string, VoiceModelEnum> = Object.fromEntries(
  VOICE_MODEL_ENUMS.map((e) => [ENUM_TO_WIRE[e], e]),
) as Record<string, VoiceModelEnum>;

export function isAllowedWireModel(wire: string): boolean {
  return Object.prototype.hasOwnProperty.call(WIRE_TO_ENUM, wire);
}
