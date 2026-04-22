// Single typed helper for Avatar COGS writes. One definition of the operation
// string so spike and future production paths can never drift — matches the
// Spike A post-audit M7 drift pattern. See SPIKE_B_PLAN.md file item 8:
//
//   Do NOT route through cogs_insert_turn RPC. That RPC is voice-specific
//   and hardcodes voice_audio_{input,output}_seconds (migration 0045:181,187).
//   Spike B writes directly to cogs_log with operation='avatar_lipsync_seconds'
//   via service-role INSERT — the append-only trigger accepts service-role.

import 'server-only';
import type { AvatarProvider } from './avatar-bridge';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type InsertAvatarCogsArgs = {
  userId: string;
  provider: AvatarProvider;
  clampedCostUsd: number;
  durationSeconds: number;
  environment: 'spike_b' | 'production';
  metadata: Record<string, unknown>;
};

export async function insertAvatarCogs(args: InsertAvatarCogsArgs): Promise<void> {
  const admin = supabaseAdmin();
  const { error } = await admin.from('cogs_log').insert({
    user_id: args.userId,
    session_id: null, // Spike B never writes to public.sessions (plan decision 17)
    service: args.provider,
    operation: 'avatar_lipsync_seconds',
    units: Number(args.durationSeconds.toFixed(4)),
    unit_label: 'seconds',
    cost_usd: Number(args.clampedCostUsd.toFixed(6)),
    environment: args.environment,
    metadata: args.metadata,
  });
  if (error) throw new Error(`cogs_insert_failed: ${error.message}`);
}
