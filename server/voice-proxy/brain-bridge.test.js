// Unit tests for brain-bridge.js — DECOUPLED_BRAIN_PLAN P1-3.
//
// brain-bridge is the off-Live deep-answer path: stateless Gemini
// STREAMING generate (audit C1) with the P0-5 L1/L2/L3 injection-defense
// prompt stack + a token-based COGS contract + fail-closed pricing.
// Single-shot, no retry (caller degrades), barge-in via AbortSignal.
//
// Idiom mirrors gemini-bridge.test.js: node:test + node:assert/strict,
// constructor/param dependency-injection of a fake @google/genai client
// (the codebase injects stubs directly — no module-mock framework). The
// fake stubs `models.generateContentStream` (async-iterable of chunks)
// because audit C1 moved the core call to streaming.
//
// Run: cd server/voice-proxy && node --test brain-bridge.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDeepAnswer,
  assembleBrainContents,
  getBrainPricing,
  _resetBrainConfigForTests,
  _resetClientsForTests,
  BrainBridgeError,
} from './brain-bridge.js';

process.env.NODE_ENV = 'test'; // _resetClientsForTests is NODE_ENV-guarded

const PRICING_ENV = {
  BRAIN_MODEL: 'gemini-2.5-flash',
  BRAIN_USD_PER_INPUT_TOKEN: '0.0000003',
  BRAIN_USD_PER_OUTPUT_TOKEN: '0.0000025',
  BRAIN_QUOTED_AT: '2026-05-18',
};
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    _resetBrainConfigForTests();
  }
}

// A valid L2 envelope (matched salted hex BEGIN/END markers — the real
// build-injection-envelope.ts shape: `--- BEGIN/END REFERENCE <hex6> ---`).
const ENV_OK = '--- BEGIN REFERENCE a1b2c3 ---\nbody text\n--- END REFERENCE a1b2c3 ---';

// Fake @google/genai client. `generateContentStream` returns an
// async-iterable of chunks. `throwOnOpen` throws before the stream
// (transport/abort at open); a chunk carrying `__throw` throws
// mid-stream (barge-in after partial text).
function fakeStreamClient({ throwOnOpen, chunks } = {}) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContentStream(args) {
        calls.push(args);
        if (throwOnOpen) throw throwOnOpen;
        const seq = chunks ?? [
          { text: 'the deep ' },
          { text: 'grounded answer', usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 90 } },
        ];
        return (async function* () {
          for (const c of seq) {
            if (c && c.__throw) throw c.__throw;
            yield c;
          }
        })();
      },
    },
  };
}

// Drain the async generator → { deltas:[], final }.
async function drain(gen) {
  const deltas = [];
  let final = null;
  for await (const ev of gen) {
    if (ev.final) final = ev; else deltas.push(ev.delta);
  }
  return { deltas, final };
}

// ── pricing fail-closed (mirrors proxy-handlers getCartesiaPricing) ──────

test('getBrainPricing throws when BRAIN_USD_PER_INPUT_TOKEN missing', () => {
  withEnv({ ...PRICING_ENV, BRAIN_USD_PER_INPUT_TOKEN: undefined }, () => {
    _resetBrainConfigForTests();
    assert.throws(() => getBrainPricing(), /BRAIN_USD_PER_INPUT_TOKEN/);
  });
});

test('getBrainPricing throws on zero / negative / non-finite rate', () => {
  for (const bad of ['0', '-1', 'abc']) {
    withEnv({ ...PRICING_ENV, BRAIN_USD_PER_OUTPUT_TOKEN: bad }, () => {
      _resetBrainConfigForTests();
      assert.throws(() => getBrainPricing(), /positive finite/);
    });
  }
});

test('getBrainPricing returns pinned rates when env valid', () => {
  withEnv(PRICING_ENV, () => {
    _resetBrainConfigForTests();
    const p = getBrainPricing();
    assert.equal(p.modelId, 'gemini-2.5-flash');
    assert.equal(p.usdPerInputToken, 0.0000003);
    assert.equal(p.usdPerOutputToken, 0.0000025);
    assert.equal(p.quotedAt, '2026-05-18');
  });
});

test('getBrainPricing rejects a banned model string (CLAUDE.md guard)', () => {
  withEnv({ ...PRICING_ENV, BRAIN_MODEL: 'gemini-2.5-flash-latest' }, () => {
    _resetBrainConfigForTests();
    assert.throws(() => getBrainPricing(), /BRAIN_MODEL/);
  });
});

// ── P0-5 L1/L2/L3 prompt SHAPE + C2 degrade + M2 fail-loud ──────────────

