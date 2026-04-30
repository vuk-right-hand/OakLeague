'use server';

import { z } from 'zod';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { CREATOR_TERMS_VERSION } from '@/lib/legal/creator-terms-version';

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
  // Required true. The form gates submit on the checkbox; this is the
  // server-side backstop. RPC also re-checks (defense in depth).
  duet_consent: z.literal(true),
});

const KNOWN_ERRORS = new Set([
  'handle_taken',
  'duplicate_application',
  'invite_claim_invalid',
  'invite_unavailable',
  'invite_claim_missing_invitation_id',
  'needs_invite',
  'unauthorized',
  'duet_consent_required',
  'duet_consent_terms_version_invalid',
  'stale_client',
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

  // Stale-client detection (audit R2 M1, R3-final M4). An old form
  // bundle (cached SW, stale tab open from before the duet-consent
  // deploy) submits without a duet_consent field, or with the field
  // present but undefined/false. Force a hard reload so the user
  // gets the new form bundle with the consent checkbox.
  const isObject = typeof input === 'object' && input !== null;
  const hasField = isObject && 'duet_consent' in input;
  const fieldVal = hasField
    ? (input as Record<string, unknown>).duet_consent
    : undefined;
  if (!hasField || fieldVal === undefined) {
    return { ok: false, error: 'stale_client' };
  }

  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    // R3-final M4: if Zod fails AND duet_consent is anything other
    // than literal true, treat as stale_client (old bundle sending
    // false-y or wrong-type value). Genuine validation failures
    // (e.g. bad handle regex with consent=true) fall through to
    // invalid_input.
    if (fieldVal !== true) {
      return { ok: false, error: 'stale_client' };
    }
    return { ok: false, error: 'invalid_input' };
  }

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
    p_duet_consent: parsed.data.duet_consent,
    p_duet_consent_terms_version: CREATOR_TERMS_VERSION,
  });

  if (error) {
    return { ok: false, error: parseStructuredError(error.message) };
  }

  jar.delete('invite_nonce');
  revalidatePath('/admin/applications');
  return { ok: true };
}
