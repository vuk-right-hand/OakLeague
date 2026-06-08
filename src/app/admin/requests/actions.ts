'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { assertAdminFromSession } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createInvite } from '@/lib/invites/create-invite';
import type { EmailStatus } from '@/lib/email/send-email';

const IdSchema = z.string().uuid();

// Approve a creator request → mint + send an invite (existing /invite → /apply
// flow) and mark the request 'invited'. The request's email is an UNTRUSTED
// lead; the admin clicking approve IS the identity check (audit C3/C6). Returns
// emailStatus + the copy-link URL so the admin can hand it over manually when
// delivery is skipped/failed (audit C2/H2).
export async function approveCreatorRequest(
  id: string,
): Promise<
  | { ok: true; url: string; emailStatus: EmailStatus }
  | { ok: false; error: string }
> {
  const admin = await assertAdminFromSession().catch(() => null);
  if (!admin) return { ok: false, error: 'forbidden' };
  if (!IdSchema.safeParse(id).success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();

  // CLAIM the row atomically BEFORE minting (audit C-2). The guarded UPDATE
  // pending→invited can only win once, so two concurrent approvals can never
  // both reach createInvite() and mint duplicate live tokens. We mint only as
  // the claim winner, then revert if the mint fails so the admin can retry.
  const { data: claimed, error: claimErr } = await sb
    .from('creator_requests')
    .update({
      status: 'invited',
      reviewed_by: admin.userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('email')
    .maybeSingle<{ email: string }>();
  if (claimErr) return { ok: false, error: 'update_failed' };
  if (!claimed) {
    // Lost the race or bad id — distinguish for the UI.
    const { data: row } = await sb
      .from('creator_requests')
      .select('id')
      .eq('id', id)
      .maybeSingle<{ id: string }>();
    return { ok: false, error: row ? 'already_reviewed' : 'not_found' };
  }

  const invite = await createInvite({
    email: claimed.email,
    invitedBy: admin.userId,
    notes: 'from creator_requests',
    expiresInDays: 7,
  });
  if (!invite.ok) {
    // Revert the claim so the request returns to the pending queue for retry.
    await sb
      .from('creator_requests')
      .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
      .eq('id', id)
      .eq('status', 'invited');
    return { ok: false, error: 'invite_failed' };
  }

  // Record the invitation_id (row is already 'invited'; best effort).
  await sb.from('creator_requests').update({ invitation_id: invite.id }).eq('id', id);

  revalidatePath('/admin/requests');
  revalidatePath(`/admin/requests/${id}`);
  return { ok: true, url: invite.url, emailStatus: invite.emailStatus };
}

const DeclineSchema = z.object({
  id: z.string().uuid(),
  notes: z.string().max(4000).optional().default(''),
});

export async function declineCreatorRequest(
  id: string,
  notes: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await assertAdminFromSession().catch(() => null);
  if (!admin) return { ok: false, error: 'forbidden' };

  const parsed = DeclineSchema.safeParse({ id, notes });
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const sb = supabaseAdmin();
  const { error } = await sb
    .from('creator_requests')
    .update({
      status: 'declined',
      internal_notes: parsed.data.notes || null,
      reviewed_by: admin.userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .eq('status', 'pending');
  if (error) return { ok: false, error: 'update_failed' };

  revalidatePath('/admin/requests');
  revalidatePath(`/admin/requests/${parsed.data.id}`);
  return { ok: true };
}
