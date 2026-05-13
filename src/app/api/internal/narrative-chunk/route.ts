// /api/internal/narrative-chunk — Gemini Flash narrative chunking. POST-only
// internal endpoint called by the Fly embed-worker during the v2 reprocess
// pipeline, AFTER /api/internal/preprocess and BEFORE per-chunk
// /api/internal/contextual-gen calls.
//
// Why a Next 15 route (instead of running narrative-chunk.ts in the worker):
//   narrative-chunk.ts is `import 'server-only'` and uses Zod for response
//   validation. Re-implementing in JS would duplicate the Zod schema and
//   the strict retry contract. Single source of truth in TS; worker hits
//   this route once per sample and gets back the narrative units.
//
// Worker call shape:
//   POST /api/internal/narrative-chunk
//   Authorization: Bearer <INTERNAL_API_SECRET>
//   Content-Type: application/json
//   Body: { creator_id: uuid, sanitized_doc: string, sample_title?: string }
//
// Response (200 happy):
//   { units: [{title, text}, ...], attempt: 1|2, ms: number, usage: {prompt_token_count, candidates_token_count, total_token_count}, request_id: string, retryable: false }
//
// Response (200 fallback — narrative-chunk returned null after retry):
//   { units: null, attempt: 2, ms: number, request_id: string, retryable: false, message: 'fallback_to_v1_chunker' }
//
// Errors (all carry { error, retryable, request_id }):
//   400 — invalid body                       (retryable: false)
//   401 — bad bearer                         (retryable: false)
//   500 — empty_input / api_key_missing / unknown
//   504 — caller-imposed timeout (none here; module has its own)

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import {
  narrativeChunk,
  NarrativeChunkError,
} from '@/lib/voice/narrative-chunk';
import { checkInternalAuth } from '@/lib/internal-api-auth';

export const runtime = 'nodejs';
// Module-internal Flash timeout is 30s; Vercel platform headroom 60s.
export const maxDuration = 60;

const MAX_DOC_CHARS = 400_000;

const RequestSchema = z.object({
  creator_id:    z.string().uuid(),
  sanitized_doc: z.string().min(1).max(MAX_DOC_CHARS),
  sample_title:  z.string().max(500).optional(),
});


export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  Sentry.setTag('route', 'narrative-chunk');
  Sentry.setTag('request_id', requestId);

  const authResp = checkInternalAuth(req, requestId, 'narrative-chunk');
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
    const result = await narrativeChunk({
      sanitizedDocument: parsed.data.sanitized_doc,
      sampleTitle: parsed.data.sample_title,
    });

    if (result === null) {
      // Both attempts failed. Worker contract: fall back to v1 chunker for
      // this sample. retryable:false because retrying THIS route won't help
      // (Flash already returned bad output twice). The worker decides
      // independently to retry the WHOLE sample later if it wants.
      return NextResponse.json(
        {
          units: null,
          attempt: 2,
          ms: 0,
          message: 'fallback_to_v1_chunker',
          request_id: requestId,
          retryable: false,
        },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    return NextResponse.json(
      {
        units: result.units,
        attempt: result.attempt,
        ms: result.ms,
        // Day-5-audit C2: forward Flash usage so the worker writes cogs_log
        // under service='gemini', operation='narrative_chunk'.
        usage: result.usage,
        request_id: requestId,
        retryable: false,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof NarrativeChunkError) {
      // The lib only throws on api_key_missing or empty_input (it returns
      // null on the recoverable codes). Both are terminal — worker stops
      // retrying THIS sample.
      switch (e.code) {
        case 'empty_input':
          return jsonError('empty_input', 400, requestId, {
            retryable: false,
            message: e.message,
          });
        case 'api_key_missing':
          // Misconfigured deploy — same severity as INTERNAL_API_SECRET
          // missing. Sentry-fatal so on-call alerts.
          console.error('[narrative-chunk]', requestId, 'GEMINI_API_KEY missing');
          Sentry.captureException(e, {
            level: 'fatal',
            tags: { request_id: requestId, stage: 'gemini_config' },
          });
          return jsonError('misconfigured', 500, requestId, {
            retryable: false,
            code: e.code,
          });
        default:
          // Defensive — shouldn't reach here from the lib.
          Sentry.captureException(e, {
            level: 'error',
            tags: { request_id: requestId, stage: 'narrative_chunk_unexpected' },
          });
          return jsonError('narrative_chunk_error', 500, requestId, {
            retryable: true,
            code: e.code,
            message: e.message,
          });
      }
    }
    console.error('[narrative-chunk]', requestId, 'unexpected error:', e);
    Sentry.captureException(e, {
      level: 'error',
      tags: { request_id: requestId, stage: 'unknown' },
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
