import 'server-only';
import { cache } from 'react';
import { assertCreatorFromSession } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { BrainStatus, CreatorRow } from './types';

// React.cache() dedupes ONLY within a single RSC render tree (layout + page
// of the same request). Server actions run in a separate request context and
// will re-query by design — that is intentional, not a leak.

export const getCreatorForCaller = cache(
  async (): Promise<{ userId: string; creatorId: string; creator: CreatorRow }> => {
    const { userId, creatorId } = await assertCreatorFromSession();

    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from('creators')
      .select('id, user_id, handle, display_name, bio, avatar_url, brain_status, published_at')
      .eq('id', creatorId)
      .maybeSingle();

    if (error || !data) {
      throw new Error('creator_fetch_failed');
    }

    const creator: CreatorRow = {
      id: data.id as string,
      user_id: data.user_id as string,
      handle: data.handle as string,
      display_name: data.display_name as string,
      bio: (data.bio ?? null) as string | null,
      avatar_url: (data.avatar_url ?? null) as string | null,
      brain_status: data.brain_status as BrainStatus,
      published_at: (data.published_at ?? null) as string | null,
    };

    return { userId, creatorId, creator };
  },
);
