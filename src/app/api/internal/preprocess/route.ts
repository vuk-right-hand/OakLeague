// /api/internal/preprocess — canonical sanitize + slide-strip for sample
// raw_text. POST-only internal endpoint called by the Fly embed-worker
// during the v2 reprocess pipeline.
//
// Why a Next 15 route (instead of duplicating preprocess.ts in JS):
//   preprocess.ts is `import 'server-only'` and uses Unicode-aware regex
//   passes (NFKD, combining-mark strip, envelope-tag fixed-point) that
//   are non-trivial to keep in sync between TS and JS. Single source of
//   truth: TS. Worker calls this route once per sample before chunking.
//
// The returned `sanitized_text` is the CANONICAL byte representation that
// the worker passes to narrative-chunk + contextual-gen. The
// /api/internal/contextual-gen 1-hour cache hits ONLY if the same bytes
// arrive on every chunk call — sanitizing ONCE per sample and reusing the
// returned bytes is the contract that keeps cache costs ~$0.03 instead
// of ~$2.50 per 1000-chunk sample.
//
// Worker call shape:
//   POST /api/internal/preprocess
//   Authorization: Bearer <INTERNAL_API_SECRET>
//   Content-Type: application/json
//   Body: { creator_id: uuid, raw_text: string }
//
// Response (200):
//   { sanitized_text: string, ms: number, request_id: string, retryable: false }
//
// Error responses (all carry { error, retryable, request_id }):
//   400 — invalid body / oversize input    (retryable: false)
//   401 — bad bearer token                 (retryable: false)
//   500 — misconfigured / internal_error   (retryable depends on cause)

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { preprocessRawTextWithReport } from '@/lib/voice/preprocess';
import { checkInternalAuth } from '@/lib/internal-api-auth';

export const runtime = 'nodejs';
// Sanitize is pure CPU; cap at 30s — anything longer means an absurd input
// or a regex pathological case worth investigating.
export const maxDuration = 30;

// Hard cap on raw_text. Worker shouldn't send more; we won't process more.
// Matches what the chunker / Anthropic Day-4 route accept on the downstream side.
const MAX_RAW_TEXT_CHARS = 400_000;

const RequestSchema = z.object({
  creator_id: z.string().uuid(),
  raw_text: z.string().min(1).max(MAX_RAW_TEXT_CHARS),
});


export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  Sentry.setTag('route', 'preprocess');
  Sentry.setTag('request_id', requestId);

  const authResp = checkInternalAuth(req, requestId, 'preprocess');
  if (authResp) return authResp;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('invalid_json', 400, requestId, { retryable: false });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError('invalid_body', 400, requestId, {
      retryable: false,
      details: parsed.error.issues.slice(0, 5),
    });
  }

  Sentry.setTag('creator_id', parsed.data.creator_id);

  try {
    const t0 = Date.now();
    // preprocessRawTextWithReport composes stripSlideMarkers →
    // sanitizeForLLMPrompt → L0 (P0-5/P1-7 index-time injection
    // neutralization). Pure CPU. Idempotent — calling it on
    // already-sanitized text returns the same bytes (the route's
    // defensive-re-call contract; L0's MIDDLE-DOT defang no longer
    // matches its bare-letter pattern). `.text` is the CANONICAL byte
    // representation the worker passes to narrative-chunk + contextual-gen.
    const { text: sanitized, injectionNeutralized, injectionCategories } =
      preprocessRawTextWithReport(parsed.data.raw_text);
    const ms = Date.now() - t0;

    // Defensive: if the STRUCTURAL sanitizer stripped everything to
    // whitespace, surface an explicit 400 — caller can mark the sample
    // fetch_status='errored'. (Combined-audit M4: L0 cannot reach this
    // path — it only ever INSERTS a U+00B7, never deletes, so it cannot
    // turn non-empty input empty. The empty case is purely structural.)
    if (!sanitized || sanitized.trim().length === 0) {
      return jsonError('empty_after_sanitize', 400, requestId, {
        retryable: false,
        message: 'raw_text was empty or pure structural noise after sanitization',
      });
    }

    // L0 scan signal — verified best practice is data-provenance +
    // operator VISIBILITY, not silent sanitize. A poisoned sample is
    // still processed (neutralized in place, never rejected — north-star
    // voice fidelity), but a heavily-poisoned corpus is surfaced to
    // Sentry so an admin can review the source before it ships.
    if (injectionNeutralized > 0) {
      // Tag rides any later Sentry event in this request; the durable
      // provenance is the response field below (the embed-worker
      // persists it for admin review). console.warn is the always-on
      // operator trail. Deliberately NOT a per-sample Sentry event — an
      // initial reprocess of adversarial-quoting content would be noisy;
      // visibility is proportionate (tag + log + persisted count).
      Sentry.setTag('l0_injection_neutralized', String(injectionNeutralized));
      console.warn(
        `[preprocess] ${requestId} L0 neutralized ${injectionNeutralized} injection span(s) ` +
          `(creator=${parsed.data.creator_id} categories=${injectionCategories.join(',')})`,
      );
    }

    return NextResponse.json(
      {
        sanitized_text: sanitized,
        ms,
        request_id: requestId,
        retryable: false,
        // P1-7 — scan signal echoed so the embed-worker can persist it
        // alongside the sample (corpus provenance / admin review).
        injection_neutralized: injectionNeutralized,
        injection_categories: injectionCategories,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    console.error('[preprocess]', requestId, 'unexpected error:', e);
    Sentry.captureException(e, {
      level: 'error',
      tags: { request_id: requestId, stage: 'preprocess_call' },
    });
    return jsonError('internal_error', 500, requestId, { retryable: true });
  }
}


function jsonError(
  error: string,
  status: number,
  requestId: string,
  extras: Record<string, unknown> & { retryable: boolean },
): NextResponse {
  return NextResponse.json(
    { error, request_id: requestId, ...extras },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
