// SSR cookie-bound client. Canonical "who is logged in" on the server.
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Database types aren't generated in v1 — treat all tables/RPCs as unknown.
type AnyDb = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient<AnyDb>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, applyHardening(options));
            }
          } catch {
            // Called from a Server Component — set from middleware instead.
          }
        },
      },
    },
  );
}

function applyHardening(opts: CookieOptions = {}): CookieOptions {
  return {
    ...opts,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}
