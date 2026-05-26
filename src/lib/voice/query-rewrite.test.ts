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
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  })),
}));

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

describe('rewriteQuery — happy paths', () => {
  it('passes through standalone queries', async () => {
    mockOk('{"rewritten":"how do habits form"}');
    const r = await rewriteQuery({
      userUtterance: 'how do habits form',
      lastAssistantResponse: null,
      geminiApiKey: 'k',
      deadlineMs: farDeadline(),
    });
    expect(r.rewritten).toBe('how do habits form');
    expect(r.fallback).toBe(false);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.noContextAfterResumption).toBe(false);
    expect(r.modelId).toBe(QUERY_REWRITE_MODEL);
    expect(r.usdPerInputToken).toBe(QUERY_REWRITE_USD_PER_INPUT_TOKEN);
    expect(r.usdPerOutputToken).toBe(QUERY_REWRITE_USD_PER_OUTPUT_TOKEN);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(30);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
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
      lastAssistantResponse: null,
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
      lastAssistantResponse: null,
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
      lastAssistantResponse: null,
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
      lastAssistantResponse: null,
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
      lastAssistantResponse: null,
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
      lastAssistantResponse: null,
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
      lastAssistantResponse: null,
      geminiApiKey: 'KEY-A',
      deadlineMs: farDeadline(),
    });
    await rewriteQuery({
      userUtterance: 'q2',
      lastAssistantResponse: null,
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
