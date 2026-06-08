import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { mintInviteToken } from '@/lib/invite-tokens';
import { sendEmail, type EmailStatus } from '@/lib/email/send-email';
import { renderInviteEmail, siteUrl } from '@/lib/email/templates';

// Shared invite creation: mint token → insert creator_invitations → send invite
// email. Used by BOTH the manual admin "New invite" action and the
// "Approve creator request" path so there's one code path (and one email
// template) for invites. Returns emailStatus so callers can surface the
// copy-link fallback when delivery is skipped/failed (audit C2/H2).

export type CreateInviteResult =
  | { ok: true; id: string; url: string; emailStatus: EmailStatus }
  | { ok: false; error: string };

export async function createInvite(args: {
  email: string;
  invitedBy: string;
  notes?: string | null;
  expiresInDays: number;
}): Promise<CreateInviteResult> {
  const { token, hash } = mintInviteToken();
  const expiresAt = new Date(Date.now() + args.expiresInDays * 864e5).toISOString();

  const sb = supabaseAdmin();
  const { data: row, error } = await sb
    .from('creator_invitations')
    .insert({
      email: args.email,
      token_hash: hash,
      invited_by: args.invitedBy,
      notes: args.notes || null,
      expires_at: expiresAt,
    })
    .select('id')
    .single<{ id: string }>();

  if (error || !row) return { ok: false, error: 'insert_failed' };

  const url = `${siteUrl()}/invite/${token}`;
  const { subject, html } = renderInviteEmail({ url, expiresAt });
  const res = await sendEmail({ to: args.email, subject, html });

  return { ok: true, id: row.id, url, emailStatus: res.status };
}
