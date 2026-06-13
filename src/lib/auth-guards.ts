// Day-1 artifact. Every server action calls one of these FIRST. Never inline.
// VibeCoders §2, §20. OakLeague CLAUDE.md §Hard Rules / Auth & RLS.

import 'server-only';
import { cache } from 'react';
import { supabaseServer } from './supabase/server';
import { supabaseAdmin } from './supabase/admin';

export type AdminRole = 'superadmin' | 'reviewer';

/**
 * Resolves the caller's auth.users.id via the SSR cookie-bound client.
 * Returns null for unauthenticated requests — callers should short-circuit.
 */
export async function getCallerUserId(): Promise<string | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

export type AdminSession = {
  userId: string;
  email: string;
  role: AdminRole;
};

/**
 * Admin check: SSR cookie → auth.users.id → admin_roles lookup by user_id
 * with revoked_at IS NULL. Post-migration-0025: PK is user_id, not email.
 * Throws if not an active admin.
 */
export async function assertAdminFromSession(): Promise<AdminSession> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new AuthGuardError('Unauthorized', 401);
  }
  const userId = data.user.id;
  const email = data.user.email ?? '';

  const admin = supabaseAdmin();
  const { data: row, error: roleErr } = await admin
    .from('admin_roles')
    .select('role, revoked_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle<{ role: AdminRole; revoked_at: string | null }>();

  if (roleErr) throw new AuthGuardError('Admin lookup failed', 500);
  if (!row) throw new AuthGuardError('Forbidden', 403);

  return {
    userId,
    email,
    role: row.role,
  };
}

export type CreatorSession = {
  userId: string;
  creatorId: string;
};

/**
 * Creator check: SSR cookie → creators WHERE user_id = auth.uid().
 * Throws if the caller is not a creator.
 *
 * Audit S6: wrapped in react/cache so an RSC page + its layout (or a page that
 * also calls getCreatorForCaller) dedupe the cookie+creators round-trip within
 * one request. Outside a request scope (route handlers) cache() is a passthrough.
 */
export const assertCreatorFromSession = cache(async (): Promise<CreatorSession> => {
  const userId = await getCallerUserId();
  if (!userId) throw new AuthGuardError('Unauthorized', 401);

  const admin = supabaseAdmin();
  const { data: row, error } = await admin
    .from('creators')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>();

  if (error) throw new AuthGuardError('Creator lookup failed', 500);
  if (!row) throw new AuthGuardError('Forbidden', 403);

  return { userId, creatorId: row.id };
});

export class AuthGuardError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthGuardError';
    this.status = status;
  }
}
