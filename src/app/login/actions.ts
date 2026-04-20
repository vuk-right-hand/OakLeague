'use server';

import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';

const MagicLinkInput = z.object({
  email: z.string().email().max(200),
  next: z.string().max(500),
});

const GoogleOAuthInput = z.object({
  next: z.string().max(500),
});

function siteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  return url.replace(/\/$/, '');
}

function safeNext(next: string): string {
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

export async function requestMagicLink(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = MagicLinkInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const next = safeNext(parsed.data.next);

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) return { ok: false, error: 'send_failed' };
  return { ok: true };
}

export async function startGoogleOAuth(
  input: unknown,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const parsed = GoogleOAuthInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const next = safeNext(parsed.data.next);

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error || !data.url) return { ok: false, error: 'oauth_failed' };
  return { ok: true, url: data.url };
}
