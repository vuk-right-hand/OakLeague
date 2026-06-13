// POST /creator/api/voice-script (WS4) — server-generated 4-sentence recording
// script for creator voice cloning. One sentence per core emotion
// (neutral / excited / serious / warm) drawn from server-side phrase banks.
//
// Replay-resistance + recording guidance ONLY — NOT a liveness check (audit
// M2: a malicious creator can have anyone read it; the real control is
// invite-only vetting). The clone route requires a script row ≤30min old and
// stamps used_at single-use inside the finalize txn.

import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isSameOrigin } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Phrase banks — neutral, declarative sentences a creator can read naturally.
// Kept generic (no names, no PII) so any creator can read any line. Each pull
// picks one per emotion → a unique-feeling 4-line script per request.
const BANKS: Record<'neutral' | 'excited' | 'serious' | 'warm', string[]> = {
  neutral: [
    'The morning light came in slowly across the quiet kitchen table.',
    'I usually plan the week on Sunday and adjust it as I go.',
    'There are three things I check before I start any new project.',
    'The map showed a shorter route along the river to the old bridge.',
    'Most of my notes live in a single file I reread every Friday.',
  ],
  excited: [
    'This is honestly the best part of the whole thing — I can not wait to show you!',
    'We hit the goal a full week early, and the team went absolutely wild!',
    'You are going to love where this goes next, I promise you that!',
    'I jumped out of my chair when the results finally came through!',
    'Wait until you see what happens when these two ideas come together!',
  ],
  serious: [
    'If we ignore this now, the cost only grows, and it grows fast.',
    'I need you to understand exactly what is at stake before we decide.',
    'There is no shortcut here; the work has to be done properly.',
    'Be honest with yourself about the numbers, even when they hurt.',
    'This is the moment where most people quit, and that is the mistake.',
  ],
  warm: [
    'Take your time with it — I am right here, and we will figure it out together.',
    'I am genuinely proud of how far you have come these last few months.',
    'Thank you for trusting me with this; it means more than you know.',
    'Whatever happens today, you have already done the hard part.',
    'Come sit down, tell me everything, and let us sort it out slowly.',
  ],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function POST(req: NextRequest): Promise<Response> {
  let session: { userId: string; creatorId: string };
  try {
    session = await assertCreatorFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'bad_origin' }, { status: 403 });
  }

  const sb = supabaseAdmin();

  // 10/min per creator — "Generate new" calls this again.
  const { data: allowed, error: rlErr } = await sb.rpc('rate_limit_hit', {
    p_scope: 'creator_voice_script',
    p_key: session.userId,
    p_window: '1 minute',
    p_limit: 10,
  });
  if (rlErr) return NextResponse.json({ error: 'rate_check_failed' }, { status: 500 });
  if (allowed === false) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const sentences = [
    { emotion: 'neutral', text: pick(BANKS.neutral) },
    { emotion: 'excited', text: pick(BANKS.excited) },
    { emotion: 'serious', text: pick(BANKS.serious) },
    { emotion: 'warm', text: pick(BANKS.warm) },
  ];

  const { data, error } = await sb
    .from('voice_clone_scripts')
    .insert({ creator_id: session.creatorId, sentences })
    .select('id')
    .single<{ id: string }>();
  if (error) return NextResponse.json({ error: 'script_insert_failed' }, { status: 500 });

  return NextResponse.json({ scriptId: data.id, sentences });
}
