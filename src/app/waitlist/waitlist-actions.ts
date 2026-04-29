'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Source enum mirrored at the boundary. waitlist.source is plain text;
// keeping the allow-list here means the upgrade-from-cap-hit route can't
// be used to write arbitrary marketing UTM-style strings into the table.
const SOURCES = ['landing', 'cap_hit'] as const;

const Input = z.object({
  email: z.string().email().max(200),
  turnstile_token: z.string().max(2048).optional().default(''),
  source: z.enum(SOURCES).optional().default('landing'),
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

  // rate_limit_hit RPC enforces the window must be '1 minute' (per-minute
  // bucketed table). 3 attempts/min/IP is tight enough to deter scripted
  // signups and loose enough for fat-fingered legit users retrying after
  // a captcha or email-format error.
  const { data: allowed, error: rlErr } = await sb.rpc('rate_limit_hit', {
    p_scope: 'waitlist',
    p_key: ip,
    p_window: '1 minute',
    p_limit: 3,
  });
  if (rlErr) return { ok: false, error: 'rate_check_failed' };
  if (allowed === false) return { ok: false, error: 'rate_limited' };

  const captchaOk = await verifyTurnstile(parsed.data.turnstile_token, ip);
  if (!captchaOk) return { ok: false, error: 'captcha_failed' };

  const { error: insertErr } = await sb
    .from('waitlist')
    .insert({
      email: parsed.data.email,
      source: parsed.data.source,
      created_ip: ip === 'dev-local' ? null : ip,
    });

  // Unique violation (duplicate email) — treat as success to not leak.
  if (insertErr && insertErr.code !== '23505') {
    return { ok: false, error: 'insert_failed' };
  }
  return { ok: true };
}
