'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { assertAdminFromSession } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

const IdSchema = z.string().uuid();

export async function approveApplication(
  id: string,
): Promise<{ ok: true; creatorId: string } | { ok: false; error: string }> {
  const admin = await assertAdminFromSession().catch(() => null);
  if (!admin) return { ok: false, error: 'forbidden' };

  const parsed = IdSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('approve_creator_application', {
    p_id: parsed.data,
  });

  if (error) {
    if (error.message.includes('duet_consent_missing')) {
      return { ok: false, error: 'duet_consent_missing' };
    }
    if (error.message.includes('not_pending')) {
      return { ok: false, error: 'application_already_approved' };
    }
    if (error.code === '23503') {
      return { ok: false, error: 'application_already_approved' };
    }
    return { ok: false, error: 'approve_failed' };
  }

  revalidatePath('/admin/applications');
  return { ok: true, creatorId: data as string };
}

const RejectSchema = z.object({
  reason: z.string().min(1).max(500),
  notes: z.string().max(4000).optional().default(''),
});

export async function rejectApplication(
  id: string,
  reason: string,
  notes: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await assertAdminFromSession().catch(() => null);
  if (!admin) return { ok: false, error: 'forbidden' };

  if (!IdSchema.safeParse(id).success) return { ok: false, error: 'invalid_input' };
  const parsed = RejectSchema.safeParse({ reason, notes });
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const supabase = await supabaseServer();
  const { error } = await supabase.rpc('reject_creator_application', {
    p_id: id,
    p_reason: parsed.data.reason,
    p_internal_notes: parsed.data.notes,
  });

  if (error) {
    if (error.code === '23503' || error.message.includes('not_pending')) {
      return { ok: false, error: 'application_already_reviewed' };
    }
    return { ok: false, error: 'reject_failed' };
  }

  revalidatePath('/admin/applications');
  return { ok: true };
}
