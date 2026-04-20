'use server';

import { z } from 'zod';
import { Resend } from 'resend';
import { assertAdminFromSession } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mintInviteToken } from '@/lib/invite-tokens';

const Input = z.object({
  email: z.string().email().max(200),
  notes: z.string().max(500).optional().default(''),
  expires_in_days: z.number().int().min(1).max(7),
});

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export async function mintCreatorInvite(
  input: unknown,
): Promise<{ ok: true; id: string; url: string } | { ok: false; error: string }> {
  const admin = await assertAdminFromSession().catch(() => null);
  if (!admin) return { ok: false, error: 'forbidden' };

  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const { token, hash } = mintInviteToken();
  const expiresAt = new Date(Date.now() + parsed.data.expires_in_days * 864e5).toISOString();

  const sb = supabaseAdmin();
  const { data: row, error } = await sb
    .from('creator_invitations')
    .insert({
      email: parsed.data.email,
      token_hash: hash,
      invited_by: admin.userId,
      notes: parsed.data.notes || null,
      expires_at: expiresAt,
    })
    .select('id')
    .single<{ id: string }>();

  if (error || !row) return { ok: false, error: 'insert_failed' };

  const url = `${siteUrl()}/invite/${token}`;

  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (resendKey && from) {
    try {
      const resend = new Resend(resendKey);
      await resend.emails.send({
        from,
        to: parsed.data.email,
        subject: 'You&apos;re invited to OakLeague',
        html: renderInviteEmail({ url, expiresAt }),
      });
    } catch {
      // Non-fatal — admin has the copy-fallback URL.
    }
  }

  return { ok: true, id: row.id, url };
}

function renderInviteEmail({ url, expiresAt }: { url: string; expiresAt: string }): string {
  const safeUrl = url.replace(/"/g, '&quot;');
  const human = new Date(expiresAt).toUTCString();
  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 520px;">
      <h2>You're invited to OakLeague as a creator</h2>
      <p>This invite is single-use and expires ${human}.</p>
      <p><a href="${safeUrl}" style="background:#0a0a0a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">Claim your spot</a></p>
      <p style="color:#666;font-size:12px;word-break:break-all;">Or paste this link: ${safeUrl}</p>
    </div>
  `;
}
