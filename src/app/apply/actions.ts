'use server';

import { z } from 'zod';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { buildApplyConsents } from '@/lib/consent';

const TopicSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  title: z.string().min(1).max(80),
  description: z.string().max(500).optional().default(''),
});

// Zod `.url()` parses validity but ACCEPTS `javascript:`, `data:`, `vbscript:`
// schemes. Proof URLs are stored verbatim as JSONB and may later be rendered as
// clickable <a href> (creator links on the profile / studio), so lock the scheme
// to http(s) at write time — a stored `javascript:` URL must never reach the DB.
// (auditor M1, 2026-05-26.)
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

const ProofSchema = z.object({
  youtube_url: safeUrl.optional(),
  twitter_url: safeUrl.optional(),
  website: safeUrl.optional(),
  // PROFILE_SYSTEM_PLAN U5 / audit S5: these are added to the FORM, so they MUST
  // be in this whitelist — Zod strips unknown keys silently otherwise.
  instagram_url: safeUrl.optional(),
  tiktok_url: safeUrl.optional(),
  courses: z
    .array(z.object({ title: z.string().min(1).max(120), url: safeUrl.optional() }))
    .max(10)
    .optional(),
  other_links: z.array(safeUrl).max(10).optional(),
});

const Input = z.object({
  display_name: z.string().min(1).max(80),
  handle: z.string().regex(/^[a-z0-9_]{3,30}$/),
  bio: z.string().max(2000).optional().default(''),
  topics: z.array(TopicSchema).min(1).max(5),
  proof: ProofSchema,
  // P0-3: both consent boxes are required. z.literal(true) fails validation if
  // unchecked → invalid_input (the form also disables submit until both set).
  accept_tos: z.literal(true),
  accept_voice_likeness: z.literal(true),
});

const KNOWN_ERRORS = new Set([
  'handle_taken',
  'duplicate_application',
  'invite_claim_invalid',
  'invite_unavailable',
  'invite_claim_missing_invitation_id',
  'needs_invite',
  'unauthorized',
  'consent_required',
  'bad_consent',
]);

function parseStructuredError(msg: string | undefined): string {
  if (!msg) return 'submit_failed';
  for (const code of KNOWN_ERRORS) {
    if (msg.includes(code)) return code;
  }
  return 'submit_failed';
}

export async function submitCreatorApplication(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };

  const jar = await cookies();
  const nonce = jar.get('invite_nonce')?.value;
  if (!nonce) return { ok: false, error: 'needs_invite' };

  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  // Enforce unique slugs.
  const slugs = parsed.data.topics.map((t) => t.slug);
  if (new Set(slugs).size !== slugs.length) {
    return { ok: false, error: 'duplicate_topic_slug' };
  }

  // Capture ip + user-agent for the consent record (supplementary provenance —
  // the authenticated user_id is the real evidence). Prefer Vercel's
  // platform-set client-IP headers (x-real-ip / x-vercel-forwarded-for), which
  // are NOT client-spoofable, over the leftmost x-forwarded-for hop, which is
  // attacker-controlled (auditor M4). Best-effort, untrusted if absent.
  const hdrs = await headers();
  const ip = (
    hdrs.get('x-real-ip') ||
    hdrs.get('x-vercel-forwarded-for') ||
    (hdrs.get('x-forwarded-for') ?? '').split(',')[0]
  ).trim().slice(0, 64) || null;
  const userAgent = hdrs.get('user-agent')?.slice(0, 512) || null;

  const supabase = await supabaseServer();
  const { error } = await supabase.rpc('submit_creator_application', {
    p_claim_nonce: nonce,
    p_display_name: parsed.data.display_name,
    p_handle: parsed.data.handle,
    p_bio: parsed.data.bio || null,
    p_topics: parsed.data.topics,
    p_proof: parsed.data.proof,
    p_consents: buildApplyConsents(),
    p_ip: ip,
    p_user_agent: userAgent,
  });

  if (error) {
    return { ok: false, error: parseStructuredError(error.message) };
  }

  jar.delete('invite_nonce');
  revalidatePath('/admin/applications');
  return { ok: true };
}
