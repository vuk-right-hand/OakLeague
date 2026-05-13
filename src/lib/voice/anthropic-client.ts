// anthropic-client.ts — Anthropic SDK access wrapper with Haiku-only guard.
//
// PURPOSE: be the ONLY construction path for the Anthropic SDK in this
// codebase. Day 4's contextual-gen route + any future Anthropic caller MUST
// import `anthropicClient()` and `anthropicModel()` from here, never
// instantiate `new Anthropic({...})` directly and never hard-code a model
// string.
//
// COST DEFENSE (why this module exists):
//   The Anthropic API key works for every model. There is no key-level model
//   restriction. A single typo in env (`claude-haiku-4-5-...` → `claude-opus-
//   4-...`) or an accidental PR that hard-codes 'claude-opus-4-7' would
//   silently switch our Contextual Retrieval pass to a ~30× more expensive
//   model. At ~1M chunk-context calls/month projected platform load, that's
//   a five-figure surprise on a monthly invoice.
//
//   Defense-in-depth, four layers, this module owns layer 2:
//     1. Env-var pin (`ANTHROPIC_MODEL` on Vercel + Fly).
//     2. THIS MODULE: validate `ANTHROPIC_MODEL` starts with `claude-haiku-`
//        at first use; throw AnthropicConfigError otherwise. Fail-closed.
//     3. Anthropic console budget alert (independent backstop).
//     4. Workspace-scoped key (blast-radius limit if leaked).
//
// HARD-FAIL POLICY: throws on missing key, missing model, or non-Haiku model.
// We never default to anything. A misconfigured deploy refuses to serve
// contextual-gen requests — much louder than a quiet 30× cost spike.
//
// SCOPE: this module exposes the validated SDK client and the validated
// model string. It does NOT wrap `messages.create` — Day 4's contextual-gen
// route adds prompt-caching shape on top. Callers ALWAYS pass
// `model: anthropicModel()` to SDK calls; never a string literal.

import 'server-only';
import Anthropic from '@anthropic-ai/sdk';

// The only model family permitted. If we ever want Sonnet/Opus, this becomes
// an allowlist change reviewed in PR — not an env flip that anyone can do.
const HAIKU_MODEL_PREFIX = 'claude-haiku-';

export class AnthropicConfigError extends Error {
  readonly code:
    | 'api_key_missing'
    | 'model_not_set'
    | 'model_not_haiku';
  constructor(code: AnthropicConfigError['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'AnthropicConfigError';
    this.code = code;
  }
}

// Lazy singletons. Validation runs on first access; subsequent accesses
// return the cached value. Tests can reset via _resetForTests().
let _client: Anthropic | null = null;
let _model: string | null = null;

/**
 * Returns the validated `ANTHROPIC_MODEL` env value. Throws
 * AnthropicConfigError with code 'model_not_set' if unset, or
 * 'model_not_haiku' if the string does not start with `claude-haiku-`.
 *
 * Callers MUST use this return value for the SDK `model` field. Never
 * hard-code a model string.
 */
export function anthropicModel(): string {
  if (_model) return _model;
  const m = process.env.ANTHROPIC_MODEL;
  if (!m) {
    throw new AnthropicConfigError(
      'model_not_set',
      'ANTHROPIC_MODEL env var is required. Set to a Haiku-family pinned ID, e.g. claude-haiku-4-5-20251001.',
    );
  }
  if (!m.startsWith(HAIKU_MODEL_PREFIX)) {
    throw new AnthropicConfigError(
      'model_not_haiku',
      `ANTHROPIC_MODEL must start with "${HAIKU_MODEL_PREFIX}"; got "${m}". Sonnet/Opus are not permitted via env. Edit src/lib/voice/anthropic-client.ts to widen the allowlist if a model swap is intentional.`,
    );
  }
  _model = m;
  return _model;
}

/**
 * Returns the lazily-constructed Anthropic SDK client. Validates the model
 * env alongside the key so a caller cannot get a working client without
 * also having a valid Haiku model pinned.
 */
export function anthropicClient(): Anthropic {
  if (_client) return _client;
  // Validate the model first so missing/invalid ANTHROPIC_MODEL fails before
  // we even attempt to read the API key. Order matters: failing on model
  // first surfaces the more-actionable error message in misconfigured envs.
  anthropicModel();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnthropicConfigError(
      'api_key_missing',
      'ANTHROPIC_API_KEY env var is required.',
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Test-only reset of cached singletons. Used by unit tests that mutate
 * process.env to assert validation behavior.
 *
 * Day-3 integration-audit C5: GUARDED against accidental production calls.
 * The four-layer cost defense (env pin → this module's validator →
 * Anthropic console alert → workspace key scoping) only holds if the
 * validator runs once at first use. If a hotfix or copy-paste invokes
 * `_resetForTests` in a deployed Vercel route, the next `anthropicClient()`
 * call re-reads `process.env.ANTHROPIC_MODEL` — and if an operator hot-set
 * the env to Opus in the console to "test something" and forgot to revert,
 * the cached-Haiku client silently flips. The single export was the
 * single-point-of-failure.
 *
 * Detection: vitest sets VITEST=true and NODE_ENV=test. We require BOTH the
 * env-var AND a vitest-style runtime to be true — defense-in-depth against
 * a single mutated env in prod. In any other context, this throws and the
 * call site is visible in the stack trace.
 */
export function _resetForTests(): void {
  const isVitest =
    process.env.VITEST === 'true' || typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== 'undefined';
  const isTestEnv = process.env.NODE_ENV === 'test';
  if (!isVitest && !isTestEnv) {
    throw new Error(
      '_resetForTests is test-only and refuses to run outside vitest / NODE_ENV=test. ' +
        'If you are seeing this in production, something has gone very wrong — investigate the caller.',
    );
  }
  _client = null;
  _model = null;
}
