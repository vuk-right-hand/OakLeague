'use server';

// HUME_TTS_PLAN §12.5 / §6.11 — admin server actions for creator TTS dials.
//
// Each action follows the project standard:
//   1. assertAdminFromSession (auth guard, throws on non-admin).
//   2. Active-session guard + write happen INSIDE one SECURITY DEFINER RPC
//      with `SELECT ... FOR UPDATE` on the creators row (audit M3 fix).
//      The prior COUNT-then-UPDATE pattern had a network-RTT race window;
//      the RPC collapses it into a single round-trip with proper locking.
//   3. revalidatePath so the page re-renders with the new value.
//
// Hume Octave 2 prosody params:
//   * tts_speed         numeric [0.5, 2.0], NULL = use Hume default
//   * trailing_silence  numeric [0, 5], NULL = use Hume default 0.3
//   * voice_description text ≤1000 chars, NULL = no acting hint (inert today;
//                       refused at app layer per audit small to avoid keystrokes
//                       on an inert field)
//   * model_version     text '1' | '2' | 'default', NULL = '2'
//
// Env scoping mirrors the voice_id columns (production / preview / dev). The
// admin UI surfaces an env selector for non-production deploys (audit M4 fix).

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

type ActionResult = { ok: true } | { ok: false; error: string };

const EnvSchema = z.enum(['production', 'preview', 'development']);

// Audit S15 (unit-wide) — 23505 (unique_violation) is mapped per-RPC
// because the same Postgres code surfaces for DIFFERENT constraints.
// Today only `creator_set_hume_voice` has a relevant 23505 path (the
// `creators_hume_voice_name_unique` partial index from migration 0008).
// Other RPCs that get a 23505 surface as a generic `update_failed` —
// the operator gets nondescript text but at least the audit trail is
// accurate.
function mapRpcError(err: unknown, opts?: { source?: 'hume_voice' | 'tts_provider' | 'prosody' }): ActionResult {
  const code = (err as { code?: string }).code;
  const msg = (err as { message?: string }).message ?? '';
  if (code === '55006') return { ok: false, error: 'creator_has_active_sessions' };
  if (code === '23503') return { ok: false, error: 'creator_not_found' };
  if (code === '23505') {
    if (opts?.source === 'hume_voice' || /creators_hume_voice_name/.test(msg)) {
      return { ok: false, error: 'hume_voice_name_in_use' };
    }
    return { ok: false, error: 'unique_constraint_violation' };
  }
  if (code === '22023') return { ok: false, error: 'invalid_input' };
  if (code === '42501') return { ok: false, error: 'forbidden' };
  return { ok: false, error: 'update_failed' };
}

// Auditor Small (assertAdmin discriminator) — distinguish AuthGuardError from
// unexpected throws so Sentry attribution stays accurate.
async function requireAdmin(): Promise<ActionResult | null> {
  try {
    await assertAdminFromSession();
    return null;
  } catch (e) {
    if (!(e instanceof AuthGuardError)) {
      Sentry.captureException(e, { extra: { op: 'admin_action_unexpected_throw' } });
    }
    return { ok: false, error: 'forbidden' };
  }
}

// ── setCreatorTtsProvider ─────────────────────────────────────────────────

// FISH_AUDIO_PHASE_1 §6 — 'fish' joins the Zod enum so the admin dropdown's
// fish option flows through to the creator_set_tts_provider RPC. The RPC
// accepts the wider enum because migration 20260608100001 widened
// public.tts_provider.
const TtsProviderInput = z.object({
  creatorId: z.string().uuid(),
  value: z.enum(['inherit', 'cartesia', 'hume', 'fish']),
});

