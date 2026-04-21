import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_MODELS = new Set([
  'gemini-3.1-flash-live-preview',
  'gemini-live-2.5-flash-native-audio',
]);

// AI Studio pricing (Gemini Live audio, 2026-04-21 docs):
//   3.1 / 2.5 native-audio input:  $0.30 / M tokens ≈ $0.005 / audio-min
//   3.1 / 2.5 native-audio output: $1.08 / M tokens ≈ $0.018 / audio-min
// Spike COGS is near-zero; exact rates are approximate, precision is Day 8 concern.
const PRICE_USD_PER_SEC = {
  input:  0.005 / 60,
  output: 0.018 / 60,
};

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

function expectedOrigin(): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!site) return null;
  try { return new URL(site).origin; } catch { return null; }
}

type Body = {
  model?: unknown;
  inputAudioSec?: unknown;
  outputAudioSec?: unknown;
  device?: unknown;
  ua?: unknown;
};

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 3600) return null;
  return v;
}

export async function POST(req: NextRequest) {
  if (req.headers.get('origin') !== expectedOrigin()) return json(403, { error: 'bad_origin' });

  let session;
  try {
    session = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return json(e.status, { error: e.message });
    throw e;
  }

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const model = typeof body.model === 'string' ? body.model : '';
  if (!ALLOWED_MODELS.has(model)) return json(400, { error: 'model_not_allowed' });

  const inSec  = num(body.inputAudioSec);
  const outSec = num(body.outputAudioSec);
  if (inSec == null || outSec == null) return json(400, { error: 'bad_durations' });

  const device = typeof body.device === 'string' ? body.device.slice(0, 64) : 'unknown';
  const ua     = typeof body.ua === 'string' ? body.ua.slice(0, 256) : '';

  const admin = supabaseAdmin();
  const rows = [
    {
      user_id: session.userId, session_id: null,
      service: 'gemini', operation: 'spike_a_live_audio_input_seconds',
      units: Number(inSec.toFixed(4)), unit_label: 'seconds',
      cost_usd: Number((inSec * PRICE_USD_PER_SEC.input).toFixed(6)),
      metadata: { source: 'spike_a', model, device, ua },
    },
    {
      user_id: session.userId, session_id: null,
      service: 'gemini', operation: 'spike_a_live_audio_output_seconds',
      units: Number(outSec.toFixed(4)), unit_label: 'seconds',
      cost_usd: Number((outSec * PRICE_USD_PER_SEC.output).toFixed(6)),
      metadata: { source: 'spike_a', model, device, ua },
    },
  ];
  const { error } = await admin.from('cogs_log').insert(rows);
  if (error) return json(500, { error: 'cogs_insert_failed', detail: error.message });
  return json(200, { ok: true });
}
