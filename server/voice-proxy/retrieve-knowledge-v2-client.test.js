// retrieve-knowledge-v2-client.test.js — Day-13 audit M3 / S9 / S12.
//
// Coverage:
//   1. signs with valid HMAC envelope (intercept fetch + verify headers)
//   2. body shape: snake_case keys, top_k optional, last_assistant_response: null OK
//   3. returns camelCase parent shape on success
//   4. throws invalid_response_shape on missing parents[]
//   5. throws http_4xx / http_5xx with status code + requestId preserved
//   6. throws network_error on fetch rejection
//   7. throws timeout when AbortController fires
//   8. NEVER retries (single-shot contract — audit M3)
//   9. respects external signal (barge-in) — propagates abort
//  10. boot-fatal when RAG_V2_SHIM_URL unset
//  11. boot-fatal when INTERNAL_API_SECRET unset or short
//  12. boot-fatal when RAG_V2_SHIM_URL not a valid URL

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callRetrieveKnowledgeV2,
  RetrieveV2ClientError,
  _resetConfigForTests,
} from './retrieve-knowledge-v2-client.js';

const SECRET = 'a'.repeat(48);
const URL = 'https://oakleague.test/api/internal/retrieve-knowledge';

let _origFetch;
beforeEach(() => {
  process.env.RAG_V2_SHIM_URL = URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  _resetConfigForTests();
  _origFetch = globalThis.fetch;
});

function restoreFetch() {
  globalThis.fetch = _origFetch;
}

function happyArgs(overrides = {}) {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    creatorId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    rawUtterance: 'tell me about discipline',
    lastAssistantResponse: null,
    corpusVersionAtSession: 1,
    budgetMs: 4000,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const happyShimBody = {
  parents: [
    {
      parent_unit_id: 'pu-1',
      text: 'negative visualization helps prepare for the worst',
      title: 'The Twins Story',
      source_type: 'transcript',
      score: 0.87,
      score_source: 'rerank',
    },
  ],
  telemetry: {},
  budget_exceeded: false,
  rewrite_fallback: false,
  request_id: 'req_test',
};

test('signs request with HMAC envelope headers', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse(happyShimBody);
  };
  try {
    await callRetrieveKnowledgeV2(happyArgs());
  } finally {
    restoreFetch();
  }
  assert.equal(captured.url, URL);
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
  assert.match(captured.init.headers['X-Internal-Timestamp'], /^\d+$/);
  assert.match(captured.init.headers['X-Internal-Body-Sha256'], /^[a-f0-9]{64}$/);
  assert.equal(captured.init.headers['content-type'], 'application/json');
});

test('body is snake_case + omits top_k when not provided', async () => {
  let bodyText;
  globalThis.fetch = async (_url, init) => {
    bodyText = init.body;
    return jsonResponse(happyShimBody);
  };
  try {
    await callRetrieveKnowledgeV2(happyArgs());
  } finally {
    restoreFetch();
  }
  const parsed = JSON.parse(bodyText);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'budget_ms',
    'corpus_version_at_session',
    'creator_id',
    'last_assistant_response',
    'raw_utterance',
    'session_id',
    'user_id',
  ]);
  assert.equal(parsed.last_assistant_response, null);
});

test('body includes top_k when caller passes it', async () => {
  let bodyText;
  globalThis.fetch = async (_url, init) => {
    bodyText = init.body;
    return jsonResponse(happyShimBody);
  };
  try {
    await callRetrieveKnowledgeV2(happyArgs({ topK: 7 }));
  } finally {
    restoreFetch();
  }
  const parsed = JSON.parse(bodyText);
  assert.equal(parsed.top_k, 7);
});

test('returns parents in camelCase shape on success', async () => {
  globalThis.fetch = async () => jsonResponse(happyShimBody);
  let r;
  try {
    r = await callRetrieveKnowledgeV2(happyArgs());
  } finally {
    restoreFetch();
  }
  assert.equal(r.parents.length, 1);
  assert.equal(r.parents[0].parentUnitId, 'pu-1');
  assert.equal(r.parents[0].sourceType, 'transcript');
  assert.equal(r.parents[0].scoreSource, 'rerank');
  assert.equal(r.budgetExceeded, false);
  assert.equal(r.rewriteFallback, false);
});

