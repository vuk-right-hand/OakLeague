// SIMLI_WIREUP §12a.1 / R3-Missing-1 / R4-M6 — env-scoped voice-id helpers.
//
// `creators` carries env-scoped voice-id columns for THREE providers:
//   Cartesia:  voice_id           voice_id_preview           voice_id_dev
//   Hume:      hume_voice_id      hume_voice_id_preview      hume_voice_id_dev
//   Hume name: hume_voice_name    hume_voice_name_preview    hume_voice_name_dev
//   Fish:      fish_voice_id      fish_voice_id_preview      fish_voice_id_dev
//
// VERCEL_ENV is the right gate (NOT NODE_ENV), because Vercel preview deploys
// run with NODE_ENV=production. Reading by NODE_ENV would let a preview-branch
// clone overwrite the production voice id.
//
// HUME_TTS_PLAN §6.2 (2026-05-13): every resolver now takes a `provider`
// argument so /api/sessions/open and /api/sessions/rollover can drive the same
// helper for ANY of the supported providers without branching at every call
// site. FISH_AUDIO_PHASE_1 §6 (2026-06-08) extended the union to include 'fish'.
// Fish DELETE is keyed by id only → no companion name column (Hume's
// hume_voice_name parity is provider-specific).
//
// Server-only — no client-side resolution. The browser never knows which
// column was read.

import 'server-only';

export type VoiceIdEnv = 'production' | 'preview' | 'development';
export type TtsProvider = 'cartesia' | 'hume' | 'fish';

export function currentVoiceIdEnv(): VoiceIdEnv {
  const v = process.env.VERCEL_ENV;
  if (v === 'production') return 'production';
  if (v === 'preview') return 'preview';
  return 'development';
}

// Cartesia voice-id column for the given env.
type CartesiaVoiceCol = 'voice_id' | 'voice_id_preview' | 'voice_id_dev';
// Hume voice-id column for the given env.
type HumeVoiceCol = 'hume_voice_id' | 'hume_voice_id_preview' | 'hume_voice_id_dev';
type HumeNameCol  = 'hume_voice_name' | 'hume_voice_name_preview' | 'hume_voice_name_dev';
// FISH_AUDIO_PHASE_1 §6 — Fish voice-id column for the given env. No
// companion name column (Fish DELETE keyed by id).
type FishVoiceCol = 'fish_voice_id' | 'fish_voice_id_preview' | 'fish_voice_id_dev';

export function voiceIdColumn(
  env: VoiceIdEnv = currentVoiceIdEnv(),
  provider: TtsProvider = 'cartesia',
): CartesiaVoiceCol | HumeVoiceCol | FishVoiceCol {
  if (provider === 'hume') {
    if (env === 'production') return 'hume_voice_id';
    if (env === 'preview')    return 'hume_voice_id_preview';
    return 'hume_voice_id_dev';
  }
  if (provider === 'fish') {
    if (env === 'production') return 'fish_voice_id';
    if (env === 'preview')    return 'fish_voice_id_preview';
    return 'fish_voice_id_dev';
  }
  if (env === 'production') return 'voice_id';
  if (env === 'preview')    return 'voice_id_preview';
  return 'voice_id_dev';
}

export function humeVoiceNameColumn(env: VoiceIdEnv = currentVoiceIdEnv()): HumeNameCol {
  if (env === 'production') return 'hume_voice_name';
  if (env === 'preview')    return 'hume_voice_name_preview';
  return 'hume_voice_name_dev';
}

// Shape a fully-loaded creator row carries for the resolvers below. All fields
// nullable — callers may select only the columns they need; missing keys read
// as undefined and the resolvers coerce to null.
export type VoiceColumnsRow = {
  voice_id?: string | null;
  voice_id_preview?: string | null;
  voice_id_dev?: string | null;
  hume_voice_id?: string | null;
  hume_voice_id_preview?: string | null;
  hume_voice_id_dev?: string | null;
  hume_voice_name?: string | null;
  hume_voice_name_preview?: string | null;
  hume_voice_name_dev?: string | null;
  // FISH_AUDIO_PHASE_1 §6 — env-scoped Fish reference_id columns.
  fish_voice_id?: string | null;
  fish_voice_id_preview?: string | null;
  fish_voice_id_dev?: string | null;
};

export function resolveVoiceId(
  row: VoiceColumnsRow,
  env: VoiceIdEnv = currentVoiceIdEnv(),
  provider: TtsProvider = 'cartesia',
): string | null {
  if (provider === 'hume') {
    if (env === 'production') return row.hume_voice_id        ?? null;
    if (env === 'preview')    return row.hume_voice_id_preview ?? null;
    return row.hume_voice_id_dev ?? null;
  }
  if (provider === 'fish') {
    if (env === 'production') return row.fish_voice_id        ?? null;
    if (env === 'preview')    return row.fish_voice_id_preview ?? null;
    return row.fish_voice_id_dev ?? null;
  }
  if (env === 'production') return row.voice_id        ?? null;
  if (env === 'preview')    return row.voice_id_preview ?? null;
  return row.voice_id_dev ?? null;
}

export function resolveHumeVoiceName(
  row: VoiceColumnsRow,
  env: VoiceIdEnv = currentVoiceIdEnv(),
): string | null {
  if (env === 'production') return row.hume_voice_name        ?? null;
  if (env === 'preview')    return row.hume_voice_name_preview ?? null;
  return row.hume_voice_name_dev ?? null;
}

// Audit small fix — supabase-js returns numeric columns as JS string.
// The route-side coercion was duplicated in sessions/open and rollover.
// Lift it here so both routes share one well-tested helper.
export function coerceNumericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// HUME_TTS_PLAN §6.4 — generic env-scoped column picker. The four Hume
// prosody columns follow the same pattern (`<base>` | `<base>_preview` |
// `<base>_dev`); rather than four named resolvers, expose one helper that
// looks up the env-suffixed key on the row. Caller coerces (numeric arrives
// as string from supabase-js).
type HumeProsodyBase =
  | 'hume_tts_speed'
  | 'hume_trailing_silence'
  | 'hume_voice_description'
  | 'hume_model_version';

export function pickEnvScoped(
  row: Record<string, unknown>,
  baseColumn: HumeProsodyBase,
  env: VoiceIdEnv = currentVoiceIdEnv(),
): unknown {
  // Audit S12 (unit-wide) — runtime defense in case the SELECT call site
  // didn't include the column (e.g., a `select('id')` minimal query that
  // happens to pass through this helper via a future code path). Without
  // the check the function returns null silently, hiding the bug.
  const key = env === 'production' ? baseColumn
           : env === 'preview'    ? `${baseColumn}_preview`
           :                        `${baseColumn}_dev`;
  if (!Object.prototype.hasOwnProperty.call(row, key)) {
    // eslint-disable-next-line no-console
    console.warn(`[pickEnvScoped] row missing key '${key}' — caller should SELECT it. Returning null.`);
    return null;
  }
  return row[key] ?? null;
}
