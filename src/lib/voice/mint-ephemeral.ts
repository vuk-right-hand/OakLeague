// Gemini ephemeral token mint. Called by both:
//   - `/api/voice/ephemeral-token` (Spike-A harness, admin-gated)
//   - `/api/sessions/open` (production, user-authed)
// Neither caller sees GEMINI_API_KEY. No auth guard inside — caller enforces
// before invocation. Writes the cogs_log audit row internally so the two
// callers can never drift on operation name / environment tag (R4-M1).
//
// Model arg is the hyphenated wire form (what Google accepts). Callers are
// responsible for wire→enum translation when persisting to `voice_model`
// columns. ALLOWED_MODELS is the authoritative allowlist — if Google ships a
// new preview string, bump model-map.ts AND this set (lockstep).

import 'server-only';
import { GoogleGenAI, Modality } from '@google/genai';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isAllowedWireModel } from './model-map';

const MINT_TIMEOUT_MS = 10_000;

export type MintEnv = 'spike_a' | 'production';

export class MintError extends Error {
  readonly code: 'model_not_allowed' | 'gemini_key_missing' | 'mint_timeout' | 'mint_failed' | 'mint_no_token';
  readonly httpStatus: number;
  constructor(code: MintError['code'], httpStatus: number, msg?: string) {
    super(msg ?? code);
    this.name = 'MintError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type MintEphemeralArgs = {
  wireModel: string;
  callerUserId: string;
  sessionId: string | null;
  env: MintEnv;
  ua?: string | null;
};

export type MintEphemeralResult = {
  token: string;
  model: string;
  expiresAt: string; // ISO; advisory — Google sets actual TTL server-side
};

export async function mintEphemeral(args: MintEphemeralArgs): Promise<MintEphemeralResult> {
  if (!isAllowedWireModel(args.wireModel)) {
    throw new MintError('model_not_allowed', 400);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new MintError('gemini_key_missing', 500);

  let token: { name?: string };
  try {
    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const mintPromise = client.authTokens.create({
      config: {
        uses: 1,
        liveConnectConstraints: {
          model: args.wireModel,
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
    token = (await Promise.race<unknown>([
      mintPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('mint_timeout')), MINT_TIMEOUT_MS)),
    ])) as { name?: string };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'mint_timeout') throw new MintError('mint_timeout', 504);
    throw new MintError('mint_failed', 502, msg);
  }

  if (!token?.name) throw new MintError('mint_no_token', 502);

  // Single source of truth for the mint audit row. env drives the bucket;
  // session_id is non-null in production, null in Spike-A harness.
  const admin = supabaseAdmin();
  await admin.from('cogs_log').insert({
    user_id: args.callerUserId,
    session_id: args.sessionId,
    service: 'gemini',
    operation: 'voice_ephemeral_token_mint',
    units: 1,
    unit_label: 'token',
    cost_usd: 0,
    environment: args.env,
    metadata: {
      source: args.env === 'spike_a' ? 'spike_a_harness' : 'sessions_open',
      model: args.wireModel,
      ua: (args.ua ?? '').slice(0, 256),
    },
  });

  return {
    token: token.name,
    model: args.wireModel,
    // Google doesn't echo TTL on mint response; advisory ~1 min is conservative.
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