test('throws invalid_response_shape on missing parents[]', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ budget_exceeded: false, rewrite_fallback: false });
  try {
    await assert.rejects(
      () => callRetrieveKnowledgeV2(happyArgs()),
      (e) => e instanceof RetrieveV2ClientError && e.code === 'invalid_response_shape',
    );
  } finally {
    restoreFetch();
  }
});

test('throws http_4xx on 401/403/409 with status preserved', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ error: 'session_user_mismatch', request_id: 'req_x' }, 403);
  try {
    await assert.rejects(
      () => callRetrieveKnowledgeV2(happyArgs()),
      (e) =>
        e instanceof RetrieveV2ClientError &&
        e.code === 'http_4xx' &&
        e.status === 403 &&
        e.requestId === 'req_x',
    );
  } finally {
    restoreFetch();
  }
});

test('throws http_5xx on 504', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ error: 'embed_failed', request_id: 'req_y' }, 504);
  try {
    await assert.rejects(
      () => callRetrieveKnowledgeV2(happyArgs()),
      (e) =>
        e instanceof RetrieveV2ClientError &&
        e.code === 'http_5xx' &&
        e.status === 504,
    );
  } finally {
    restoreFetch();
  }
});

test('throws network_error when fetch rejects', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    await assert.rejects(
      () => callRetrieveKnowledgeV2(happyArgs()),
      (e) => e instanceof RetrieveV2ClientError && e.code === 'network_error',
    );
  } finally {
    restoreFetch();
  }
});

test('throws timeout when AbortController fires', async () => {
  globalThis.fetch = async (_url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  try {
    await assert.rejects(
      () => callRetrieveKnowledgeV2(happyArgs({ budgetMs: 50 })),
      (e) => e instanceof RetrieveV2ClientError && e.code === 'timeout',
    );
  } finally {
    restoreFetch();
  }
});

test('NEVER retries — single fetch call on any 5xx', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ error: 'embed_failed', request_id: 'r' }, 500);
  };
  try {
    await assert.rejects(() => callRetrieveKnowledgeV2(happyArgs()));
    assert.equal(calls, 1, 'fetch invoked exactly once');
  } finally {
    restoreFetch();
  }
});

test('external signal abort propagates', async () => {
  globalThis.fetch = async (_url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const externalAc = new AbortController();
  // Abort before fetch resolves
  setTimeout(() => externalAc.abort(), 10);
  try {
    await assert.rejects(
      () => callRetrieveKnowledgeV2({ ...happyArgs(), signal: externalAc.signal }),
      (e) => e instanceof RetrieveV2ClientError && e.code === 'timeout',
    );
  } finally {
    restoreFetch();
  }
});

test('boot-fatal when RAG_V2_SHIM_URL unset', async () => {
  delete process.env.RAG_V2_SHIM_URL;
  _resetConfigForTests();
  await assert.rejects(
    () => callRetrieveKnowledgeV2(happyArgs()),
    (e) => e instanceof RetrieveV2ClientError && /RAG_V2_SHIM_URL/.test(e.message),
  );
});

test('boot-fatal when INTERNAL_API_SECRET too short', async () => {
  process.env.INTERNAL_API_SECRET = 'short';
  _resetConfigForTests();
  await assert.rejects(
    () => callRetrieveKnowledgeV2(happyArgs()),
    (e) => e instanceof RetrieveV2ClientError && /INTERNAL_API_SECRET/.test(e.message),
  );
});

test('boot-fatal when RAG_V2_SHIM_URL is not a valid URL', async () => {
  process.env.RAG_V2_SHIM_URL = 'not a url';
  _resetConfigForTests();
  await assert.rejects(
    () => callRetrieveKnowledgeV2(happyArgs()),
    (e) => e instanceof RetrieveV2ClientError && /not a valid URL/.test(e.message),
  );
});
