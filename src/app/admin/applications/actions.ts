'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { assertAdminFromSession } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sendEmail } from '@/lib/email/send-email';
import {
  renderApplicationApprovedEmail,
  renderApplicationRejectedEmail,
} from '@/lib/email/templates';

// Look up an applicant's verified email + display name from the application id.
// Uses the service-role client (auth.admin.getUserById). Best-effort: returns
// nulls on any failure so a missing email never blocks approve/reject.
async function applicantContact(
  applicationId: string,
): Promise<{ email: string | null; displayName: string | null }> {
  try {
    const sb = supabaseAdmin();
    const { data: app } = await sb
      .from('creator_applications')
      .select('user_id, display_name')
      .eq('id', applicationId)
      .maybeSingle<{ user_id: string; display_name: string | null }>();
    if (!app?.user_id) return { email: null, displayName: app?.display_name ?? null };
    const { data: u } = await sb.auth.admin.getUserById(app.user_id);
    return { email: u?.user?.email ?? null, displayName: app.display_name ?? null };
  } catch {
    return { email: null, displayName: null };
  }
}

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
    if (error.code === '23503' || error.message.includes('not_pending')) {
      return { ok: false, error: 'application_already_approved' };
    }
    return { ok: false, error: 'approve_failed' };
  }

  // Approval email — best effort (never blocks the approval).
  const { email, displayName } = await applicantContact(parsed.data);
  if (email) {
    const { subject, html } = renderApplicationApprovedEmail({ displayName: displayName ?? '' });
    await sendEmail({ to: email, subject, html });
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

  // Rejection email with the admin-written reason — best effort.
  const { email } = await applicantContact(id);
  if (email) {
    const { subject, html } = renderApplicationRejectedEmail({ reason: parsed.data.reason });
    await sendEmail({ to: email, subject, html });
  }

  revalidatePath('/admin/applications');
  return { ok: true };
}
