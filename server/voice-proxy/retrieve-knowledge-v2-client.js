// retrieve-knowledge-v2-client.js — Day-13 proxy → Vercel shim client.
//
// Calls /api/internal/retrieve-knowledge with an HMAC-signed envelope
// (see ./internal-request-signature.js). Single-shot semantics — NO
// retry on ANY response status. The orchestrator increments the user's
// budget counter early in its pipeline; a 5xx after that point means
// the increment landed even if the response came back as an error
// (Day-13 audit M3). Retrying re-increments and re-fires cogs_log
// legs that already wrote, double-burning the user's daily quota.
//
// Caller (proxy index.js) handles partial-failure degradation:
//   * on throw → log + degrade turn to persona-only injection
//   * never raise the WS close code from this path
//
// Wire contract (snake_case JSON):
//   POST /api/internal/retrieve-knowledge
//   Headers: Authorization, X-Internal-Timestamp, X-Internal-Body-Sha256
//   Body:
//     {
//       user_id, creator_id, session_id,
//       raw_utterance, last_assistant_response,
//       corpus_version_at_session,
//       budget_ms,        // RELATIVE duration; shim computes deadlineMs locally (audit C4)
//       top_k?
//     }
//   200 Response:
//     {
//       parents: [{parent_unit_id, text, title, source_type, score, score_source}],
//       telemetry: <RagTurnTelemetry>,
//       budget_exceeded, rewrite_fallback, request_id
//     }
//
// Error taxonomy:
//   RetrieveV2ClientError.code:
//     'network_error'           — fetch threw / DNS / TLS
//     'timeout'                 — AbortController fired
//     'http_4xx' | 'http_5xx'   — non-200 (HTTP status in .status)
//     'invalid_response_shape'  — 200 but body schema unexpected

import { signRequest } from './internal-request-signature.js';

export class RetrieveV2ClientError extends Error {
  constructor(code, msg, opts = {}) {
    super(msg || code);
    this.name = 'RetrieveV2ClientError';
    this.code = code;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryable = false; // single-shot by contract — audit M3
  }
}

/**
 * Pinned at module load. Boot-fatal on missing config so the proxy
 * cannot start with v2 wiring half-configured (Day-13 audit S1).
 *
 * Lazy in tests: invoked by `getConfig()` which throws on first call
 * when the env is missing.
 */
let _config = null;
function getConfig() {
  if (_config) return _config;
  const url = process.env.RAG_V2_SHIM_URL;
  const secret = process.env.INTERNAL_API_SECRET;
  if (!url) {
    throw new RetrieveV2ClientError(
      'misconfigured',
      'RAG_V2_SHIM_URL not set',
    );
  }
  if (!secret || secret.length < 32) {
    throw new RetrieveV2ClientError(
      'misconfigured',
      'INTERNAL_API_SECRET missing or too short (>= 32 chars)',
    );
  }
  // Extract path for HMAC envelope; signRequest signs (method|path|ts|hash).
  // The path is the canonical route path, independent of host. We store
  // both so the proxy can override the host (staging vs prod) without
  // affecting the signed payload.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RetrieveV2ClientError(
      'misconfigured',
      `RAG_V2_SHIM_URL is not a valid URL: ${url}`,
    );
  }
  _config = { url, secret, path: parsed.pathname };
  return _config;
}

/**
 * Reset cached config — test-only.
 */
export function _resetConfigForTests() {
  _config = null;
}

/**
 * Call the v2 retrieval shim. Throws RetrieveV2ClientError on any
 * failure; the caller MUST catch and degrade to persona-only. Never
 * retries.
 *
 * Args (camelCase, mapped to snake_case on the wire):
 *   userId, creatorId, sessionId, rawUtterance, lastAssistantResponse,
 *   corpusVersionAtSession, budgetMs, topK?, signal?
 *
 * `signal` lets the proxy abort early on barge-in. `budgetMs` is the
 * server-side budget; the client's AbortController fires at
 * budgetMs + HTTP_OVERHEAD_GRACE_MS to leave the shim time to respond
 * with a typed 504 (which the proxy maps to "no retrieval available
 * this turn" — equivalent failure mode to a real network timeout).
 */
