// Browser client (anon key, localStorage). Per VibeCoders §1: never import on the server.
import { createBrowserClient } from '@supabase/ssr';

export function supabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
