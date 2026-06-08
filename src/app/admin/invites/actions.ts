'use server';

import { z } from 'zod';
import { assertAdminFromSession } from '@/lib/auth-guards';
import { createInvite } from '@/lib/invites/create-invite';
import type { EmailStatus } from '@/lib/email/send-email';

const Input = z.object({
  email: z.string().email().max(200),
  notes: z.string().max(500).optional().default(''),
  expires_in_days: z.number().int().min(1).max(7),
});

export async function mintCreatorInvite(
  input: unknown,
): Promise<
  | { ok: true; id: string; url: string; emailStatus: EmailStatus }
  | { ok: false; error: string }
> {
  const admin = await assertAdminFromSession().catch(() => null);
  if (!admin) return { ok: false, error: 'forbidden' };

  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  const res = await createInvite({
    email: parsed.data.email,
    invitedBy: admin.userId,
    notes: parsed.data.notes,
    expiresInDays: parsed.data.expires_in_days,
  });
  if (!res.ok) return { ok: false, error: res.error };

  return { ok: true, id: res.id, url: res.url, emailStatus: res.emailStatus };
}
