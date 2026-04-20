'use server';

import { z } from 'zod';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

const TopicSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  title: z.string().min(1).max(80),
  description: z.string().max(500).optional().default(''),
});

const ProofSchema = z.object({
  youtube_url: z.string().url().max(500).optional(),
  twitter_url: z.string().url().max(500).optional(),
  website: z.string().url().max(500).optional(),
  other_links: z.array(z.string().url().max(500)).max(10).optional(),
});

const Input = z.object({
  display_name: z.string().min(1).max(80),
  handle: z.string().regex(/^[a-z0-9_]{3,30}$/),
  bio: z.string().max(2000).optional().default(''),
  topics: z.array(TopicSchema).min(1).max(5),
  proof: ProofSchema,
});

const KNOWN_ERRORS = new Set([
  'handle_taken',
  'duplicate_application',
  'invite_claim_invalid',
  'invite_unavailable',
  'invite_claim_missing_invitation_id',
  'needs_invite',
  'unauthorized',
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

  const supabase = await supabaseServer();
  const { error } = await supabase.rpc('submit_creator_application', {
    p_claim_nonce: nonce,
    p_display_name: parsed.data.display_name,
    p_handle: parsed.data.handle,
    p_bio: parsed.data.bio || null,
    p_topics: parsed.data.topics,
    p_proof: parsed.data.proof,
  });

  if (error) {
    return { ok: false, error: parseStructuredError(error.message) };
  }

  jar.delete('invite_nonce');
  revalidatePath('/admin/applications');
  return { ok: true };
}
