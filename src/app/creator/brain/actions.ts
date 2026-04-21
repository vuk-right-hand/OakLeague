'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { AuthGuardError } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  UrlValidationError,
  assertSafePublicHttpsUrl,
} from '@/lib/creator/validate-url';
import type { SampleSourceType } from '@/lib/creator/types';

type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };

const SOURCE_TYPES: readonly SampleSourceType[] = [
  'youtube',
  'transcript',
  'book_or_doc',
  'mastermind_or_course',
  'testimonial',
] as const;

const SLUG_RE = /^[a-z0-9_-]+$/;

const addTopicSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .transform((s) => s.replace(/\.$/, ''))
    .pipe(
      z
        .string()
        .min(2, 'invalid_slug')
        .max(40, 'invalid_slug')
        .regex(SLUG_RE, 'invalid_slug'),
    ),
  title: z.string().trim().min(1, 'missing_title').max(100, 'title_too_long'),
  description: z
    .string()
    .trim()
    .max(500, 'description_too_long')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const deleteTopicSchema = z.object({
  topicId: z.string().uuid(),
});

const addSampleSchema = z.object({
  source_type: z.enum([
    'youtube',
    'transcript',
    'book_or_doc',
    'mastermind_or_course',
    'testimonial',
  ] as const),
  title: z
    .string()
    .trim()
    .max(200, 'title_too_long')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  source_url: z
    .string()
    .trim()
    .max(2048, 'url_too_long')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  raw_text: z
    .string()
    .max(262144, 'raw_text_too_long')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  topic_tags: z
    .array(z.string().min(2).max(40).regex(SLUG_RE, 'invalid_topic_tags'))
    .min(1, 'topic_tags_required'),
});

const deleteSampleSchema = z.object({
  id: z.string().uuid(),
});

async function resolveCreator(): Promise<
  { ok: true; creatorId: string } | { ok: false; error: string }
> {
  try {
    const { creatorId } = await getCreatorForCaller();
    return { ok: true, creatorId };
  } catch (e) {
    if (e instanceof AuthGuardError) {
      return { ok: false, error: e.status === 401 ? 'sign_in_required' : 'forbidden' };
    }
    throw e;
  }
}

function revalidateCreatorPaths() {
  revalidatePath('/creator/brain');
  revalidatePath('/creator');
}

export async function addTopic(
  input: z.input<typeof addTopicSchema>,
): Promise<Result<{ id: string }>> {
  const caller = await resolveCreator();
  if (!caller.ok) return caller;

  const parsed = addTopicSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid_input' };
  }
  const { slug, title, description } = parsed.data;

  const admin = supabaseAdmin();
  const { data: maxRow } = await admin
    .from('creator_topics')
    .select('sort_order')
    .eq('creator_id', caller.creatorId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSortOrder = ((maxRow?.sort_order as number | undefined) ?? 0) + 1;

  const sb = await supabaseServer();
  const { data, error } = await sb
    .from('creator_topics')
    .insert({
      creator_id: caller.creatorId,
      slug,
      title,
      description,
      sort_order: nextSortOrder,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '23505') return { ok: false, error: 'slug_taken' };
    if (error.code === '23514') {
      if (msg.includes('5 topics')) return { ok: false, error: 'topic_limit_reached' };
      return { ok: false, error: 'invalid_topic' };
    }
    return { ok: false, error: 'insert_failed' };
  }
  if (!data) return { ok: false, error: 'insert_failed' };

  revalidateCreatorPaths();
  return { ok: true, data: { id: data.id as string } };
}

export async function deleteTopic(
  input: z.input<typeof deleteTopicSchema>,
): Promise<Result> {
  const caller = await resolveCreator();
  if (!caller.ok) return caller;

  const parsed = deleteTopicSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  // Use admin client throughout to avoid stale-cookie RLS filtering out owned rows.
  // Ownership is enforced via explicit creator_id filter (equivalent to RLS policy).
  const admin = supabaseAdmin();

  const { data: topic } = await admin
    .from('creator_topics')
    .select('slug')
    .eq('id', parsed.data.topicId)
    .eq('creator_id', caller.creatorId)
    .maybeSingle();

  if (!topic) return { ok: false, error: 'not_found' };

  const slug = topic.slug as string;

  const { data: refs } = await admin
    .from('sample_content')
    .select('id')
    .eq('creator_id', caller.creatorId)
    .overlaps('topic_tags', [slug])
    .limit(1);

  if (refs && refs.length > 0) {
    return { ok: false, error: 'topic_has_sources' };
  }

  const { data: deleted, error } = await admin
    .from('creator_topics')
    .delete()
    .eq('id', parsed.data.topicId)
    .eq('creator_id', caller.creatorId)
    .select('id');

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '23514' && msg.includes('topic_referenced_by_sample_content')) {
      return { ok: false, error: 'topic_has_sources' };
    }
    if (error.code === '23514' && msg.includes('topic_referenced_by_hooks')) {
      return { ok: false, error: 'topic_has_hooks' };
    }
    return { ok: false, error: 'delete_failed' };
  }
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: 'not_found' };
  }

  revalidateCreatorPaths();
  return { ok: true, data: null };
}

const SAMPLE_ROW_QUOTA = 100;

export async function addSampleContent(
  input: z.input<typeof addSampleSchema>,
): Promise<Result<{ id: string }>> {
  const caller = await resolveCreator();
  if (!caller.ok) return caller;

  const parsed = addSampleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid_input' };
  }
  const { source_type, title, source_url, raw_text, topic_tags } = parsed.data;

  if (!SOURCE_TYPES.includes(source_type)) {
    return { ok: false, error: 'invalid_source_type' };
  }

  if (source_url !== null) {
    try {
      assertSafePublicHttpsUrl(source_url);
    } catch (e) {
      if (e instanceof UrlValidationError) return { ok: false, error: `url_${e.code}` };
      return { ok: false, error: 'url_invalid_url' };
    }
  }

  const admin = supabaseAdmin();
  const { count: existingCount, error: countErr } = await admin
    .from('sample_content')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', caller.creatorId);

  if (countErr) return { ok: false, error: 'count_failed' };
  if ((existingCount ?? 0) >= SAMPLE_ROW_QUOTA) {
    return { ok: false, error: 'source_quota_reached' };
  }

  const uniqueTags = [...new Set(topic_tags)];

  const sb = await supabaseServer();
  const { data, error } = await sb
    .from('sample_content')
    .insert({
      creator_id: caller.creatorId,
      source_type,
      title,
      source_url,
      raw_text,
      topic_tags: uniqueTags,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '23514') {
      if (msg.includes('unregistered slugs')) {
        return { ok: false, error: 'invalid_topic_tags' };
      }
      return { ok: false, error: 'invalid_source' };
    }
    return { ok: false, error: 'insert_failed' };
  }
  if (!data) return { ok: false, error: 'insert_failed' };

  revalidateCreatorPaths();
  return { ok: true, data: { id: data.id as string } };
}

export async function deleteSampleContent(
  input: z.input<typeof deleteSampleSchema>,
): Promise<Result> {
  const caller = await resolveCreator();
  if (!caller.ok) return caller;

  const parsed = deleteSampleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  // Use admin client to avoid stale-cookie RLS returning 0 rows on owned records.
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('sample_content')
    .delete()
    .eq('id', parsed.data.id)
    .eq('creator_id', caller.creatorId)
    .select('id');

  if (error) return { ok: false, error: 'delete_failed' };
  if (!data || data.length === 0) return { ok: false, error: 'not_found' };

  revalidateCreatorPaths();
  return { ok: true, data: null };
}
