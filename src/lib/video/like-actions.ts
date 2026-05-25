'use server';

import { z } from 'zod';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

// Like (one action) server actions (COMMENTS_LIKES_PLAN L2). Handle-free —
// keyed on video id; the RPCs gate published + rate-limit internally.

const VideoInput = z.object({ video_id: z.string().uuid() });

export type LikeResult = { ok: true; liked: boolean } | { ok: false; error: string };

async function toggle(input: unknown, on: boolean): Promise<LikeResult> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };

  const parsed = VideoInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_video' };

  const supabase = await supabaseServer();
  const { error } = await supabase.rpc(on ? 'like_video' : 'unlike_video', {
    p_video_id: parsed.data.video_id,
  });

  if (error) {
    if (error.message?.includes('rate_limited')) return { ok: false, error: 'rate_limited' };
    if (error.message?.includes('video_not_available')) return { ok: false, error: 'unavailable' };
    return { ok: false, error: 'failed' };
  }
  return { ok: true, liked: on };
}

export async function likeAction(input: unknown): Promise<LikeResult> {
  return toggle(input, true);
}

export async function unlikeAction(input: unknown): Promise<LikeResult> {
  return toggle(input, false);
}
