'use server';

import { z } from 'zod';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

// Comment server actions (COMMENTS_LIKES_PLAN C2). All gating (published,
// rate-limit, depth, authz, visibility) is enforced in the SECURITY DEFINER
// RPCs; these are thin, whitelisted wrappers.

export type CommentRow = {
  id: string;
  body: string;
  author_handle: string | null;
  author_name: string | null;
  author_avatar: string | null;
  created_at: string;
  is_hidden: boolean;
  reply_count?: number;
  is_own?: boolean;
};

const PostInput = z.object({
  video_id: z.string().uuid(),
  body: z.string().trim().min(1).max(2000),
  parent_id: z.string().uuid().optional(),
});

export async function postCommentAction(
  input: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };
  const parsed = PostInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_body' };

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('post_comment', {
    p_video_id: parsed.data.video_id,
    p_body: parsed.data.body,
    p_parent_id: parsed.data.parent_id ?? null,
  });
  if (error) {
    if (error.message?.includes('rate_limited')) return { ok: false, error: 'rate_limited' };
    if (error.message?.includes('link_not_allowed')) return { ok: false, error: 'link_not_allowed' };
    if (error.message?.includes('bad_parent')) return { ok: false, error: 'bad_parent' };
    if (error.message?.includes('video_not_available')) return { ok: false, error: 'unavailable' };
    return { ok: false, error: 'failed' };
  }
  if (typeof data !== 'string') return { ok: false, error: 'failed' }; // null id guard (audit Small)
  return { ok: true, id: data };
}

const IdInput = z.object({ comment_id: z.string().uuid() });

export async function deleteCommentAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };
  const parsed = IdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_input' };
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc('delete_own_comment', { p_comment_id: parsed.data.comment_id });
  return error ? { ok: false, error: 'failed' } : { ok: true };
}

const ModerateInput = z.object({
  comment_id: z.string().uuid(),
  action: z.enum(['delete', 'hide', 'unhide', 'pin', 'unpin']),
});

export async function moderateCommentAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };
  const parsed = ModerateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_input' };
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc('moderate_comment', {
    p_comment_id: parsed.data.comment_id,
    p_action: parsed.data.action,
  });
  if (error) {
    if (error.message?.includes('forbidden')) return { ok: false, error: 'forbidden' };
    if (error.message?.includes('pin_top_level_only')) return { ok: false, error: 'pin_top_level_only' };
    return { ok: false, error: 'failed' };
  }
  return { ok: true };
}

const ReportInput = z.object({
  comment_id: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export async function reportCommentAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };
  const parsed = ReportInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_input' };
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc('report_comment', {
    p_comment_id: parsed.data.comment_id,
    p_reason: parsed.data.reason ?? null,
  });
  return error ? { ok: false, error: 'failed' } : { ok: true };
}

const LoadInput = z.object({
  video_id: z.string().uuid(),
  cursor_ts: z.string().datetime().optional(), // validated datetime → no malformed cursor 400 (audit M7)
  cursor_id: z.string().uuid().optional(),
});

export async function loadCommentsAction(
  input: unknown,
): Promise<{ ok: true; comments: CommentRow[] } | { ok: false; error: string }> {
  const parsed = LoadInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_input' };
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('list_video_comments', {
    p_video_id: parsed.data.video_id,
    p_cursor_ts: parsed.data.cursor_ts ?? null,
    p_cursor_id: parsed.data.cursor_id ?? null,
    p_limit: 30,
  });
  if (error) return { ok: false, error: 'failed' };
  return { ok: true, comments: (data ?? []) as CommentRow[] };
}

const RepliesInput = z.object({ parent_id: z.string().uuid() });

export async function loadRepliesAction(
  input: unknown,
): Promise<{ ok: true; replies: CommentRow[] } | { ok: false; error: string }> {
  const parsed = RepliesInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_input' };
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('list_comment_replies', {
    p_parent_id: parsed.data.parent_id,
    p_cursor_ts: null,
    p_cursor_id: null,
    p_limit: 50,
  });
  if (error) return { ok: false, error: 'failed' };
  return { ok: true, replies: (data ?? []) as CommentRow[] };
}
