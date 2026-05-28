// /api/internal/retrieve-knowledge route tests (Day-13).
//
// Coverage:
//   Auth (HMAC):
//     1. Missing INTERNAL_API_SECRET env → 500 misconfigured
//     2. Missing/short headers → 401 unauthorized
//     3. Stale timestamp (outside ±60s) → 401 unauthorized
//     4. Mismatched body bytes vs signed hash → 401 unauthorized
//     5. Wrong secret on verify → 401 unauthorized
//     6. Round-trip with valid signature → proceeds past auth
//   Body validation:
//     7. Invalid JSON → 400 invalid_json
//     8. Missing required field → 400 invalid_body
//     9. Oversize last_assistant_response → 400 invalid_body
//   Session ownership re-derivation (audit M5):
//    10. session_id not found → 403 session_not_found
//    11. session.user_id !== body.user_id → 403 session_user_mismatch
//    12. session.creator_id !== body.creator_id → 403 session_creator_mismatch
//    13. session.ended_at not null → 409 session_ended
//    14. session.retrieval_version_at_session !== 2 → 409 wrong_retrieval_version
//   Budget clamping (audit C4):
//    15. budget_ms below MIN clamped up; orchestrator sees floor
//    16. budget_ms above MAX clamped down
//   Happy path:
//    17. Returns parents[] with snake_case keys + telemetry + budget_exceeded
//        + rewrite_fallback + request_id
//   Orchestrator errors:
//    18. empty_utterance → 400
//    19. deadline_exceeded → 504, retryable:false (audit M3)
//    20. embed_failed → 500
//
// Approach: mock retrieveKnowledgeV2 + supabaseAdmin so we can drive the
// HTTP-boundary logic without real DB or provider calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockRetrieveV2, mockRetrieveV3, mockSentryCapture, mockSentryCaptureMessage, mockSentrySetTag, mockSessionSelect } = vi.hoisted(() => ({
  mockRetrieveV2: vi.fn(),
  mockRetrieveV3: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockSentryCaptureMessage: vi.fn(),
  mockSentrySetTag: vi.fn(),
  mockSessionSelect: vi.fn(),
}));

vi.mock('@/lib/voice/retrieve-knowledge', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/retrieve-knowledge')>(
    '@/lib/voice/retrieve-knowledge',
  );
  return {
    ...actual,
    retrieveKnowledgeV2: mockRetrieveV2,
    retrieveKnowledgeV3: mockRetrieveV3,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  captureMessage: mockSentryCaptureMessage,
  setTag: mockSentrySetTag,
  setContext: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockSessionSelect,
        }),
      }),
    }),
  }),
}));

import { POST } from './route';
import { RetrieveKnowledgeV2Error } from '@/lib/voice/retrieve-knowledge';
import { signRequest, INTERNAL_SECRET_MIN_LENGTH } from '@/lib/voice/internal-request-signature';

const VALID_SECRET = 'a'.repeat(INTERNAL_SECRET_MIN_LENGTH);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PATH = '/api/internal/retrieve-knowledge';

beforeEach(() => {
  mockRetrieveV2.mockReset();
  mockRetrieveV3.mockReset();
  mockSentryCapture.mockReset();
  mockSentryCaptureMessage.mockReset();
  mockSentrySetTag.mockReset();
  mockSessionSelect.mockReset();
  process.env.INTERNAL_API_SECRET = VALID_SECRET;
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.VOYAGE_API_KEY = 'voyage-test';

  // Default: session exists, owned by claimed user/creator, v2.
  mockSessionSelect.mockResolvedValue({
    data: {
      user_id: USER_ID,
      creator_id: CREATOR_ID,
      corpus_version_at_session: 1,
      retrieval_version_at_session: 2,
      ended_at: null,
    },
    error: null,
  });
});

