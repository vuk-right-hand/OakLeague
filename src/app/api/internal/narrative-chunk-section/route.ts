// /api/internal/narrative-chunk-section — v3 per-section Gemini Flash call.
//
// POST-only internal endpoint called by the Fly embed-worker during the v3
// reprocess pipeline, ONCE PER SECTION (AFTER /api/internal/segment and
// BEFORE per-chunk /api/internal/contextual-gen calls).
//
// Why a Next 15 route: narrative-chunk.ts (and now narrativeChunkSection)
// are `import 'server-only'` + Zod + responseSchema-bound. Single source of
// truth in TS; the Fly worker hits this route once per section.
//
// Differs from /api/internal/narrative-chunk (v2):
//   • Body carries `sanitized_section` (one section's text) instead of
//     `sanitized_doc` (whole sample). Caller bounds via section-segment.ts.
//   • Body carries optional `section_cue` (the structural marker that
//     started this section — markdown heading, "Chapter N", "[00:05:30]").
//     Forwarded to Flash for orientation.
//   • Response carries `section_title` + `section_summary` alongside units.
//     Worker writes both into sample_content_sections (title also used for
//     the routing-vector embed).
//
// Worker call shape:
//   POST /api/internal/narrative-chunk-section
//   Authorization: Bearer <INTERNAL_API_SECRET>
//   Content-Type: application/json
//   Body: {
//     creator_id:        uuid,
//     sample_id:         uuid,
//     section_index:     int,           // for logs / Sentry tagging
//     sanitized_section: string,
//     sample_title?:     string,
//     section_cue?:      string | null,
//   }
//
// Response (200 happy):
//   {
//     units:           [{title, text}, ...],
//     section_title:   string,
//     section_summary: string,
//     attempt:         1 | 2,
//     ms:              number,
//     usage:           { prompt_token_count, candidates_token_count, total_token_count },
//     request_id:      string,
//     retryable:       false
//   }
//
// Response (200 fallback — both Flash attempts failed schema/transport):
//   {
//     units:    null,
//     attempt:  2,
//     ms:       0,
//     message:  'fallback_to_skip_section',
//     request_id: string,
//     retryable:  false
//   }
//   Worker contract on `units: null`: skip THIS section, continue with
//   the rest (per-section idempotent re-embed = audit C5).

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import {
  narrativeChunkSection,
  NarrativeChunkError,
} from '@/lib/voice/narrative-chunk';
import { checkInternalAuth } from '@/lib/internal-api-auth';

export const runtime = 'nodejs';
// Module-internal Flash timeout is 30s; Vercel platform headroom 60s.
export const maxDuration = 60;

// One section is bounded by section-segment.ts at ≤ DEFAULT_SAFE_MAX_TOKENS
// (7500 ≈ 30K chars). Audit S7 — keep ceiling tight at 32K so a worker
// passing oversized input (which means section-segment.ts misbehaved) fails
// LOUD here at body validation, BEFORE we pay for a Flash call on garbage.
// Bump in lockstep with DEFAULT_SAFE_MAX_TOKENS if it ever rises.
const MAX_SECTION_CHARS = 32_000;

const RequestSchema = z.object({
  creator_id:        z.string().uuid(),
  sample_id:         z.string().uuid(),
  section_index:     z.number().int().min(0),
  sanitized_section: z.string().min(1).max(MAX_SECTION_CHARS),
  sample_title:      z.string().max(500).optional(),
  section_cue:       z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  // Audit M7 — Sentry tags AFTER auth check so unauthed probes don't farm
  // request_ids into our breadcrumbs.
  const authResp = checkInternalAuth(req, requestId, 'narrative-chunk-section');
  if (authResp) return authResp;
  Sentry.setTag('route', 'narrative-chunk-section');
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
  Sentry.setTag('section_index', String(parsed.data.section_index));

  try {
    const result = await narrativeChunkSection({
      sanitizedSection: parsed.data.sanitized_section,
      sampleTitle:      parsed.data.sample_title,
      sectionCue:       parsed.data.section_cue,
    });

    if (result === null) {
      // Both attempts failed. Worker contract per plan §8 step 4d: skip
      // THIS section + write a per-section error row so creator_v3_ready
      // (step 6) stays false until admin re-enqueue.
      return NextResponse.json(
        {
          units: null,
          attempt: 2,
          ms: 0,
          message: 'fallback_to_skip_section',
          request_id: requestId,
          retryable: false,
        },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    return NextResponse.json(
      {
        units:           result.units,
        section_title:   result.sectionTitle,
        section_summary: result.sectionSummary,
        attempt:         result.attempt,
        ms:              result.ms,
        usage:           result.usage,
        request_id:      requestId,
        retryable:       false,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof NarrativeChunkError) {
      switch (e.code) {
        case 'empty_input':
          return jsonError('empty_input', 400, requestId, {
            retryable: false,
            message: e.message,
          });
        case 'api_key_missing':
          console.error(
            '[narrative-chunk-section]', requestId, 'GEMINI_API_KEY missing',
          );
          Sentry.captureException(e, {
            level: 'fatal',
            tags: { request_id: requestId, stage: 'gemini_config' },
          });
          return jsonError('misconfigured', 500, requestId, {
            retryable: false,
            code: e.code,
          });
        default:
          Sentry.captureException(e, {
            level: 'error',
            tags: { request_id: requestId, stage: 'narrative_chunk_section_unexpected' },
          });
          return jsonError('narrative_chunk_section_error', 500, requestId, {
            retryable: true,
            code: e.code,
            message: e.message,
          });
      }
    }
    console.error('[narrative-chunk-section]', requestId, 'unexpected error:', e);
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
