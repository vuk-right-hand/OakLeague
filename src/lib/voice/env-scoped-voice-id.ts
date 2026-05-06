// SIMLI_WIREUP §12a.1 / R3-Missing-1 / R4-M6 — env-scoped voice_id helpers.
//
// creators table has THREE Cartesia voice-id columns:
//   * voice_id          — VERCEL_ENV=production
//   * voice_id_preview  — VERCEL_ENV=preview (per-branch deploys)
//   * voice_id_dev      — VERCEL_ENV unset OR =development (local)
//
// VERCEL_ENV is the right gate (NOT NODE_ENV), because Vercel preview
// deploys run with NODE_ENV=production. Reading by NODE_ENV would let a
// preview-branch voice-clone overwrite the prod creator's voice id.
//
// Server-only — no client-side resolution. The browser never knows which
// column was read.

import 'server-only';

export type VoiceIdEnv = 'production' | 'preview' | 'development';

export function currentVoiceIdEnv(): VoiceIdEnv {
  const v = process.env.VERCEL_ENV;
  if (v === 'production') return 'production';
  if (v === 'preview') return 'preview';
  return 'development';
}

export function voiceIdColumn(env: VoiceIdEnv = currentVoiceIdEnv()): 'voice_id' | 'voice_id_preview' | 'voice_id_dev' {
  if (env === 'production') return 'voice_id';
  if (env === 'preview')    return 'voice_id_preview';
  return 'voice_id_dev';
}

// Convenience: resolve the env-appropriate value from a row that has all
// three columns selected.
export function resolveVoiceId(
  row: { voice_id: string | null; voice_id_preview: string | null; voice_id_dev: string | null },
  env: VoiceIdEnv = currentVoiceIdEnv(),
): string | null {
  if (env === 'production') return row.voice_id;
  if (env === 'preview')    return row.voice_id_preview;
  return row.voice_id_dev;
}
