'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { HANDLE_RE } from '@/lib/profile/handle';

// Profile edit + lazy handle claim (PROFILE_SYSTEM_PLAN U3).
//
// Audit M2 (creator brand vs user profile): a published creator's public face
// COALESCEs creators.* over profiles.*, so editing the user profile would be a
// silent no-op AND risks a second handle in the registry. This action therefore
// REFUSES brand edits for creators and points them at the studio. Non-creators
// edit display_name / bio / handle here; the handle uniqueness + reserved guard
// is enforced by the profiles_handle_sync triggers (this is defense-in-depth +
// UX, not the source of truth).

const Input = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  bio: z.string().trim().max(2000).optional(),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HANDLE_RE, 'bad_handle')
    .optional(),
});

export type SaveProfileResult = { ok: true } | { ok: false; error: string };

export async function saveProfile(input: unknown): Promise<SaveProfileResult> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };

  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid_input' };
  }

  const supabase = await supabaseServer();

  // M2: creators manage their public identity in the studio, not here.
  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  if (creator) return { ok: false, error: 'edit_in_studio' };

  // Whitelist — never spread the parsed object.
  const patch: Record<string, string> = {};
  if (parsed.data.display_name !== undefined) patch.display_name = parsed.data.display_name;
  if (parsed.data.bio !== undefined) patch.bio = parsed.data.bio;
  if (parsed.data.handle !== undefined) patch.handle = parsed.data.handle;

  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing_to_update' };

  // UX pre-check on handle availability (the unique index is the real guard).
  if (patch.handle !== undefined) {
    const { data: available } = await supabase.rpc('handle_available', { p_handle: patch.handle });
    if (available === false) return { ok: false, error: 'handle_taken' };
  }

  const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
  if (error) {
    // Bio scam-link guard trigger (non-creators) → friendly code.
    if (error.message?.includes('link_not_allowed')) return { ok: false, error: 'link_not_allowed' };
    // Unique violation / reserved-name from the handle triggers → friendly code.
    if (error.code === '23505' || error.code === '23514') return { ok: false, error: 'handle_taken' };
    return { ok: false, error: 'save_failed' };
  }

  revalidatePath('/');
  return { ok: true };
}
