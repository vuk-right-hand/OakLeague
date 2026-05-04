// Single source of truth for the voice-clone upload MIME allowlist.
// Mirrors the CHECK constraint in
// supabase/migrations/20260427000003_voice_clone_uploads.sql:15-17.
// A vitest case (voice-clone-mimes.test.ts) reads the migration text and
// asserts both sides agree (R4-S10 / R3-S5).

export const VOICE_CLONE_MIME_ALLOWLIST = [
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'audio/x-m4a',
  'audio/mp4',
] as const;

export type VoiceCloneMime = (typeof VOICE_CLONE_MIME_ALLOWLIST)[number];

export function isVoiceCloneMime(s: string): s is VoiceCloneMime {
  return (VOICE_CLONE_MIME_ALLOWLIST as readonly string[]).includes(s);
}
