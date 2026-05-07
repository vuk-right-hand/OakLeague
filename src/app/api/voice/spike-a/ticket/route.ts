import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ticket-based WS auth (plan §Ticket-based WS auth). Cookies don't cross the
// WS upgrade boundary (C2), so we mint a short-lived UA-hash-bound ticket here
// and the Fly proxy atomically consumes it on WS upgrade.

function json(status: number, body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const forwardedHost = req.headers.get('x-forwarded-host');
    const reqHost = forwardedHost ?? req.nextUrl.host;
    return originHost === reqHost;
  } catch {
    return false;
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  let session;
  try {
    session = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return json(e.status, { error: e.message });
    throw e;
  }

  const ua = req.headers.get('user-agent') ?? '';
  if (ua.length < 1 || ua.length > 2048) return json(400, { error: 'bad_ua' });
  const uaHash = sha256Hex(ua);

  // creator_id is required: proxy no longer guesses "first creator". If
  // unspecified, fall back to the caller's own creator row (if they are one) —
  // covers the spike-founder-is-the-only-creator case without a hardcode.
  let body: { creatorId?: unknown } = {};
  try {
    const raw = await req.text();
    body = raw ? (JSON.parse(raw) as { creatorId?: unknown }) : {};
  } catch { return json(400, { error: 'bad_json' }); }

  const admin = supabaseAdmin();

  let creatorId: string | null = null;
  if (typeof body.creatorId === 'string' && UUID_RE.test(body.creatorId)) {
    creatorId = body.creatorId;
  } else {
    const { data: ownCreator } = await admin
      .from('creators')
      .select('id')
      .eq('user_id', session.userId)
      .maybeSingle<{ id: string }>();
    if (ownCreator) creatorId = ownCreator.id;
  }
  if (!creatorId) return json(400, { error: 'creator_id_required' });

  // Validate creator exists. RLS would filter by publish state for anon reads
  // but service role sees all; explicit select keeps the check self-contained.
  const { data: validCreator, error: creatorErr } = await admin
    .from('creators')
    .select('id')
    .eq('id', creatorId)
    .maybeSingle<{ id: string }>();
  if (creatorErr) {
    Sentry.captureException(creatorErr, { extra: { op: 'voice_ticket_creator_lookup' } });
    return json(500, { error: 'creator_lookup_failed' });
  }
  if (!validCreator) return json(400, { error: 'creator_not_found' });

  // Rate limit: at most 5 live (unconsumed + unexpired) tickets per user.
  // Tickets are 30s TTL, so a normal flow has 1 outstanding. 5+ means a loop.
  const { count: liveCount, error: countErr } = await admin
    .from('voice_tickets')
    .select('ticket_id', { count: 'exact', head: true })
    .eq('user_id', session.userId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString());
  if (countErr) {
    console.error('[voice-ticket] count failed', countErr);
    Sentry.captureException(countErr, { extra: { op: 'voice_ticket_count' } });
    return json(500, { error: 'ticket_mint_failed', code: countErr.code ?? 'count_fail' });
  }
  if ((liveCount ?? 0) >= 5) return json(429, { error: 'too_many_tickets' });

  // Probabilistic GC: 10% of mints sweep rows older than 1h. Keeps table bounded
  // without a cron dependency. Full ghost-reap is in proxy's reap_stale_sessions RPC.
  if (Math.random() < 0.1) {
    const cutoff = new Date(Date.now() - 3600_000).toISOString();
    await admin.from('voice_tickets').delete().lt('created_at', cutoff);
  }

  // avatar_provider is REQUIRED on voice_session tickets since migration
  // 20260509000001 (CHECK voice_tickets_avatar_provider_purpose_match).
  // Spike-A is a voice-pin measurement harness — no avatar — but the
  // ticket purpose still defaults to 'voice_session'. Pass 'simli' as a
  // benign default so the proxy's per-session rate selection picks 16k
  // (matches the legacy attach-path behavior pre-migration). Without
  // this, every spike-a mint 500s with SQLSTATE 23514. (Post-build audit C4.)
  const { data, error } = await admin
    .from('voice_tickets')
    .insert({
      user_id: session.userId,
      bound_ua_hash: uaHash,
      creator_id: creatorId,
      avatar_provider: 'simli',
    })
    .select('ticket_id, expires_at')
    .single<{ ticket_id: string; expires_at: string }>();

  if (error || !data) {
    console.error('[voice-ticket] mint failed', error);
    Sentry.captureException(error ?? new Error('ticket_mint_no_row'), {
      extra: { op: 'voice_ticket_mint', code: error?.code, hint: error?.hint },
    });
    return json(500, { error: 'ticket_mint_failed', code: error?.code ?? 'no_row' });
  }

  return json(200, { ticket: data.ticket_id, expiresAt: data.expires_at });
}
