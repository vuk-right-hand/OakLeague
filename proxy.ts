// Next 16 proxy (renamed from middleware). Runs edge-adjacent; refreshes the
// SSR session cookies and blocks unauthenticated access to protected paths.
// VibeCoders §5, §12.
//
// Matcher excludes:
//   - .json / .webmanifest / static assets (otherwise PWA manifest redirects
//     to /login for guests)
//   - /auth/* (matching eats the PKCE ?code= param → infinite loop)
//   - /api/* (server actions do their own auth)

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PROTECTED_PREFIXES = ['/onboarding', '/apply', '/admin'];
const PROTECTED_INVITE_CLAIM = /^\/invite\/[^/]+\/claim$/;

export async function proxy(req: NextRequest) {
  const res = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            res.cookies.set(name, value, applyHardening(options));
          }
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const user = data.user;

  const path = req.nextUrl.pathname;
  const isProtected =
    PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ||
    PROTECTED_INVITE_CLAIM.test(path);

  if (isProtected && !user) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', path + (req.nextUrl.search ?? ''));
    return NextResponse.redirect(url);
  }

  return res;
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

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|sw\\.js|auth/|api/|.+\\.(?:svg|png|jpe?g|gif|webp|ico|json|xml|txt|webmanifest|js|css|html)).*)',
  ],
};