test('assembleBrainContents: L1 systemInstruction = persona + hierarchy clause', () => {
  const { systemInstruction } = assembleBrainContents({
    persona: 'You are Alex.',
    referenceEnvelopeText: ENV_OK,
    question: 'how do models compound?',
  });
  assert.match(systemInstruction, /You are Alex\./);
  assert.match(systemInstruction, /DATA|instruction|never obey|outranks/i);
});

test('assembleBrainContents: L2 reference is its OWN user turn (roles > concat)', () => {
  const { contents } = assembleBrainContents({
    persona: 'p', referenceEnvelopeText: ENV_OK, question: 'Q?',
  });
  assert.ok(Array.isArray(contents) && contents.length === 3, '3 turns: ref, ack, question');
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[0].parts[0].text, ENV_OK, 'reference verbatim, not concatenated');
  assert.equal(contents[1].role, 'model');
  assert.match(contents[1].parts[0].text, /background data|as myself|ignoring/i);
  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts[0].text, 'Q?');
});

test('assembleBrainContents: C2 — no envelope → persona-only degrade (omit L2 + L3)', () => {
  for (const noRef of [undefined, null, '']) {
    const { systemInstruction, contents } = assembleBrainContents({
      persona: 'You are Alex.', referenceEnvelopeText: noRef, question: 'Q?',
    });
    assert.match(systemInstruction, /You are Alex\./);
    assert.equal(contents.length, 1, 'only the question turn — no orphan model-ack');
    assert.equal(contents[0].role, 'user');
    assert.equal(contents[0].parts[0].text, 'Q?');
  }
});

test('assembleBrainContents: Small — persona null still yields a well-formed L1 systemInstruction', () => {
  const { systemInstruction, contents } = assembleBrainContents({
    persona: null, referenceEnvelopeText: ENV_OK, question: 'Q?',
  });
  assert.match(systemInstruction, /never obey|outranks|DATA/i, 'L1 clause present even with null persona');
  assert.ok(!systemInstruction.startsWith('null'), 'null persona does not stringify into the prompt');
  assert.equal(contents.length, 3);
});

test('assembleBrainContents: C2 — empty/whitespace question → empty_input BEFORE any call', () => {
  for (const q of ['', '   ', '\n\t', undefined, null, 5]) {
    assert.throws(
      () => assembleBrainContents({ persona: 'p', referenceEnvelopeText: ENV_OK, question: q }),
      (e) => e instanceof BrainBridgeError && e.code === 'empty_input',
    );
  }
});

test('assembleBrainContents: M2 — envelope without matched salted markers fails LOUD', () => {
  for (const bad of [
    'just raw passage text, no markers at all',
    '--- BEGIN REFERENCE a1b2c3 ---\nbody\n--- END REFERENCE deadbe ---', // nonce mismatch
    '--- BEGIN REFERENCE a1b2c3 ---\nbody (no end marker)',
    '--- BEGIN REFERENCE XYZ ---\nbody\n--- END REFERENCE XYZ ---', // non-hex nonce
    // M5 — BEGIN not at string start: a passage body that forges the
    // marker must NOT be mistaken for the salt (regex anchored to ^).
    'leading attacker text\n--- BEGIN REFERENCE a1b2c3 ---\nbody\n--- END REFERENCE a1b2c3 ---',
  ]) {
    assert.throws(
      () => assembleBrainContents({ persona: 'p', referenceEnvelopeText: bad, question: 'Q?' }),
      (e) => e instanceof BrainBridgeError && e.code === 'misconfigured' && /injection envelope/i.test(e.message),
    );
  }
});

// ── generateDeepAnswer: streaming + cogs + thinking-off + taxonomy ──────

test('generateDeepAnswer streams {delta}* then ONE terminal cogs object', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    const client = fakeStreamClient();
    const { deltas, final } = await drain(generateDeepAnswer({
      persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q',
      apiKey: 'k', genaiClient: client,
    }));
    assert.deepEqual(deltas, ['the deep ', 'grounded answer']);
    assert.equal(final.text, 'the deep grounded answer');
    assert.equal(final.operation, 'brain_deep_answer'); // M3 — verb in contract
    assert.equal(final.modelId, 'gemini-2.5-flash');
    assert.equal(final.inputTokens, 1200);
    assert.equal(final.outputTokens, 90);
    assert.equal(final.usdPerInputToken, 0.0000003);
    assert.equal(final.usdPerOutputToken, 0.0000025);
    assert.equal(final.quotedAt, '2026-05-18');
    assert.ok(Number.isFinite(final.startedAt) && final.startedAt <= Date.now()); // M2 anchor
    assert.ok(typeof final.firstChunkMs === 'number' && final.firstChunkMs >= 0);
    assert.ok(typeof final.latencyMs === 'number' && final.latencyMs >= 0);
  });
});