export async function setCreatorTtsProvider(input: unknown): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (auth) return auth;

  const parsed = TtsProviderInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const newValue = parsed.data.value === 'inherit' ? null : parsed.data.value;
  const sb = supabaseAdmin();
  const { error } = await sb.rpc('creator_set_tts_provider', {
    p_creator_id: parsed.data.creatorId,
    p_value:      newValue,
  });
  if (error) return mapRpcError(error, { source: 'tts_provider' });

  revalidatePath(`/admin/creators/${parsed.data.creatorId}`);
  return { ok: true };
}

// ── setCreatorHumeVoice ───────────────────────────────────────────────────

const HumeVoiceInput = z.object({
  creatorId: z.string().uuid(),
  env: EnvSchema,
  id:   z.string().min(1).max(128).nullable(),
  name: z.string().min(1).max(128).nullable(),
});

export async function setCreatorHumeVoice(input: unknown): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (auth) return auth;

  const parsed = HumeVoiceInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const { creatorId, env, id, name } = parsed.data;

  // M6: app-layer paired validation. Either both null (clear) or both set.
  // The DB RPC re-asserts as a defense-in-depth.
  if ((id == null) !== (name == null)) return { ok: false, error: 'paired_required' };

  const sb = supabaseAdmin();
  const { error } = await sb.rpc('creator_set_hume_voice', {
    p_creator_id: creatorId,
    p_env:        env,
    p_voice_id:   id,
    p_voice_name: name,
  });
  if (error) return mapRpcError(error, { source: 'hume_voice' });

  revalidatePath(`/admin/creators/${creatorId}`);
  return { ok: true };
}

// ── setCreatorHumeProsody ─────────────────────────────────────────────────
//
// Each prosody field is `undefined` = "leave unchanged" vs `null` = "clear".
// The RPC takes a `p_set_*` flag per field to distinguish.
//
// voice_description is INERT on Hume Octave 2 today but IS persisted
// forward-compat (see the detailed rationale at the non-rejection comment
// inside setCreatorHumeProsody below). Audit S7 — an earlier build had a
// typed 'hume_description_inert' action-layer rejection here; it was
// removed (it silently destroyed admin drafts). Do NOT reintroduce it.

const HumeProsodyInput = z.object({
  creatorId: z.string().uuid(),
  env: EnvSchema,
  ttsSpeed:         z.number().min(0.5).max(2.0).nullable().optional(),
  trailingSilence:  z.number().min(0).max(5).nullable().optional(),
  voiceDescription: z.string().min(1).max(1000).nullable().optional(),
  modelVersion:     z.enum(['1', '2', 'default']).nullable().optional(),
});

export async function setCreatorHumeProsody(input: unknown): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (auth) return auth;

  const parsed = HumeProsodyInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const { creatorId, env, ttsSpeed, trailingSilence, voiceDescription, modelVersion } = parsed.data;

  // voiceDescription is INERT on Hume Octave 2 today (acting-instructions
  // "coming soon" per Hume docs) but is persisted forward-compat — admin
  // can draft it now; emission is gated at the bridge by
  // shouldSendDescription() until Hume ships support. There is deliberately
  // NO action-layer rejection of a non-null description (audit S7 — an
  // earlier build rejected it and silently destroyed typed drafts; that
  // rejection no longer exists and must not be reintroduced).

  const sb = supabaseAdmin();
  const { error } = await sb.rpc('creator_set_hume_prosody', {
    p_creator_id:        creatorId,
    p_env:               env,
    p_tts_speed:         ttsSpeed         ?? null,
    p_set_speed:         ttsSpeed         !== undefined,
    p_trailing_silence:  trailingSilence  ?? null,
    p_set_silence:       trailingSilence  !== undefined,
    p_voice_description: voiceDescription ?? null,
    p_set_description:   voiceDescription !== undefined,
    p_model_version:     modelVersion     ?? null,
    p_set_model:         modelVersion     !== undefined,
  });
  if (error) return mapRpcError(error, { source: 'prosody' });

  revalidatePath(`/admin/creators/${creatorId}`);
  return { ok: true };
}