const HTTP_OVERHEAD_GRACE_MS = 500;

export async function callRetrieveKnowledgeV2({
  userId,
  creatorId,
  sessionId,
  rawUtterance,
  lastAssistantResponse,
  corpusVersionAtSession,
  budgetMs,
  topK,
  signal,
}) {
  const cfg = getConfig();
  const bodyObj = {
    user_id: userId,
    creator_id: creatorId,
    session_id: sessionId,
    raw_utterance: rawUtterance,
    last_assistant_response: lastAssistantResponse ?? null,
    corpus_version_at_session: corpusVersionAtSession,
    budget_ms: budgetMs,
  };
  if (typeof topK === 'number') bodyObj.top_k = topK;
  const bodySerialized = JSON.stringify(bodyObj);
  const headers = signRequest({
    secret: cfg.secret,
    method: 'POST',
    path: cfg.path,
    bodySerialized,
  });

  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), budgetMs + HTTP_OVERHEAD_GRACE_MS);
  // If the caller passes an external signal (barge-in), wire it. Day-13
  // audit-build C2: capture the listener ref so we can detach on the
  // happy path — `{ once: true }` only auto-removes AFTER fire, and a
  // long-lived caller-owned signal (e.g. per-session AbortController)
  // would otherwise accumulate one listener per turn until MaxListeners.
  const onCallerAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: bodySerialized,
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(abortTimer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
    // Day-13 audit-build S1: trust `e.name === 'AbortError'` over message
    // regex. undici / DOMException error messages diverge across runtimes.
    if (e?.name === 'AbortError') {
      throw new RetrieveV2ClientError('timeout', e.message);
    }
    throw new RetrieveV2ClientError('network_error', e?.message || 'network_error');
  }
  clearTimeout(abortTimer);
  if (signal) signal.removeEventListener('abort', onCallerAbort);

  let json;
  try {
    json = await res.json();
  } catch (e) {
    // Non-JSON body. Server-side bug or proxy-fronting infrastructure
    // returned HTML. Treat as invalid_response_shape with the status
    // code preserved for telemetry.
    throw new RetrieveV2ClientError(
      'invalid_response_shape',
      `non-JSON response (status=${res.status}): ${e?.message || ''}`,
      { status: res.status },
    );
  }

  if (!res.ok) {
    const code = res.status >= 500 ? 'http_5xx' : 'http_4xx';
    throw new RetrieveV2ClientError(
      code,
      json?.error || `http ${res.status}`,
      { status: res.status, requestId: json?.request_id ?? null },
    );
  }

  // Shape validation. Bare minimum we depend on for the proxy turn
  // lifecycle. A drifted shim should fail loud here rather than feed
  // garbage into the injection envelope.
  if (
    !json ||
    !Array.isArray(json.parents) ||
    typeof json.budget_exceeded !== 'boolean' ||
    typeof json.rewrite_fallback !== 'boolean'
  ) {
    throw new RetrieveV2ClientError(
      'invalid_response_shape',
      'response missing parents[] | budget_exceeded | rewrite_fallback',
      { status: res.status, requestId: json?.request_id ?? null },
    );
  }

  // Map snake_case wire shape → camelCase for the proxy's internal use.
  // Parents shape mirrors RetrievedParent in retrieve-knowledge.ts.
  const parents = json.parents.map((p) => ({
    parentUnitId: p.parent_unit_id,
    text: p.text,
    title: p.title ?? null,
    sourceType: p.source_type,
    score: typeof p.score === 'number' ? p.score : null,
    scoreSource: p.score_source,
  }));

  return {
    parents,
    telemetry: json.telemetry,
    budgetExceeded: json.budget_exceeded,
    rewriteFallback: json.rewrite_fallback,
    // Shim pre-maps telemetry → PostHog event batch so the proxy doesn't
    // port the mapper. Default to empty array on shim-version drift.
    posthogEvents: Array.isArray(json.posthog_events) ? json.posthog_events : [],
    requestId: json.request_id ?? null,
  };
}
