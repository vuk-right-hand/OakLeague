'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

const Input = z.object({
  goals: z.array(z.string().min(1).max(200)).min(1).max(5),
  obstacles: z.array(z.string().min(1).max(200)).max(5).default([]),
  timezone: z.string().min(1).max(100),
  next: z.string().max(500),
});

function safeNext(n: string): string {
  if (!n.startsWith('/') || n.startsWith('//')) return '/';
  return n;
}

export async function saveOnboarding(
  input: unknown,
): Promise<{ ok: true; next: string } | { ok: false; error: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };

  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  // Whitelist — never spread `input`.
  const patch = {
    goals: parsed.data.goals,
    obstacles: parsed.data.obstacles,
    timezone: parsed.data.timezone,
    onboarded_at: new Date().toISOString(),
  };

  const supabase = await supabaseServer();
  const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
  if (error) return { ok: false, error: 'save_failed' };

  revalidatePath('/');
  return { ok: true, next: safeNext(parsed.data.next) };
}
