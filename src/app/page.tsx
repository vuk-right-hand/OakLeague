import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { FeedContainer } from './(feed)/feed-container';
import type { FeedCursor, FeedItem, WelcomeHook } from './(feed)/feed-types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

export default async function RootPage() {
  if (process.env.NEXT_PUBLIC_FEED_ENABLED !== '1') {
    redirect('/waitlist');
  }

  const supabase = await supabaseServer();

  // Probe with PAGE_SIZE + 1 so SSR can detect whether a next page exists
  // without issuing a throwaway loadMore() (audit M7).
  const [{ data: probe }, { data: welcomeRows }] = await Promise.all([
    supabase.rpc('feed_page', {
      p_cursor_created_at: null,
      p_cursor_id: null,
      p_limit: PAGE_SIZE + 1,
    }),
    supabase.from('welcome_hooks_public').select('*').limit(1),
  ]);

  const probeRows = (probe ?? []) as FeedItem[];
  const initialItems = probeRows.slice(0, PAGE_SIZE);
  const hasMore = probeRows.length > PAGE_SIZE;
  const cursorAnchor = initialItems[initialItems.length - 1];
  const initialCursor: FeedCursor | null =
    hasMore && cursorAnchor
      ? {
          cursor_created_at: cursorAnchor.hook_created_at,
          cursor_id: cursorAnchor.hook_id,
        }
      : null;

  const welcome: WelcomeHook | null =
    (welcomeRows as WelcomeHook[] | null)?.[0] ?? null;

  return (
    <FeedContainer
      initialItems={initialItems}
      initialCursor={initialCursor}
      initialHasMore={hasMore}
      welcome={welcome}
    />
  );
}
