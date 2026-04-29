import { redirect } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readAnonId } from '@/lib/feed/anon-id';
import { FeedContainer } from './(feed)/feed-container';
import type { FeedItem, WelcomeHook } from './(feed)/feed-types';
import { feedHookSchema, welcomeHookSchema } from '@/types/feed';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

const feedPageResultSchema = z.array(feedHookSchema);

export default async function RootPage() {
  if (process.env.NEXT_PUBLIC_FEED_ENABLED !== '1') {
    redirect('/waitlist');
  }

  // M4 TODO: the RSC path bypasses /api/feed's per-IP rate limiter. Low
  // concern at v1 scale (Vercel platform limits + Supabase connection pool
  // act as backstops), but add a route-layer throttle before opening the
  // feed to search-engine / bot traffic.
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Welcome hook is independent of auth state — same probe either way.
  const welcomeRowsPromise = supabase
    .from('welcome_hooks_public')
    .select('*')
    .limit(1);

  let initialItems: FeedItem[] = [];
  let initialCursorEpoch: number | null = null;

  if (user) {
    const { data } = await supabase.rpc('feed_ranked_page', {
      p_limit: PAGE_SIZE,
      p_cursor_epoch: null,
      p_exclude_hook_ids: [],
    });
    initialItems = safeParseFeedRows(data, 'feed_ranked_page');
    if (initialItems.length > 0) {
      initialCursorEpoch = initialItems[0].cursor_epoch;
    }
  } else {
    // SSR-only anon read: we intentionally do NOT mint a cookie here (cookie
    // writes are forbidden in Server Components in App Router). Passing a
    // null anon_id is explicitly handled by the RPC — it falls back to
    // quality-ordered without affinity. The first client /api/feed call
    // will mint the cookie.
    const anonId = await readAnonId();
    const admin = supabaseAdmin();
    const { data } = await admin.rpc('feed_ranked_anon_page', {
      p_anon_id: anonId,
      p_limit: PAGE_SIZE,
      p_cursor_epoch: null,
      p_exclude_hook_ids: [],
    });
    initialItems = safeParseFeedRows(data, 'feed_ranked_anon_page');
    if (initialItems.length > 0) {
      initialCursorEpoch = initialItems[0].cursor_epoch;
    }
  }

  const { data: welcomeRows } = await welcomeRowsPromise;
  const welcome: WelcomeHook | null = parseWelcome(welcomeRows);

  const hasMore = initialItems.length === PAGE_SIZE;

  return (
    <FeedContainer
      initialItems={initialItems}
      initialCursorEpoch={initialCursorEpoch}
      initialHasMore={hasMore}
      welcome={welcome}
      isAuthenticated={!!user}
    />
  );
}

// S2 parity at the RSC boundary: a silent RPC column rename renders empty
// feed + a log line, rather than crashing the page with an undefined field.
// N2+N3 parity: page Sentry on shape mismatch so an at-launch schema drift
// doesn't silently render zero hooks to every visitor.
function safeParseFeedRows(data: unknown, label: string): FeedItem[] {
  const parsed = feedPageResultSchema.safeParse(data ?? []);
  if (!parsed.success) {
    Sentry.captureMessage('feed_schema_mismatch', {
      level: 'error',
      extra: { label, issues: parsed.error.issues },
    });
    console.error(`[page] ${label} payload shape mismatch`, parsed.error.issues);
    return [];
  }
  return parsed.data;
}

// N2: Zod-validate welcome_hooks_public at the RSC boundary. A view schema
// drift (e.g. a column renamed upstream) returns null welcome instead of
// shipping an undefined field into WelcomeOverlay.
function parseWelcome(rows: unknown): WelcomeHook | null {
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first) return null;
  const parsed = welcomeHookSchema.safeParse(first);
  if (!parsed.success) {
    Sentry.captureMessage('welcome_schema_mismatch', {
      level: 'error',
      extra: { issues: parsed.error.issues },
    });
    console.error('[page] welcome_hooks_public shape mismatch', parsed.error.issues);
    return null;
  }
  return parsed.data;
}