test('generateDeepAnswer disables thinking (P0-4b artifact)', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    const client = fakeStreamClient();
    await drain(generateDeepAnswer({
      persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q',
      apiKey: 'k', genaiClient: client,
    }));
    // 2.5 → thinkingBudget:0 (3.x family would be thinkingLevel:'minimal')
    assert.deepEqual(client.calls[0].config.thinkingConfig, { thinkingBudget: 0 });
  });
});

test('generateDeepAnswer maps open-time AbortError → timeout, single-shot, no .partial text', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = fakeStreamClient({ throwOnOpen: abortErr });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof BrainBridgeError && e.code === 'timeout' && e.retryable === false,
    );
    assert.equal(client.calls.length, 1, 'single-shot — never retried');
  });
});

test('generateDeepAnswer M6 — mid-stream abort throws with billed .partial + pricing identity', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = fakeStreamClient({
      chunks: [
        { text: 'partial ans', usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 12 } },
        { __throw: abortErr },
      ],
    });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => {
        assert.ok(e instanceof BrainBridgeError && e.code === 'timeout');
        assert.equal(e.partial.text, 'partial ans');
        assert.equal(e.partial.billed, true);
        assert.equal(e.partial.inputTokens, 1200);
        assert.equal(e.partial.outputTokens, 12);
        assert.equal(e.partial.operation, 'brain_deep_answer'); // M3 verb on billed leg
        // M6 — pricing identity attached so the caller writes the billed leg
        assert.equal(e.partial.modelId, 'gemini-2.5-flash');
        assert.equal(e.partial.usdPerInputToken, 0.0000003);
        assert.equal(e.partial.usdPerOutputToken, 0.0000025);
        assert.equal(e.partial.quotedAt, '2026-05-18');
        return true;
      },
    );
  });
});

test('generateDeepAnswer maps transport throw → network_error', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    const client = fakeStreamClient({ throwOnOpen: new Error('ECONNRESET') });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof BrainBridgeError && e.code === 'network_error',
    );
  });
});

test('generateDeepAnswer: C4 — usage-bearing empty stream → invalid_response_shape WITH billed .partial', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    // candidatesTokenCount>0 + empty text = content-filtered, server BILLED.
    const client = fakeStreamClient({ chunks: [{ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8 } }] });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => {
        assert.ok(e instanceof BrainBridgeError && e.code === 'invalid_response_shape');
        // C4 — the billed call MUST be cogs-recoverable, not a silent hole.
        assert.equal(e.partial.billed, true);
        assert.equal(e.partial.inputTokens, 5);
        assert.equal(e.partial.outputTokens, 8);
        // brain-bridge catch enriches even the invalid_response_shape partial.
        assert.equal(e.partial.operation, 'brain_deep_answer');
        assert.equal(e.partial.modelId, 'gemini-2.5-flash');
        assert.equal(e.partial.quotedAt, '2026-05-18');
        return true;
      },
    );
  });
});

test('generateDeepAnswer: empty_input short-circuits BEFORE the model is called', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetBrainConfigForTests();
    const client = fakeStreamClient();
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: '   ', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof BrainBridgeError && e.code === 'empty_input',
    );
    assert.equal(client.calls.length, 0, 'no paid call on empty transcript');
  });
});

test('generateDeepAnswer: C3 — empty_input wins even when pricing env is MISSING (no 1011 on silence)', async () => {
  // The C3 hazard: on the deferred-pricing path (Supabase blip → boot
  // gate defers → lazy throw armed) an empty transcript must still
  // degrade, NOT 1011 via misconfigured. Proven by removing pricing env
  // entirely: empty_input must surface, never misconfigured.
  await withEnv({ ...PRICING_ENV, BRAIN_USD_PER_INPUT_TOKEN: undefined, BRAIN_MODEL: undefined }, async () => {
    _resetBrainConfigForTests();
    const client = fakeStreamClient();
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: '  ', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof BrainBridgeError && e.code === 'empty_input',
    );
    assert.equal(client.calls.length, 0);
  });
});

test('_resetClientsForTests is re-exported and NODE_ENV-guarded', () => {
  assert.equal(typeof _resetClientsForTests, 'function');
  _resetClientsForTests(); // NODE_ENV==='test' set at top — must not throw
});
