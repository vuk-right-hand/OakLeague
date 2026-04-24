// Anon-visitor identity for unauthenticated feed sessions. The cookie is
// minted on the first /api/feed call without an existing one, then carried
// across every subsequent request from that browser. On sign-in the
// auth callback hands the anon_id to merge_anon_feed_state() so the
// pre-signup affinity blob folds into the real user's rollups.
//
// Server-side only. Never read from middleware or client code — the cookie
// is httpOnly so JS can't see it anyway.
//
// S4 known gap: on a fresh visitor, SSR renders the feed with anon_id=null
// (Server Components can't write cookies in App Router). The first client
// /api/feed call mints the cookie. If two tabs open simultaneously, each
// mints its own anon_id and one loses the cookie race — the loser's
// affinity lands in an orphan anon_feed_sessions row. Cosmetic only;
// retention GC (D7) cleans orphans. Fix would need a middleware-level
// mint, not worth the complexity in v1.

import 'server-only';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const ANON_ID_COOKIE = 'oak_anon_id';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the anon_id cookie if present and well-formed; never falls through to a string that isn't a uuid. */
export async function readAnonId(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(ANON_ID_COOKIE)?.value;
  if (!raw || !UUID_RE.test(raw)) return null;
  return raw;
}

/**
 * Read the anon_id, or mint a fresh one (DB row + Set-Cookie) if missing.
 * Must be called from a Route Handler; cookie writes are not allowed from
 * Server Components in App Router.
 */
export async function readOrMintAnonId(): Promise<string> {
  const existing = await readAnonId();
  if (existing) return existing;

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('anon_feed_sessions')
    .insert({})
    .select('anon_id')
    .single<{ anon_id: string }>();

  if (error || !data) {
    throw new Error(`anon_session_mint_failed: ${error?.message ?? 'no row'}`);
  }

  const jar = await cookies();
  jar.set(ANON_ID_COOKIE, data.anon_id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });

  return data.anon_id;
}
