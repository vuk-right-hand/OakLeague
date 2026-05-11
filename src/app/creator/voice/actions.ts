'use server';

import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

type Result = { ok: true } | { ok: false; error: string };

// Range mirrors DB CHECK (migration 20260511000006). Cartesia Sonic 3
// generation_config.speed bounds.
const updateSpeedSchema = z.object({
  speed: z.number().finite().min(0.6).max(1.5),
});

// R1 audit M3 / R2 audit M3 — server action posture:
//   * getCallerUserId via getCreatorForCaller (returns userId AND creatorId).
//   * Field whitelist: only tts_speed.
//   * UPDATE WHERE has BOTH id AND user_id — defense in depth even though
//     the caller's creatorId came from auth.
//   * revalidate /creator/voice AND /creator (mirror brain-actions pattern).
//   * Does NOT trigger recompileBrainAfterResponse — tts_speed has no
//     bearing on the persona (R2 audit M7).
export async function updateTtsSpeed(
  input: z.input<typeof updateSpeedSchema>,
): Promise<Result> {
  let creatorId: string;
  let userId: string;
  try {
    const ctx = await getCreatorForCaller();
    creatorId = ctx.creatorId;
    userId = ctx.userId;
  } catch (e) {
    if (e instanceof AuthGuardError) {
      return { ok: false, error: e.status === 401 ? 'sign_in_required' : 'forbidden' };
    }
    throw e;
  }

  const parsed = updateSpeedSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid_speed' };
  }
  const { speed } = parsed.data;

  const admin = supabaseAdmin();
  // WHERE id = creatorId AND user_id = userId — race-safe ownership
  // re-check (R2 audit M3). If creator's user_id was reassigned between
  // getCreatorForCaller and this UPDATE, the row count is 0 and we
  // return not_found rather than silently writing a foreign row.
  const { data, error } = await admin
    .from('creators')
    .update({ tts_speed: speed })
    .eq('id', creatorId)
    .eq('user_id', userId)
    .select('id');

  if (error) {
    // 23514 = DB CHECK violation. Should be unreachable given zod gate above.
    if (error.code === '23514') return { ok: false, error: 'speed_out_of_range' };
    Sentry.captureException(error, { extra: { op: 'update_tts_speed', creator_id: creatorId } });
    return { ok: false, error: 'update_failed' };
  }
  if (!data || data.length === 0) return { ok: false, error: 'not_found' };

  revalidatePath('/creator/voice');
  revalidatePath('/creator');
  return { ok: true };
}
