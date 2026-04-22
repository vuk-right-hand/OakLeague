import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { GoogleGenAI, Modality } from '@google/genai';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_MODELS = new Set([
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
]);

const MINT_TIMEOUT_MS = 10_000;

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

// Same-origin check, honoring x-forwarded-host for TLS-terminating tunnels
// (ngrok in dev, any reverse proxy in prod). See .claude_learnings.md
// 2026-04-21 "ngrok HTTPS → Next dev HTTP".
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

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  let session;
  try {
    session = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return json(e.status, { error: e.message });
    throw e;
  }

  let body: { model?: unknown };
  try {
    body = (await req.json()) as { model?: unknown };
  } catch {
    return json(400, { error: 'bad_json' });
  }
  const model = typeof body.model === 'string' ? body.model : '';
  if (!ALLOWED_MODELS.has(model)) {
    return json(400, { error: 'model_not_allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(500, { error: 'gemini_key_missing' });

  let token;
  try {
    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const mintPromise = client.authTokens.create({
      config: {
        uses: 1,
        liveConnectConstraints: {
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: 'You are a helpful mentor. Answer in one concise sentence.',
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          },
        },
      },
    });
    // Suppress unhandled rejection if the timeout leg wins the race.
    mintPromise.catch(() => {});
    token = await Promise.race<unknown>([
      mintPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('mint_timeout')), MINT_TIMEOUT_MS)),
    ]) as { name?: string };
  } catch (e) {
    const msg = (e as Error).message;
    return json(msg === 'mint_timeout' ? 504 : 502, { error: 'mint_failed' });
  }

  if (!token?.name) return json(502, { error: 'mint_no_token' });

  const admin = supabaseAdmin();
  const ua = req.headers.get('user-agent') ?? '';
  await admin.from('cogs_log').insert({
    user_id: session.userId,
    session_id: null,
    service: 'gemini',
    operation: 'voice_ephemeral_token_mint',
    units: 1,
    unit_label: 'token',
    cost_usd: 0,
    environment: 'spike_a',
    metadata: { source: 'spike_a_harness', model, ua: ua.slice(0, 256) },
  });

  return json(200, { token: token.name });
}
