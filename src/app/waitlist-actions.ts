'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';

const Input = z.object({
  email: z.string().email().max(200),
  turnstile_token: z.string().max(2048).optional().default(''),
});

async function verifyTurnstile(token: string, remoteIp: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // captcha disabled in dev
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const json = (await res.json()) as { success?: boolean };
    return Boolean(json.success);
  } catch {
    return false;
  }
}

export async function joinWaitlist(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'dev-local';

  const sb = supabaseAdmin();

  const { data: allowed, error: rlErr } = await sb.rpc('rate_limit_hit', {
    p_scope: 'waitlist',
    p_key: ip,
    p_window: '1 hour',
    p_limit: 10,
  });
  if (rlErr) return { ok: false, error: 'rate_check_failed' };
  if (allowed === false) return { ok: false, error: 'rate_limited' };

  const captchaOk = await verifyTurnstile(parsed.data.turnstile_token, ip);
  if (!captchaOk) return { ok: false, error: 'captcha_failed' };

  const { error: insertErr } = await sb
    .from('waitlist')
    .insert({
      email: parsed.data.email,
      source: 'landing',
      created_ip: ip === 'dev-local' ? null : ip,
    });

  // Unique violation (duplicate email) — treat as success to not leak.
  if (insertErr && insertErr.code !== '23505') {
    return { ok: false, error: 'insert_failed' };
  }
  return { ok: true };
}
