// query-rewrite.test.ts — vitest for the Flash query rewriter.
//
// Coverage:
//   1. Standalone query passthrough (model returns it unchanged)
//   2. Follow-up rewrite uses prior assistant turn for context
//   3. noContextAfterResumption=true when follow-up + no prior turn
//   4. noContextAfterResumption=false when standalone (no prior turn)
//   5. Empty utterance → fallback, no model call
//   6. Budget too tight (<500ms remaining) → fast-fail fallback, no model call
//   7. Model timeout → fallback to raw utterance
//   8. Model returns invalid JSON → fallback
//   9. Model returns Zod-invalid shape → fallback
//  10. Model returns markdown-fenced JSON → parsed correctly
//  11. lastAssistantResponse truncated to 1500 chars (tail kept)
//  12. modelId + quotedAtRate present on every return path

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @google/genai BEFORE importing the module under test.
const generateContentMock = vi.fn();
// Mock only the GoogleGenAI client; keep the real ThinkingLevel/Type enum
// exports so the v3 thinkingLevel path (gemini-3.x models) initializes.
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: { generateContent: generateContentMock },
    })),
  };
});

import {
  rewriteQuery,
  QUERY_REWRITE_MODEL,
  QUERY_REWRITE_USD_PER_INPUT_TOKEN,
  QUERY_REWRITE_USD_PER_OUTPUT_TOKEN,
  _resetClientForTests,
} from './query-rewrite';

function farDeadline(): number {
  return Date.now() + 30_000;
}

function tightDeadline(): number {
  return Date.now() + 100; // < MIN_REMAINING_MS (500)
}

function mockOk(json: string, tokens = { in: 100, out: 30 }) {
  generateContentMock.mockResolvedValueOnce({
    text: json,
    usageMetadata: { promptTokenCount: tokens.in, candidatesTokenCount: tokens.out },
  });
}

function mockTimeout() {
  generateContentMock.mockImplementationOnce(
    () => new Promise(() => {}), // never resolves
  );
}

function mockReject(msg = 'transport_failure') {
  generateContentMock.mockRejectedValueOnce(new Error(msg));
}

beforeEach(() => {
  generateContentMock.mockReset();
  _resetClientForTests();
});

// Reusable prior-turn context so tests exercise the LLM path now that
// no-context + short-utterance turns SKIP the model entirely (TTFT
// optimization 2026-06-10).
const PRIOR_TURN = 'Stoicism is a school of philosophy focused on resilience and virtue.';

