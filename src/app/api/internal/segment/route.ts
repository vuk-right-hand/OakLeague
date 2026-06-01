// /api/internal/segment — pure-text section segmentation for the v3 worker.
//
// POST-only internal endpoint called by the Fly embed-worker during the v3
// reprocess pipeline, BEFORE /api/internal/narrative-chunk-section.
//
// Why a Next 15 route (not the worker importing section-segment.ts directly):
//   section-segment.ts is `import 'server-only'` (Next.js compile-time
//   barrier). The Fly worker runs on plain Node; importing the .ts file
//   would require a build pipeline the worker doesn't have. Single source
//   of truth in TS; worker hits this route once per sample and gets back
//   the sections.
//
// Worker call shape:
//   POST /api/internal/segment
//   Authorization: Bearer <INTERNAL_API_SECRET>
//   Content-Type: application/json
//   Body: {
//     creator_id:    uuid,
//     sample_id:     uuid,
//     sanitized_doc: string,
//     cue_mode?:     'auto' | 'book' | 'transcript',
//     target_tokens?:    number,
//     safe_max_tokens?:  number,
//     chars_per_token?:  number,
//   }
//
// Response (200):
//   {
//     sections: [{ text, charStart, charEnd, estTokens, cue, mode }, ...],
//     mode:     'structural' | 'paragraph-packed',
//     oversize: number,
//     request_id: string,
//   }

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { segmentDocument } from '@/lib/voice/section-segment';
import { checkInternalAuth } from '@/lib/internal-api-auth';

export const runtime = 'nodejs';
// Pure-text segmentation is fast (no LLM). 30s headroom is plenty for
// even pathologically large inputs.
export const maxDuration = 30;

// Match section-segment / contextual-gen / narrative-chunk caps. Plan §3
// COGS model assumes per-creator-sample size bounded; a worker passing more
// than 400K chars (~100K tokens) is upstream-buggy.
const MAX_DOC_CHARS = 400_000;

const RequestSchema = z.object({
  creator_id:      z.string().uuid(),
  sample_id:       z.string().uuid(),
  sanitized_doc:   z.string().min(1).max(MAX_DOC_CHARS),
  cue_mode:        z.enum(['auto', 'book', 'transcript']).optional(),
  target_tokens:   z.number().int().positive().max(32_000).optional(),
  safe_max_tokens: z.number().int().positive().max(32_000).optional(),
  chars_per_token: z.number().positive().max(20).optional(),
});

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  // Audit M7 — Sentry tags AFTER auth check so unauthed probes don't farm
  // request_ids into our breadcrumbs.
  const authResp = checkInternalAuth(req, requestId, 'segment');
  if (authResp) return authResp;
  Sentry.setTag('route', 'segment');
  Sentry.setTag('request_id', requestId);

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
  Sentry.setTag('sample_id', parsed.data.sample_id);

  try {
    const result = segmentDocument(parsed.data.sanitized_doc, {
      cueMode: parsed.data.cue_mode,
      targetTokens: parsed.data.target_tokens,
      safeMaxTokens: parsed.data.safe_max_tokens,
      charsPerToken: parsed.data.chars_per_token,
    });
    return NextResponse.json(
      {
        sections: result.sections,
        mode: result.mode,
        oversize: result.oversize,
        request_id: requestId,
        retryable: false,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    console.error('[segment]', requestId, 'unexpected error:', e);
    Sentry.captureException(e, {
      level: 'error',
      tags: { request_id: requestId, stage: 'segment_unexpected' },
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