afterEach(() => {
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.GEMINI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  vi.restoreAllMocks();
});

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    creator_id: CREATOR_ID,
    session_id: SESSION_ID,
    raw_utterance: 'tell me about discipline',
    last_assistant_response: null,
    corpus_version_at_session: 1,
    budget_ms: 4000,
    ...overrides,
  };
}

function mkSignedReq(opts: {
  bodyOverrides?: Record<string, unknown>;
  bodyText?: string;
  tamperHeaders?: Partial<Record<'authorization' | 'x-internal-timestamp' | 'x-internal-body-sha256', string | null>>;
  timestampSec?: number;
  signWith?: string;
}): NextRequest {
  const body =
    opts.bodyText !== undefined
      ? opts.bodyText
      : JSON.stringify(makeBody(opts.bodyOverrides));
  const signed = signRequest({
    secret: opts.signWith ?? VALID_SECRET,
    method: 'POST',
    path: PATH,
    bodySerialized: body,
    timestampSec: opts.timestampSec,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: signed.Authorization,
    'x-internal-timestamp': signed['X-Internal-Timestamp'],
    'x-internal-body-sha256': signed['X-Internal-Body-Sha256'],
  };
  for (const [k, v] of Object.entries(opts.tamperHeaders ?? {})) {
    if (v === null) delete headers[k];
    else if (typeof v === 'string') headers[k] = v;
  }
  return new Request(`http://localhost${PATH}`, {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

// ── Auth ─────────────────────────────────────────────────────────────────

describe('POST /api/internal/retrieve-knowledge — auth', () => {
  it('returns 500 misconfigured when INTERNAL_API_SECRET unset', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('misconfigured');
  });

  it('returns 401 when signature headers missing', async () => {
    const res = await POST(mkSignedReq({ tamperHeaders: { authorization: null } }));
    expect(res.status).toBe(401);
  });

  it('returns 401 on stale timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await POST(mkSignedReq({ timestampSec: now - 300 })); // 5 min old
    expect(res.status).toBe(401);
  });

  it('returns 401 when body bytes differ from signed hash', async () => {
    const goodBody = JSON.stringify(makeBody());
    const tamperedBody = JSON.stringify({ ...makeBody(), raw_utterance: 'TAMPERED' });
    const signed = signRequest({
      secret: VALID_SECRET,
      method: 'POST',
      path: PATH,
      bodySerialized: goodBody,
    });
    const req = new Request(`http://localhost${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: signed.Authorization,
        'x-internal-timestamp': signed['X-Internal-Timestamp'],
        'x-internal-body-sha256': signed['X-Internal-Body-Sha256'],
      },
      body: tamperedBody,
    }) as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature uses wrong secret', async () => {
    const res = await POST(
      mkSignedReq({ signWith: 'b'.repeat(INTERNAL_SECRET_MIN_LENGTH) }),
    );
    expect(res.status).toBe(401);
  });
});

// ── Body validation ───────────────────────────────────────────────────────

describe('POST /api/internal/retrieve-knowledge — body validation', () => {
  it('returns 400 invalid_json on malformed JSON', async () => {
    const res = await POST(mkSignedReq({ bodyText: '{not json' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_json');
  });

  it('returns 400 invalid_body on missing required field', async () => {
    const partial = { ...makeBody() } as Record<string, unknown>;
    delete partial.raw_utterance;
    const res = await POST(mkSignedReq({ bodyText: JSON.stringify(partial) }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when last_assistant_response exceeds 4000 chars', async () => {
    const huge = 'x'.repeat(4001);
    const res = await POST(
      mkSignedReq({ bodyOverrides: { last_assistant_response: huge } }),
    );
    expect(res.status).toBe(400);
  });
});

// ── Session ownership re-derivation ───────────────────────────────────────

// Day-13 audit-build M5: session-validation failures are now all
// collapsed into one opaque `forbidden` 403. Tests assert the response
// status + body wire shape are uniform across the five distinct
// server-side reasons. Reason discrimination lives in console.warn
// (server logs) only.
describe('POST /api/internal/retrieve-knowledge — session ownership (M5 collapse)', () => {
  it('returns opaque 403 forbidden when session row missing', async () => {
    mockSessionSelect.mockResolvedValue({ data: null, error: null });
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('forbidden');
  });

  it('returns opaque 403 forbidden when body user_id != session.user_id', async () => {
    mockSessionSelect.mockResolvedValue({
      data: {
        user_id: '99999999-9999-4999-8999-999999999999',
        creator_id: CREATOR_ID,
        corpus_version_at_session: 1,
        retrieval_version_at_session: 2,
        ended_at: null,
      },
      error: null,
    });
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('forbidden');
  });

  it('returns opaque 403 forbidden when body creator_id != session.creator_id', async () => {
    mockSessionSelect.mockResolvedValue({
      data: {
        user_id: USER_ID,
        creator_id: '99999999-9999-4999-8999-999999999999',
        corpus_version_at_session: 1,
        retrieval_version_at_session: 2,
        ended_at: null,
      },
      error: null,
    });
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('forbidden');
  });

  it('returns opaque 403 forbidden when ended_at is non-null', async () => {
    mockSessionSelect.mockResolvedValue({
      data: {
        user_id: USER_ID,
        creator_id: CREATOR_ID,
        corpus_version_at_session: 1,
        retrieval_version_at_session: 2,
        ended_at: '2026-05-14T10:00:00Z',
      },
      error: null,
    });
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('forbidden');
  });

  it('returns opaque 403 forbidden when session.retrieval_version_at_session !== 2', async () => {
    mockSessionSelect.mockResolvedValue({
      data: {
        user_id: USER_ID,
        creator_id: CREATOR_ID,
        corpus_version_at_session: 1,
        retrieval_version_at_session: 1,
        ended_at: null,
      },
      error: null,
    });
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('forbidden');
  });
});

// Day-13 audit-build C3: corpus_version_at_session is taken from the
// sessions snapshot, NOT from the body. Asserts the route ignores the
// body's claim and passes session.corpus_version_at_session to the
// orchestrator instead.
describe('POST /api/internal/retrieve-knowledge — corpus_version snapshot wins (C3)', () => {
  it('orchestrator receives snapshot value, not body claim', async () => {
    mockSessionSelect.mockResolvedValue({
      data: {
        user_id: USER_ID,
        creator_id: CREATOR_ID,
        corpus_version_at_session: 7, // snapshot from sessions row
        retrieval_version_at_session: 2,
        ended_at: null,
      },
      error: null,
    });
    mockRetrieveV2.mockResolvedValue({
      parents: [],
      telemetry: {
        userId: USER_ID,
        sessionId: SESSION_ID,
        creatorId: CREATOR_ID,
        retrievalVersion: 2,
        corpusVersionAtSession: 7,
        cacheHit: false,
        cacheStaleCorpus: false,
        budgetExceeded: false,
        totalLatencyMs: 0,
      },
      budgetExceeded: false,
      rewriteFallback: false,
    });
    // Body claims version 99 — should be ignored.
    await POST(mkSignedReq({ bodyOverrides: { corpus_version_at_session: 99 } }));
    const args = mockRetrieveV2.mock.calls[0][0] as { corpusVersionAtSession: number };
    expect(args.corpusVersionAtSession).toBe(7);
  });
});

// ── Happy path + orchestrator integration ────────────────────────────────

describe('POST /api/internal/retrieve-knowledge — happy path', () => {
  it('returns 200 with snake_case parents + telemetry on success', async () => {
    mockRetrieveV2.mockResolvedValue({
      parents: [
        {
          parentUnitId: 'pu-1',
          text: 'Negative visualization helps prepare for the worst.',
          title: 'The Twins Story',
          sourceType: 'transcript',
          score: 0.87,
          scoreSource: 'rerank',
        },
      ],
      telemetry: {
        userId: USER_ID,
        sessionId: SESSION_ID,
        creatorId: CREATOR_ID,
        retrievalVersion: 2,
        corpusVersionAtSession: 1,
        cacheHit: false,
        cacheStaleCorpus: false,
        budgetExceeded: false,
        totalLatencyMs: 1200,
      },
      budgetExceeded: false,
      rewriteFallback: false,
    });

    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      parents: Array<{ parent_unit_id: string; source_type: string; score_source: string }>;
      budget_exceeded: boolean;
      rewrite_fallback: boolean;
      request_id: string;
    };
    expect(json.parents[0].parent_unit_id).toBe('pu-1');
    expect(json.parents[0].source_type).toBe('transcript');
    expect(json.parents[0].score_source).toBe('rerank');
    expect(json.budget_exceeded).toBe(false);
    expect(json.rewrite_fallback).toBe(false);
    expect(typeof json.request_id).toBe('string');
  });

  // RAG v3 step 6c: dispatch v3 when session.retrieval_version_at_session=3.
  // Verifies the route's session-snapshot-driven dispatch (NOT body-claim
  // driven). Locks the contract that a v=3 session calls retrieveKnowledgeV3
  // and surfaces sections_routed + flat_fallback_fired in the response.
  it('dispatches retrieveKnowledgeV3 when session retrieval_version_at_session=3', async () => {
    mockSessionSelect.mockResolvedValue({
      data: {
        user_id: USER_ID,
        creator_id: CREATOR_ID,
        corpus_version_at_session: 1,
        retrieval_version_at_session: 3,
        ended_at: null,
      },
      error: null,
    });
    mockRetrieveV3.mockResolvedValue({
      parents: [
        {
          parentUnitId: 'pu-v3-1',
          text: 'v3 parent text',
          title: 'V3 Section A',
          sourceType: 'transcript',
          score: 0.83,
          scoreSource: 'rerank',
        },
      ],
      telemetry: {
        userId: USER_ID,
        sessionId: SESSION_ID,
        creatorId: CREATOR_ID,
        retrievalVersion: 3,
        corpusVersionAtSession: 1,
        cacheHit: false,
        cacheStaleCorpus: false,
        budgetExceeded: false,
        totalLatencyMs: 800,
      },
      budgetExceeded: false,
      rewriteFallback: false,
      sectionsRouted: 4,
      flatFallbackFired: false,
    });

    const res = await POST(mkSignedReq({
      bodyOverrides: {
        topic_tags: ['topic-a'],
        rank_mode: 'max_blend',
        lambda: 0.1,
        top_s: 4,
        n_parent_per_section: 5,
        min_sim: 0.3,
      },
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      parents: Array<{ parent_unit_id: string }>;
      sections_routed: number;
      flat_fallback_fired: boolean;
      request_id: string;
    };
    expect(json.parents[0].parent_unit_id).toBe('pu-v3-1');
    expect(json.sections_routed).toBe(4);
    expect(json.flat_fallback_fired).toBe(false);
    expect(mockRetrieveV3).toHaveBeenCalledOnce();
    expect(mockRetrieveV2).not.toHaveBeenCalled();
    // Verify the orchestrator received the v3-specific args (topic_tags etc).
    const v3Args = mockRetrieveV3.mock.calls[0][0] as Record<string, unknown>;
    expect(v3Args.topicTags).toEqual(['topic-a']);
    expect(v3Args.rankMode).toBe('max_blend');
    expect(v3Args.lambda).toBe(0.1);
    expect(v3Args.topS).toBe(4);
    expect(v3Args.nParentPerSection).toBe(5);
    expect(v3Args.minSim).toBe(0.3);
  });

  it('passes deadlineMs = Date.now() + clamped(budget_ms) to orchestrator', async () => {
    mockRetrieveV2.mockResolvedValue({
      parents: [],
      telemetry: {
        userId: USER_ID,
        sessionId: SESSION_ID,
        creatorId: CREATOR_ID,
        retrievalVersion: 2,
        corpusVersionAtSession: 1,
        cacheHit: false,
        cacheStaleCorpus: false,
        budgetExceeded: false,
        totalLatencyMs: 0,
      },
      budgetExceeded: false,
      rewriteFallback: false,
    });

    const t0 = Date.now();
    await POST(mkSignedReq({ bodyOverrides: { budget_ms: 4000 } }));
    const args = mockRetrieveV2.mock.calls[0][0] as { deadlineMs: number };
    // deadlineMs is computed inside the route from Date.now()+budget_ms;
    // should be within [t0+3900, t0+4500] (test execution overhead).
    expect(args.deadlineMs).toBeGreaterThanOrEqual(t0 + 3900);
    expect(args.deadlineMs).toBeLessThanOrEqual(t0 + 4500);
  });

  it('clamps budget_ms below MIN', async () => {
    mockRetrieveV2.mockResolvedValue({
      parents: [],
      telemetry: {
        userId: USER_ID,
        sessionId: SESSION_ID,
        creatorId: CREATOR_ID,
        retrievalVersion: 2,
        corpusVersionAtSession: 1,
        cacheHit: false,
        cacheStaleCorpus: false,
        budgetExceeded: false,
        totalLatencyMs: 0,
      },
      budgetExceeded: false,
      rewriteFallback: false,
    });
    const t0 = Date.now();
    await POST(mkSignedReq({ bodyOverrides: { budget_ms: 100 } })); // way below 1000 min
    const args = mockRetrieveV2.mock.calls[0][0] as { deadlineMs: number };
    expect(args.deadlineMs).toBeGreaterThanOrEqual(t0 + 900);
    expect(args.deadlineMs).toBeLessThanOrEqual(t0 + 1500);
  });

  it('clamps budget_ms above MAX', async () => {
    mockRetrieveV2.mockResolvedValue({
      parents: [],
      telemetry: {
        userId: USER_ID,
        sessionId: SESSION_ID,
        creatorId: CREATOR_ID,
        retrievalVersion: 2,
        corpusVersionAtSession: 1,
        cacheHit: false,
        cacheStaleCorpus: false,
        budgetExceeded: false,
        totalLatencyMs: 0,
      },
      budgetExceeded: false,
      rewriteFallback: false,
    });
    const t0 = Date.now();
    await POST(mkSignedReq({ bodyOverrides: { budget_ms: 99999 } }));
    const args = mockRetrieveV2.mock.calls[0][0] as { deadlineMs: number };
    expect(args.deadlineMs).toBeGreaterThanOrEqual(t0 + 7900);
    expect(args.deadlineMs).toBeLessThanOrEqual(t0 + 8500);
  });
});

// ── Orchestrator error mapping ────────────────────────────────────────────

describe('POST /api/internal/retrieve-knowledge — orchestrator errors', () => {
  it('maps empty_utterance → 400 + fires rag_proxy_filter_disagreement (M6)', async () => {
    mockRetrieveV2.mockRejectedValue(new RetrieveKnowledgeV2Error('empty_utterance'));
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(400);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      'rag_proxy_filter_disagreement',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('maps embed_failed deadline_exceeded → 504 retryable:false', async () => {
    mockRetrieveV2.mockRejectedValue(
      new RetrieveKnowledgeV2Error('embed_failed', 'deadline_exceeded'),
    );
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(504);
    const json = (await res.json()) as { retryable: boolean };
    expect(json.retryable).toBe(false); // audit M3: never retry, budget already burned
  });

  it('maps embed_failed (non-deadline) → 500', async () => {
    mockRetrieveV2.mockRejectedValue(
      new RetrieveKnowledgeV2Error('embed_failed', 'connection_refused'),
    );
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(500);
  });

  it('maps budget_check_failed → 500', async () => {
    mockRetrieveV2.mockRejectedValue(
      new RetrieveKnowledgeV2Error('budget_check_failed', 'rpc timeout'),
    );
    const res = await POST(mkSignedReq({}));
    expect(res.status).toBe(500);
  });
});