describe('rewriteQuery — happy paths', () => {
  it('standalone query + NO context: skips the LLM entirely (TTFT skip path)', async () => {
    const r = await rewriteQuery({
      userUtterance: 'how do habits form',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.rewritten).toBe('how do habits form');
    expect(r.fallback).toBe(false);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.skippedNoContext).toBe(true);
    expect(r.noContextAfterResumption).toBe(false);
    expect(r.modelId).toBe(QUERY_REWRITE_MODEL);
    expect(r.usdPerInputToken).toBe(QUERY_REWRITE_USD_PER_INPUT_TOKEN);
    expect(r.usdPerOutputToken).toBe(QUERY_REWRITE_USD_PER_OUTPUT_TOKEN);
    // No LLM call → zero tokens billed.
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('standalone query WITH context: LLM path runs (no skip)', async () => {
    mockOk('{"rewritten":"how do habits form"}');
    const r = await rewriteQuery({
      userUtterance: 'how do habits form',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.rewritten).toBe('how do habits form');
    expect(r.fallback).toBe(false);
    expect(r.skippedNoContext).toBeUndefined();
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(30);
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('long ramble + NO context: LLM still runs for tightening (plan-audit M1, >80 chars)', async () => {
    mockOk('{"rewritten":"how to price a B2B product"}');
    const ramble =
      'so like I have been thinking about, um, how do you actually, you know, go about figuring out pricing for like a B2B thing';
    expect(ramble.length).toBeGreaterThan(80);
    const r = await rewriteQuery({
      userUtterance: ramble,
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.skippedNoContext).toBeUndefined();
    expect(r.rewritten).toBe('how to price a B2B product');
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('follow-up shape + NO context: skip still fires AND noContextAfterResumption=true (telemetry contract, plan-audit C2)', async () => {
    const r = await rewriteQuery({
      userUtterance: 'tell me more about that',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.skippedNoContext).toBe(true);
    expect(r.noContextAfterResumption).toBe(true);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('rewrites follow-up using prior assistant turn', async () => {
    mockOk('{"rewritten":"more about negative visualization technique"}');
    const r = await rewriteQuery({
      userUtterance: 'tell me more about that',
      lastAssistantResponse:
        'Negative visualization is a Stoic technique where you mentally rehearse worst-case outcomes to build resilience.',
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.rewritten).toContain('negative visualization');
    expect(r.fallback).toBe(false);
    expect(r.noContextAfterResumption).toBe(false);
  });
});

describe('noContextAfterResumption flag', () => {
  it('true when follow-up utterance + null prior turn', async () => {
    mockOk('{"rewritten":"tell me more"}');
    const r = await rewriteQuery({
      userUtterance: 'tell me more about that',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.noContextAfterResumption).toBe(true);
  });

  it('false when standalone utterance + null prior turn', async () => {
    mockOk('{"rewritten":"how do habits form"}');
    const r = await rewriteQuery({
      userUtterance: 'how do habits form',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.noContextAfterResumption).toBe(false);
  });

  it('false when follow-up + prior turn present', async () => {
    mockOk('{"rewritten":"more on stoicism"}');
    const r = await rewriteQuery({
      userUtterance: 'tell me more',
      lastAssistantResponse: 'Stoicism is a school of philosophy from ancient Greece...',
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.noContextAfterResumption).toBe(false);
  });
});

describe('budget + skip paths', () => {
  it('empty utterance returns fallback without calling the model', async () => {
    const r = await rewriteQuery({
      userUtterance: '   ',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toBe('empty_utterance');
    expect(r.rewritten).toBe('');
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('tight budget fast-fails to fallback without calling model', async () => {
    const r = await rewriteQuery({
      userUtterance: 'how do habits form',
      // Context present so the TTFT skip path doesn't preempt the budget check.
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      deadlineMs: tightDeadline(),
    });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toBe('budget_exhausted');
    expect(r.rewritten).toBe('how do habits form');
    expect(generateContentMock).not.toHaveBeenCalled();
  });
});

describe('error paths fall back to raw utterance', () => {
  it('timeout falls back with reason=timeout', async () => {
    mockTimeout();
    const r = await rewriteQuery({
      userUtterance: 'how do habits form',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      // Tight enough that the inner call timeout fires fast.
      deadlineMs: Date.now() + 600,
    });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toBe('timeout');
    expect(r.rewritten).toBe('how do habits form');
  });

  it('transport rejection falls back with reason=transport_error', async () => {
    mockReject('connection_reset');
    const r = await rewriteQuery({
      userUtterance: 'q',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toBe('transport_error');
    expect(r.rewritten).toBe('q');
  });

  it('invalid JSON falls back with reason=parse_error', async () => {
    mockOk('this is not json');
    const r = await rewriteQuery({
      userUtterance: 'q',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toBe('parse_error');
    expect(r.rewritten).toBe('q');
  });

  it('Zod-invalid shape falls back with reason=parse_error', async () => {
    mockOk('{"not_rewritten":"x"}');
    const r = await rewriteQuery({
      userUtterance: 'q',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toBe('parse_error');
    expect(r.rewritten).toBe('q');
  });

  it('markdown-fenced JSON is still parsed', async () => {
    mockOk('```json\n{"rewritten":"clean"}\n```');
    const r = await rewriteQuery({
      userUtterance: 'q',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.fallback).toBe(false);
    expect(r.rewritten).toBe('clean');
  });
});

describe('lastAssistantResponse truncation', () => {
  // Day-9-final audit M2: assert head was actually dropped, not just
  // that the total `A` count is under some loose bound. With 5000 A's
  // followed by TAIL_MARKER, only the tail-1500 window is kept; so the
  // prompt must not contain a contiguous run of more than 1500 A's.
  it('drops the head: 5000-A prior turn has no 2000-A run in prompt', async () => {
    mockOk('{"rewritten":"x"}');
    const longTail = 'TAIL_MARKER ' + 'z'.repeat(50);
    const longPrior = 'A'.repeat(5000) + longTail;
    await rewriteQuery({
      userUtterance: 'tell me more',
      lastAssistantResponse: longPrior,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = (generateContentMock.mock.calls as any[])[0][0].contents as string;
    expect(prompt).toContain('TAIL_MARKER');
    // Head proof: a contiguous run of 2000 A's would only appear if the
    // 5000-A head was kept. After slice(-1500), the longest run drops to
    // at most 1500 - (TAIL_MARKER length) ≈ 1488 — strictly < 2000.
    expect(prompt.includes('A'.repeat(2000))).toBe(false);
    // And the tail-window content must be present.
    expect(prompt).toMatch(/A{500,}/); // some run of A's survives in the tail
  });
});

describe('modelId + rates present on every return path', () => {
  it('present on fallback', async () => {
    const r = await rewriteQuery({
      userUtterance: '',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.modelId).toBe(QUERY_REWRITE_MODEL);
    expect(r.usdPerInputToken).toBe(QUERY_REWRITE_USD_PER_INPUT_TOKEN);
    expect(r.usdPerOutputToken).toBe(QUERY_REWRITE_USD_PER_OUTPUT_TOKEN);
    expect(r.usdPerOutputToken).toBeGreaterThan(r.usdPerInputToken);
  });
});

describe('apiKey-keyed client cache (Day-9-final C2)', () => {
  it('passes the apiKey supplied per call (no cross-key leak)', async () => {
    // The mock GoogleGenAI constructor records what was passed.
    const { GoogleGenAI } = await import('@google/genai');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const GoogleGenAIMock = GoogleGenAI as any;
    GoogleGenAIMock.mockClear();
    mockOk('{"rewritten":"a"}');
    mockOk('{"rewritten":"b"}');
    await rewriteQuery({
      userUtterance: 'q1',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'KEY-A',
      deadlineMs: farDeadline(),
    });
    await rewriteQuery({
      userUtterance: 'q2',
      lastAssistantResponse: PRIOR_TURN,
      geminiApiKey: 'KEY-B',
      deadlineMs: farDeadline(),
    });
    // Two distinct keys → two constructor calls (not one memoized).
    expect(GoogleGenAIMock).toHaveBeenCalledTimes(2);
    expect(GoogleGenAIMock).toHaveBeenNthCalledWith(1, { apiKey: 'KEY-A' });
    expect(GoogleGenAIMock).toHaveBeenNthCalledWith(2, { apiKey: 'KEY-B' });
  });
});

describe('_resetClientForTests gating (Day-9-final C4)', () => {
  it('throws if NODE_ENV is not test', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = process.env as any;
    const prev = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      expect(() => _resetClientForTests()).toThrow(/test-only/);
    } finally {
      env.NODE_ENV = prev;
    }
  });
});
