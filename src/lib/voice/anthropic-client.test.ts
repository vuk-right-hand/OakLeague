// anthropic-client tests — Haiku-only guard.
//
// Verifies the cost-defense layer:
//   * Sonnet / Opus / unrecognized model strings throw model_not_haiku.
//   * Missing model throws model_not_set.
//   * Missing API key throws api_key_missing.
//   * Order of validation: model is checked before key, so misconfigured
//     envs surface the more-actionable error first.
//   * Singleton caching works (second call doesn't re-validate).
//
// The @anthropic-ai/sdk module is mocked so this suite never opens a real
// HTTPS connection and runs deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Anthropic SDK BEFORE importing the module under test. The default
// export is the Anthropic class constructor; we replace it with a stub that
// records the apiKey it received so tests can assert it.
const mockAnthropicCtor = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts: { apiKey: string }) {
      mockAnthropicCtor(opts);
    }
  },
}));

import {
  anthropicClient,
  anthropicModel,
  AnthropicConfigError,
  _resetForTests,
} from './anthropic-client';

beforeEach(() => {
  mockAnthropicCtor.mockReset();
  _resetForTests();
  // Default valid env for each test; individual tests override.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  vi.restoreAllMocks();
});


// ── anthropicModel() ───────────────────────────────────────────────────────

describe('anthropicModel — happy path', () => {
  it('returns the pinned Haiku model string', () => {
    expect(anthropicModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('accepts any model that starts with claude-haiku- (allowlist by prefix)', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-5-0-20270101';
    _resetForTests();
    expect(anthropicModel()).toBe('claude-haiku-5-0-20270101');
  });

  it('caches the validated model — second call returns same value without re-reading env', () => {
    expect(anthropicModel()).toBe('claude-haiku-4-5-20251001');
    // Mutate env AFTER first call; second call should still return the cached value.
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    expect(anthropicModel()).toBe('claude-haiku-4-5-20251001');
  });
});

describe('anthropicModel — rejection paths', () => {
  it('throws model_not_set when ANTHROPIC_MODEL is unset', () => {
    delete process.env.ANTHROPIC_MODEL;
    _resetForTests();
    expect(() => anthropicModel()).toThrow(AnthropicConfigError);
    try {
      anthropicModel();
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_set');
    }
  });

  it('throws model_not_set when ANTHROPIC_MODEL is the empty string', () => {
    process.env.ANTHROPIC_MODEL = '';
    _resetForTests();
    expect(() => anthropicModel()).toMatchObject; // chain below
    try {
      anthropicModel();
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_set');
    }
  });

  it('throws model_not_haiku for claude-opus-4-7 (the expensive footgun this guard exists to prevent)', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    _resetForTests();
    try {
      anthropicModel();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnthropicConfigError);
      expect((e as AnthropicConfigError).code).toBe('model_not_haiku');
      // Error message must name the offending value so the deploy-time error
      // is debuggable from the log line alone.
      expect((e as Error).message).toContain('claude-opus-4-7');
    }
  });

  it('throws model_not_haiku for claude-sonnet-4-6', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    _resetForTests();
    try {
      anthropicModel();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_haiku');
    }
  });

  it('throws model_not_haiku for an unrelated string (typo / pasted-wrong-value)', () => {
    process.env.ANTHROPIC_MODEL = 'gpt-4o';
    _resetForTests();
    try {
      anthropicModel();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_haiku');
    }
  });

  it('rejects a model that contains haiku but does NOT start with claude-haiku- (substring vs prefix)', () => {
    // Defensive: prevents someone from naming a model `claude-opus-4-haiku-bench`
    // or similar and slipping past a substring check. We anchor to startsWith.
    process.env.ANTHROPIC_MODEL = 'claude-opus-haiku-eval-20260101';
    _resetForTests();
    try {
      anthropicModel();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_haiku');
    }
  });
});


// ── anthropicClient() ──────────────────────────────────────────────────────

describe('anthropicClient — construction', () => {
  it('constructs the SDK client with the API key when env is fully valid', () => {
    const client = anthropicClient();
    expect(client).toBeDefined();
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-test-key' });
  });

  it('caches the client across calls — SDK ctor called once across N calls', () => {
    anthropicClient();
    anthropicClient();
    anthropicClient();
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
  });

  it('throws api_key_missing when ANTHROPIC_API_KEY is unset (and model is valid)', () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetForTests();
    try {
      anthropicClient();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnthropicConfigError);
      expect((e as AnthropicConfigError).code).toBe('api_key_missing');
    }
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });

  it('throws model_not_haiku BEFORE api_key_missing when both env vars are wrong (validation order)', () => {
    // Why this matters: if both are misconfigured, surface the model error
    // first because it's the more dangerous misconfiguration (silent cost
    // blowup vs. obvious "no calls work at all").
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    _resetForTests();
    try {
      anthropicClient();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_haiku');
    }
  });

  it('throws model_not_set when model is unset even if API key is present', () => {
    delete process.env.ANTHROPIC_MODEL;
    _resetForTests();
    try {
      anthropicClient();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AnthropicConfigError).code).toBe('model_not_set');
    }
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });
});


// ── C5 (integration audit): _resetForTests production guard ───────────────

describe('_resetForTests — production guard (integration-audit C5)', () => {
  // process.env.NODE_ENV is typed read-only by Next 15 in this repo; cast at
  // the assignment site keeps the tests honest without disabling the rule.
  const env = process.env as Record<string, string | undefined>;

  it('throws when called with NODE_ENV=production and no vitest signal', () => {
    // Simulate a hotfix-shaped accidental import: production env, no vitest.
    const savedNodeEnv = env.NODE_ENV;
    const savedVitest = env.VITEST;
    const savedWorker = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
    try {
      env.NODE_ENV = 'production';
      delete env.VITEST;
      delete (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
      expect(() => _resetForTests()).toThrow(/test-only/i);
    } finally {
      env.NODE_ENV = savedNodeEnv;
      if (savedVitest !== undefined) env.VITEST = savedVitest;
      (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ = savedWorker;
    }
  });

  it('throws when called with NODE_ENV=development and no vitest signal (preview deploys, local dev)', () => {
    const savedNodeEnv = env.NODE_ENV;
    const savedVitest = env.VITEST;
    const savedWorker = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
    try {
      env.NODE_ENV = 'development';
      delete env.VITEST;
      delete (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
      expect(() => _resetForTests()).toThrow(/test-only/i);
    } finally {
      env.NODE_ENV = savedNodeEnv;
      if (savedVitest !== undefined) env.VITEST = savedVitest;
      (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ = savedWorker;
    }
  });
});


// ── AnthropicConfigError shape ─────────────────────────────────────────────

describe('AnthropicConfigError', () => {
  it('carries a typed .code field', () => {
    const e = new AnthropicConfigError('model_not_haiku', 'test');
    expect(e.code).toBe('model_not_haiku');
    expect(e.name).toBe('AnthropicConfigError');
    expect(e).toBeInstanceOf(Error);
  });

  it('defaults message to the code string when none supplied', () => {
    const e = new AnthropicConfigError('api_key_missing');
    expect(e.message).toBe('api_key_missing');
  });
});
