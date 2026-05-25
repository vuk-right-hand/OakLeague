'use server';

import { z } from 'zod';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { HANDLE_RE } from '@/lib/profile/handle';

// Handshake (follow) server actions (PROFILE_SYSTEM_PLAN U4). The DB RPCs are
// handle-based + rate-limited internally; we only pass the handle, never an id.

const HandleInput = z.object({
  handle: z.string().trim().toLowerCase().regex(HANDLE_RE),
});

export type HandshakeResult = { ok: true; handshaked: boolean } | { ok: false; error: string };

async function toggle(input: unknown, on: boolean): Promise<HandshakeResult> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };

  const parsed = HandleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_handle' };

  const supabase = await supabaseServer();
  const { error } = await supabase.rpc(on ? 'handshake' : 'unhandshake', {
    p_target_handle: parsed.data.handle,
  });

  if (error) {
    if (error.message?.includes('rate_limited')) return { ok: false, error: 'rate_limited' };
    if (error.message?.includes('bad_target')) return { ok: false, error: 'bad_target' };
    if (error.message?.includes('target_not_found')) return { ok: false, error: 'not_found' };
    return { ok: false, error: 'failed' };
  }

  // No revalidatePath: the profile page is force-dynamic, so the count refreshes
  // on the next load (audit M3 — a literal '/@handle' key wouldn't match the
  // [handle] route anyway).
  return { ok: true, handshaked: on };
}

export async function handshakeAction(input: unknown): Promise<HandshakeResult> {
  return toggle(input, true);
}

export async function unhandshakeAction(input: unknown): Promise<HandshakeResult> {
  return toggle(input, false);
}
