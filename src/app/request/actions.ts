'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { verifyTurnstile } from '@/lib/turnstile';

// Public "Request to become a creator" submission (CREATOR_JOURNEY WS1).
// Unauthenticated. This action is the security gate (audit C3):
//   - Turnstile captcha
//   - dual-key rate limit (IP + normalized email) + a global hourly ceiling
//   - proof links locked to http(s) scheme + a fixed key set (mirrors apply)
//   - dedupe against an existing open lead (treated as success, no leak)
// The row is an UNTRUSTED lead; the approving admin is the identity check.

// http(s)-only URL (rejects javascript:/data:/vbscript: even though zod .url()
// accepts them). Same guard as the apply ProofSchema (auditor M1, 2026-05-26).
const safeUrl = z
  .string()
  .url()
  .max(500)
  .refine(
    (u) => {
      try {
        const p = new URL(u).protocol;
        return p === 'https:' || p === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'unsupported_url_scheme' },
  );

const ProofSchema = z
  .object({
    youtube_url: safeUrl.optional(),
    twitter_url: safeUrl.optional(),
    instagram_url: safeUrl.optional(),
    tiktok_url: safeUrl.optional(),
    website: safeUrl.optional(),
    // Catch-all for sessions / books / docs / podcasts / anything else — all
    // optional, http(s)-validated, bounded.
    other_links: z.array(safeUrl).max(10).optional(),
  })
  .strict();

const Input = z.object({
  email: z.string().email().max(200),
  name: z.string().max(120).optional().default(''),
  pitch: z.string().max(2000).optional().default(''),
  proof: ProofSchema.optional().default({}),
  turnstile_token: z.string().max(2048).optional().default(''),
});

// RATE-LIMIT/ABUSE key only: lowercase, trim, strip the +tag so user+1@ /
// user+2@ can't each get a fresh bucket. NOT the address we store or mail to —
// the invite-claim RPC enforces an exact email match, so a plus-stripped invite
// would lock a `user+tag@` creator out of claiming (audit C-3). We store + mail
// the ORIGINAL (lowercased) address; we only KEY abuse throttling on this.
function rateLimitEmailKey(email: string): string {
  const [local, domain] = email.toLowerCase().trim().split('@');
  if (!domain) return email.toLowerCase().trim();
  const base = local.split('+')[0];
  return `${base}@${domain}`;
}

export async function submitCreatorRequest(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  // Strip empty proof keys so we store '{}' rather than a bag of undefineds.
  const proof = Object.fromEntries(
    Object.entries(parsed.data.proof).filter(([, v]) =>
      Array.isArray(v) ? v.length > 0 : Boolean(v),
    ),
  );

  // Prefer the non-spoofable platform client-IP headers (Vercel sets these);
  // the leftmost x-forwarded-for hop is attacker-controlled, so it's the last
  // resort only (mirrors apply/actions.ts, auditor M4).
  const hdrs = await headers();
  const ip = (
    hdrs.get('x-real-ip') ||
    hdrs.get('x-vercel-forwarded-for') ||
    (hdrs.get('x-forwarded-for') ?? '').split(',')[0]
  ).trim() || 'dev-local';

  // CAPTCHA FIRST (audit C-1): the rate-limit buckets must only be spent by
  // requests that cleared Turnstile, or an attacker without a token can flood
  // the global counter and lock the whole funnel for an hour. verifyTurnstile
  // returns false immediately for a missing token (no network call), so this
  // is also the cheapest pre-filter.
  const captchaOk = await verifyTurnstile(parsed.data.turnstile_token, ip);
  if (!captchaOk) return { ok: false, error: 'captcha_failed' };

  const sb = supabaseAdmin();
  // Store + mail the ORIGINAL (lowercased) address so invite-claim's exact
  // email match succeeds. Throttle abuse on the plus-stripped key only.
  const emailLower = parsed.data.email.toLowerCase().trim();
  const rateKey = rateLimitEmailKey(parsed.data.email);

  // Rate limit: per-IP (hourly), per-email (daily), and a global hourly ceiling
  // so no single IP/email can flood and the table can't be filled at scale.
  const limits: Array<{ scope: string; key: string; window: string; limit: number }> = [
    { scope: 'creator_request_ip', key: ip, window: '1 hour', limit: 5 },
    { scope: 'creator_request_email', key: rateKey, window: '24 hours', limit: 3 },
    { scope: 'creator_request_global', key: 'global', window: '1 hour', limit: 200 },
  ];
  for (const l of limits) {
    const { data: allowed, error: rlErr } = await sb.rpc('rate_limit_hit', {
      p_scope: l.scope,
      p_key: l.key,
      p_window: l.window,
      p_limit: l.limit,
    });
    if (rlErr) return { ok: false, error: 'rate_check_failed' };
    if (allowed === false) return { ok: false, error: 'rate_limited' };
  }

  // Dedupe: if there's already an open (pending/invited) lead for this exact
  // email, treat as success — don't double-queue. Exact-match (not plus-stripped)
  // so it lines up with the creator-status 'requested' lookup.
  const { data: existing } = await sb
    .from('creator_requests')
    .select('id')
    .eq('email', emailLower)
    .in('status', ['pending', 'invited'])
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (existing) return { ok: true };

  const { error: insertErr } = await sb.from('creator_requests').insert({
    email: emailLower,
    name: parsed.data.name || null,
    pitch: parsed.data.pitch || null,
    proof,
    created_ip: ip === 'dev-local' ? null : ip,
  });

  if (insertErr) return { ok: false, error: 'insert_failed' };

  // No request-stage ack email: it would mail an UNVERIFIED, attacker-supplied
  // address from a cold sending domain (spam/reputation risk + a weak existence
  // oracle) — audit M-4. The on-screen confirmation is the closure; the real
  // email touchpoint is the admin-approved invite (sent to a vetted lead).
  return { ok: true };
}
