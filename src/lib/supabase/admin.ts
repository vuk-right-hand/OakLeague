// Service-role client. Bypasses RLS. Every call site MUST call
// getCallerUserId() + ownership re-check first (VibeCoders §7).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Database types aren't generated in v1 — treat all tables/RPCs as unknown
// shape at the type level. Runtime safety lives at the RLS + RPC boundary.
type AnyDb = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let _admin: SupabaseClient<AnyDb> | null = null;

export function supabaseAdmin(): SupabaseClient<AnyDb> {
  if (_admin) return _admin;
  _admin = createClient<AnyDb>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return _admin;
}
