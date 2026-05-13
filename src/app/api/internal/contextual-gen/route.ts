// /api/internal/contextual-gen — Anthropic Contextual Retrieval per-chunk
// context generation. POST-only internal endpoint called by the Fly
// embed-worker.
//
// Why a Next 15 route (not a Fly worker module):
//   The Anthropic SDK lives in TS-native context only. Audit-3 M5 + the
//   2026-05-09 `.ts` import bug on Fly's bundler made putting the SDK
//   behind a Fly worker too fragile. The 50ms Vercel hop is the cost of
//   keeping the SDK in a clean runtime.
//
// Worker call shape:
//   POST /api/internal/contextual-gen
//   Authorization: Bearer <INTERNAL_API_SECRET>
//   Content-Type: application/json
//   Body: {
//     creator_id: uuid,      // Day-4-audit C5: required for COGS + correlation
//     doc: string,           // pre-sanitized full sample text
//     chunk_text: string,    // pre-sanitized chunk
//     sample_title?: string  // Day-4-audit C4: now safe-to-vary per call
//   }
//
// Response (200):
//   {
//     chunk_context: string,
//     ms: number,
//     usage: { ... },
//     stop_reason: string | null,
//     request_id: string,        // Day-4-audit M9: our route-side correlation id
//     anthropic_request_id: string | null,
//     retryable: false           // success path = field present for shape symmetry
//   }
//
// Error responses (all carry { error, retryable, request_id }):
//   400 — invalid body / inputs too large / empty input         (retryable: false)
//   401 — bad bearer token                                       (retryable: false)
//   429 — Anthropic rate-limited us upstream                     (retryable: true, with retry-after)
//   500 misconfigured / upstream_auth_error                      (retryable: false)
//   500 anthropic_error                                          (retryable: true)
//   502 invalid_response                                         (retryable: true)
//   504 timeout                                                  (retryable: true)
//
// Caching contract:
//   The `doc` field bytes are the cache key. Worker MUST send byte-identical
//   `doc` across all chunk calls for the same sample within 1 hour to hit
//   the 1-hour-TTL cache. Any change (whitespace, sanitizer version drift)
//   = cache miss = 20× the cost. The embed-worker pre-sanitizes once per
//   sample and reuses the same string for every chunk. The `sample_title`
//   field is OUTSIDE the cached block (Day-4-audit C4) so it can vary
//   per call without breaking the cache.

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import {
  generateChunkContext,
  ContextualRetrievalError,
  MAX_DOC_CHARS,
  MAX_CHUNK_CHARS,
} from '@/lib/voice/contextual-retrieval';
import { AnthropicConfigError } from '@/lib/voice/anthropic-client';

// Force Node.js runtime — Anthropic SDK needs Node APIs (not Edge).
export const runtime = 'nodejs';
// Allow up to 60s for a single chunk-context call. Internal timeout is 30s
// in contextual-retrieval.ts; this is platform-level headroom.
export const maxDuration = 60;


// ── Auth ─────────────────────────────────────────────────────────────────
//
// Same constant-time pattern as /api/cron/cleanup-verifications.
// `INTERNAL_API_SECRET` is shared between Fly worker + Vercel route via env.

function getInternalSecret(): string {
  const s = process.env.INTERNAL_API_SECRET;
  if (!s || s.length < 32) {
    throw new Error('INTERNAL_API_SECRET missing or too short (>= 32 chars required)');
  }
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}


// ── Request schema ───────────────────────────────────────────────────────

const RequestSchema = z.object({
  // Day-4-audit C5: required for per-call COGS attribution + log
  // correlation. Day 5 worker passes `samples.creator_id`. Route uses for
  // logging today; actual budget enforcement layers on at Day 5 when the
  // worker integration lands.
  creator_id: z.string().uuid(),
  doc: z.string().min(1).max(MAX_DOC_CHARS),
  chunk_text: z.string().min(1).max(MAX_CHUNK_CHARS),
  sample_title: z.string().max(500).optional(),
});


// ── Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Day-4-audit M9: every request gets a UUID before any other work. We
  // include this in every log line, Sentry tag, and response body so the
  // worker can correlate "chunk N failed with code X" to a Vercel function
  // invocation and (when surfaced) a downstream Anthropic request id.
  const requestId = randomUUID();
  Sentry.setTag('route', 'contextual-gen');
  Sentry.setTag('request_id', requestId);

  // Auth FIRST. Fail-closed if env missing.
  let secret: string;
  try {
    secret = getInternalSecret();
  } catch (e) {
    // Day-4-audit C3: console.error doesn't auto-capture in @sentry/nextjs.
    // Explicit captureException puts the misconfig in Sentry's deduped
    // alerting where the on-call will actually see it.
    console.error('[contextual-gen]', requestId, 'INTERNAL_API_SECRET misconfigured:', (e as Error).message);
    Sentry.captureException(e, {
      level: 'fatal',
      tags: { request_id: requestId, stage: 'auth_env' },
    });
    return jsonError('misconfigured', 500, requestId, { retryable: false });
  }

  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (!constantTimeEqual(header, expected)) {
    return jsonError('unauthorized', 401, requestId, { retryable: false });
  }

  // Body parse + validate.
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

  // Tag creator_id for downstream Sentry correlation.
  Sentry.setTag('creator_id', parsed.data.creator_id);

  // Call the library. Map errors to status codes.
  try {
    const result = await generateChunkContext({
      sanitizedDoc: parsed.data.doc,
      sanitizedChunk: parsed.data.chunk_text,
      sampleTitle: parsed.data.sample_title,
    });
    return NextResponse.json(
      {
        chunk_context: result.chunkContext,
        ms: result.ms,
        usage: result.usage,
        stop_reason: result.stopReason ?? null,
        request_id: requestId,
        anthropic_request_id: result.requestId ?? null,
        retryable: false,
      },
      {
        status: 200,
        // Defense-in-depth: never want a CDN or proxy caching POST results.
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (e) {
    if (e instanceof ContextualRetrievalError) {
      // Map our taxonomy to HTTP statuses. The `retryable` flag is on the
      // error itself (Day-4-audit C2) — single source of truth.
      switch (e.code) {
        case 'empty_input':
        case 'input_too_large':
          return jsonError(e.code, 400, requestId, {
            retryable: e.retryable,
            message: e.message,
            anthropic_request_id: e.requestId ?? null,
          });
        case 'rate_limit': {
          // Day-4-audit M6: surface Anthropic's Retry-After both as an HTTP
          // header AND in the response body so the worker can back off
          // without re-parsing headers from a SDK error it never sees.
          const extraHeaders: Record<string, string> = { 'cache-control': 'no-store' };
          if (e.retryAfterMs !== undefined) {
            extraHeaders['retry-after'] = String(Math.ceil(e.retryAfterMs / 1000));
          }
          return NextResponse.json(
            {
              error: 'rate_limit',
              retryable: e.retryable,
              request_id: requestId,
              anthropic_request_id: e.requestId ?? null,
              retry_after_ms: e.retryAfterMs ?? null,
              message: e.message,
            },
            { status: 429, headers: extraHeaders },
          );
        }
        case 'auth_error':
          // Anthropic returned 401/403 — our key is bad/revoked. NOT a
          // client auth issue. Surface as 500 with retryable:false so the
          // worker BACKS OFF instead of retry-storming a permanently dead key.
          console.error(
            '[contextual-gen]', requestId,
            'Anthropic auth_error (key likely revoked):',
            e.message,
          );
          Sentry.captureException(e, {
            level: 'error',
            tags: { request_id: requestId, stage: 'anthropic_auth' },
          });
          return jsonError('upstream_auth_error', 500, requestId, {
            retryable: false,  // Day-4-audit C2 + auditor's primary concern.
            anthropic_request_id: e.requestId ?? null,
          });
        case 'timeout':
          return jsonError('timeout', 504, requestId, {
            retryable: e.retryable,
            message: e.message,
          });
        case 'invalid_response':
          return jsonError('invalid_response', 502, requestId, {
            retryable: e.retryable,
            message: e.message,
            anthropic_request_id: e.requestId ?? null,
          });
        case 'anthropic_error':
        default:
          // 5xx from Anthropic or unknown SDK error — let the worker retry.
          Sentry.captureException(e, {
            level: 'warning',
            tags: { request_id: requestId, stage: 'anthropic_generate' },
          });
          return jsonError('anthropic_error', 500, requestId, {
            retryable: e.retryable,
            message: e.message,
            status: e.status,
            anthropic_request_id: e.requestId ?? null,
          });
      }
    }
    if (e instanceof AnthropicConfigError) {
      // Module-level misconfig — model/key. Log loud, return 500. Worker
      // should NOT retry on this (every call will fail until env fixed).
      console.error('[contextual-gen]', requestId, 'AnthropicConfigError:', e.code, e.message);
      Sentry.captureException(e, {
        level: 'fatal',
        tags: { request_id: requestId, stage: 'anthropic_config' },
      });
      return jsonError('misconfigured', 500, requestId, {
        retryable: false,
        code: e.code,
      });
    }
    // Unknown — log full + Sentry + return 500 with retryable:true (assume
    // transient until we know otherwise).
    console.error('[contextual-gen]', requestId, 'unexpected error:', e);
    Sentry.captureException(e, {
      level: 'error',
      tags: { request_id: requestId, stage: 'unknown' },
    });
    return jsonError('internal_error', 500, requestId, { retryable: true });
  }
}


// ── Response helpers ─────────────────────────────────────────────────────
//
// All error responses share shape: { error, retryable, request_id, ... }.
// Centralized so we can't drift between branches.

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
