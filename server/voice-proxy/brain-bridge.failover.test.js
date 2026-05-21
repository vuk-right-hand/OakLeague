// Unit tests for the Step-2 Gemini→Haiku deep-answer FAILOVER.
//
// Covers the audit findings the failover was built around:
//   C1  — the failover cogs leg is service='anthropic' +
//         operation='brain_deep_answer_failover' (no idempotency collision).
//   C2  — Anthropic does NOT bill-in-full on abort; cumulative output_tokens
//         from message_delta; partial-to-abort billing.
//   C4  — a missing/invalid Anthropic config DEGRADES (re-throws the original
//         'overloaded'), it never escalates to 'misconfigured'/1011.
//   C5  — a STALLED Gemini (no first token) is failover-eligible fast.
//   M3  — Gemini-contents → Anthropic-messages mapping (model→assistant,
//         first-must-be-user, strict alternation) fails loud.
//   M4  — thinking-block deltas are filtered (never reach TTS).
//   M5  — the AbortSignal is plumbed into messages.create (barge cancels Haiku).
//   M7  — the failover decision lives INSIDE the generator: a mid-stream
//         overload (delta already streamed) does NOT failover.
//
// Idiom mirrors brain-bridge.test.js: node:test + injected fake clients.
//
// Run: cd server/voice-proxy && node --test brain-bridge.failover.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDeepAnswer,
  getAnthropicBrainPricing,
  _resetBrainConfigForTests,
  _resetAnthropicConfigForTests,
  BrainBridgeError,
} from './brain-bridge.js';
import {
  streamGenerateAnthropic,
  geminiContentsToAnthropicMessages,
  assertAnthropicModelAllowed,
} from './brain-llm-common.js';

process.env.NODE_ENV = 'test';

const PRICING_ENV = {
  BRAIN_MODEL: 'gemini-2.5-flash',
  BRAIN_USD_PER_INPUT_TOKEN: '0.0000003',
  BRAIN_USD_PER_OUTPUT_TOKEN: '0.0000025',
  BRAIN_QUOTED_AT: '2026-05-18',
};
const ANTHRO_ENV = {
  ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ANTHROPIC_USD_PER_INPUT_TOKEN: '0.000001', // $1 / 1M
  ANTHROPIC_USD_PER_OUTPUT_TOKEN: '0.000005', // $5 / 1M
  ANTHROPIC_QUOTED_AT: '2026-05-21',
};

// AWAIT fn (the failover path reads env AFTER a suspension — restoring env
// synchronously would clear it mid-test). Delete-on-undefined (NOT set to
// the string "undefined", which is truthy and would defeat `if (!apiKey)`).
async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    _resetBrainConfigForTests();
    _resetAnthropicConfigForTests();
  }
}

const ENV_OK = '--- BEGIN REFERENCE a1b2c3 ---\nbody text\n--- END REFERENCE a1b2c3 ---';

// Gemini fake — throwOnOpen for an open-time error; a never-yielding stream
// for the C5 stall path.
function fakeGemini({ throwOnOpen, neverYield } = {}) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContentStream(args) {
        calls.push(args);
        if (throwOnOpen) throw throwOnOpen;
        return (async function* () {
          if (neverYield) { await new Promise(() => {}); } // stall forever
          yield { text: 'gemini', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        })();
      },
    },
  };
}

// Anthropic fake — `messages.create` resolves to an async-iterable of raw
// stream events (+ a `.controller.abort` like the real Stream). `throwOnCreate`
// throws at dispatch; an event carrying `__throw` throws mid-stream.
function fakeAnthropic({ throwOnCreate, events } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(args, opts) {
        calls.push({ args, opts });
        if (throwOnCreate) throw throwOnCreate;
        const seq = events ?? [
          { type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'haiku ' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
          { type: 'message_delta', usage: { output_tokens: 85 } },
          { type: 'message_stop' },
        ];
        const stream = (async function* () {
          for (const e of seq) { if (e && e.__throw) throw e.__throw; yield e; }
        })();
        stream.controller = { abort() { stream.__aborted = true; } };
        return stream;
      },
    },
  };
}

async function drain(gen) {
  const deltas = [];
  let final = null;
  for await (const ev of gen) { if (ev.final) final = ev; else deltas.push(ev.delta); }
  return { deltas, final };
}

const overloaded503 = () => Object.assign(new Error('The model is overloaded. Please try again later.'), { status: 503 });

// ── C1 — failover writes a correctly-attributed, non-colliding leg ───────

test('C1: Gemini 503 + zero deltas → Haiku carries; final is anthropic/failover', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV }, async () => {
    const gemini = fakeGemini({ throwOnOpen: overloaded503() });
    const anthropic = fakeAnthropic();
    const { deltas, final } = await drain(generateDeepAnswer({
      persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q',
      apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic,
    }));
    assert.deepEqual(deltas, ['haiku ', 'answer']);
    assert.equal(final.text, 'haiku answer');
    assert.equal(final.operation, 'brain_deep_answer_failover'); // C1 — distinct verb
    assert.equal(final.service, 'anthropic'); // C1 — correct provider attribution
    assert.equal(final.failedOver, true); // metric flag
    assert.equal(final.modelId, 'claude-haiku-4-5-20251001');
    assert.equal(final.inputTokens, 1200); // message_start
    assert.equal(final.outputTokens, 85); // C2 — cumulative from message_delta
    assert.equal(final.usdPerInputToken, 0.000001);
    assert.equal(final.usdPerOutputToken, 0.000005);
    assert.equal(final.quotedAt, '2026-05-21');
    assert.equal(gemini.calls.length, 1, 'Gemini tried once');
    assert.equal(anthropic.calls.length, 1, 'Haiku tried once (single-shot failover)');
  });
});

test('C1: 429 RESOURCE_EXHAUSTED is also failover-eligible', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV }, async () => {
    const gemini = fakeGemini({ throwOnOpen: Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }) });
    const anthropic = fakeAnthropic();
    const { final } = await drain(generateDeepAnswer({
      persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q',
      apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic,
    }));
    assert.equal(final.service, 'anthropic');
    assert.equal(anthropic.calls.length, 1);
  });
});

// ── M7 — failover decision lives inside the generator ───────────────────

test('M7: a non-overload Gemini error (network) does NOT failover', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV }, async () => {
    const gemini = fakeGemini({ throwOnOpen: new Error('ECONNRESET') });
    const anthropic = fakeAnthropic();
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic })),
      (e) => e instanceof BrainBridgeError && e.code === 'network_error',
    );
    assert.equal(anthropic.calls.length, 0, 'no failover on a non-transient error');
  });
});

// ── C5 — a stalled Gemini (no first token) fails over fast ──────────────

test('C5: Gemini stalls (no first delta) → failover-eligible → Haiku carries', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV, BRAIN_FAILOVER_DETECT_MS: '50' }, async () => {
    const gemini = fakeGemini({ neverYield: true });
    const anthropic = fakeAnthropic();
    const { final } = await drain(generateDeepAnswer({
      persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q',
      apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic,
    }));
    assert.equal(final.service, 'anthropic');
    assert.equal(final.failedOver, true);
    assert.equal(anthropic.calls.length, 1);
  });
});

// ── C4 — broken fallback config DEGRADES, never 1011s ───────────────────

test('C4: Anthropic misconfig on failover → re-throws ORIGINAL overloaded (not misconfigured)', async () => {
  // Gemini 503 but ANTHROPIC_MODEL is unset → failover config throws
  // misconfigured internally; the session must degrade, NOT 1011.
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV, ANTHROPIC_MODEL: undefined }, async () => {
    const gemini = fakeGemini({ throwOnOpen: overloaded503() });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: gemini /* no anthropicClient → uses real construction path, but pricing throws first */ })),
      (e) => {
        // The ORIGINAL overloaded error surfaces — degrade bucket, billed:false.
        assert.ok(e instanceof BrainBridgeError, 'is our taxonomy error');
        assert.equal(e.code, 'overloaded', 'degrades as overloaded, NOT misconfigured (no 1011)');
        assert.equal(e.partial.billed, false, 'no phantom cogs leg for a 503');
        return true;
      },
    );
  });
});

test('C4: a non-haiku ANTHROPIC_MODEL is rejected by the cost guard (misconfig → degrade)', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV, ANTHROPIC_MODEL: 'claude-opus-4-7' }, async () => {
    const gemini = fakeGemini({ throwOnOpen: overloaded503() });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: gemini })),
      (e) => e instanceof BrainBridgeError && e.code === 'overloaded', // degrades, never runs Opus
    );
  });
});

// ── both-fail degrade (M6) ──────────────────────────────────────────────

test('both-fail: Gemini 503 + Haiku network error → degrades (network_error), no 1011', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV }, async () => {
    const gemini = fakeGemini({ throwOnOpen: overloaded503() });
    const anthropic = fakeAnthropic({ throwOnCreate: new Error('ECONNREFUSED') });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic })),
      (e) => {
        assert.ok(e instanceof BrainBridgeError);
        assert.notEqual(e.code, 'misconfigured', 'never 1011 on a both-fail');
        return true;
      },
    );
  });
});

test('both-fail: Haiku billed partial (mid-stream throw after message_start) carries anthropic pricing', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV }, async () => {
    const gemini = fakeGemini({ throwOnOpen: overloaded503() });
    const abortErr = Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
    const anthropic = fakeAnthropic({
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial haiku' } },
        { type: 'message_delta', usage: { output_tokens: 7 } },
        { __throw: abortErr },
      ],
    });
    await assert.rejects(
      () => drain(generateDeepAnswer({ persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q', apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic })),
      (e) => {
        assert.equal(e.code, 'timeout'); // APIUserAbortError → timeout
        // C2 — Anthropic bills partial-to-abort; the leg must be writable.
        assert.equal(e.partial.billed, true);
        assert.equal(e.partial.inputTokens, 1200);
        assert.equal(e.partial.outputTokens, 7); // last cumulative message_delta
        assert.equal(e.partial.operation, 'brain_deep_answer_failover');
        assert.equal(e.partial.service, 'anthropic');
        assert.equal(e.partial.modelId, 'claude-haiku-4-5-20251001');
        assert.equal(e.partial.usdPerInputToken, 0.000001);
        return true;
      },
    );
  });
});

// ── M5 — AbortSignal plumbed into messages.create ───────────────────────

test('M5: the deep-answer signal is forwarded to messages.create (barge cancels Haiku)', async () => {
  await withEnv({ ...PRICING_ENV, ...ANTHRO_ENV }, async () => {
    const gemini = fakeGemini({ throwOnOpen: overloaded503() });
    const anthropic = fakeAnthropic();
    const ac = new AbortController();
    await drain(generateDeepAnswer({
      persona: 'p', referenceEnvelopeText: ENV_OK, question: 'q',
      apiKey: 'k', genaiClient: gemini, anthropicClient: anthropic, signal: ac.signal,
    }));
    assert.equal(anthropic.calls[0].opts.signal, ac.signal, 'signal handed to the SDK request options');
  });
});

// ── streamGenerateAnthropic primitives (direct) ─────────────────────────

test('streamGenerateAnthropic: pre-aborted signal → timeout, billed:false, NO create call', async () => {
  const ac = new AbortController();
  ac.abort();
  const anthropic = fakeAnthropic();
  await assert.rejects(
    () => drain(streamGenerateAnthropic({
      client: anthropic, model: 'claude-haiku-4-5-20251001',
      systemInstruction: 'sys', contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      signal: ac.signal, ErrCls: BrainBridgeError, operation: 'brain_deep_answer',
    })),
    (e) => e instanceof BrainBridgeError && e.code === 'timeout' && e.partial.billed === false,
  );
  assert.equal(anthropic.calls.length, 0, 'no paid call when already aborted');
});

test('M4: thinking-block deltas are filtered — never streamed to TTS', async () => {
  const anthropic = fakeAnthropic({
    events: [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret chain of thought' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'visible' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      { type: 'message_delta', usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ],
  });
  const { deltas, final } = await drain(streamGenerateAnthropic({
    client: anthropic, model: 'claude-haiku-4-5-20251001',
    systemInstruction: 'sys', contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    ErrCls: BrainBridgeError, operation: 'brain_deep_answer',
  }));
  assert.deepEqual(deltas, ['visible'], 'only text_delta reaches TTS — no thinking / json leak');
  assert.equal(final.text, 'visible');
  assert.equal(final.usage.outputTokens, 4);
});

test('C2: output_tokens is the LAST cumulative message_delta, input from message_start', async () => {
  const anthropic = fakeAnthropic({
    events: [
      { type: 'message_start', message: { usage: { input_tokens: 500, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
      { type: 'message_delta', usage: { output_tokens: 10 } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } },
      { type: 'message_delta', usage: { output_tokens: 22 } }, // cumulative, final
      { type: 'message_stop' },
    ],
  });
  const { final } = await drain(streamGenerateAnthropic({
    client: anthropic, model: 'claude-haiku-4-5-20251001',
    systemInstruction: 'sys', contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    ErrCls: BrainBridgeError, operation: 'brain_deep_answer',
  }));
  assert.equal(final.usage.inputTokens, 500);
  assert.equal(final.usage.outputTokens, 22);
});

test('streamGenerateAnthropic: empty text stream → invalid_response_shape WITH billed partial', async () => {
  const anthropic = fakeAnthropic({
    events: [
      { type: 'message_start', message: { usage: { input_tokens: 33, output_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ],
  });
  await assert.rejects(
    () => drain(streamGenerateAnthropic({
      client: anthropic, model: 'claude-haiku-4-5-20251001',
      systemInstruction: 'sys', contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      ErrCls: BrainBridgeError, operation: 'brain_deep_answer',
    })),
    (e) => e instanceof BrainBridgeError && e.code === 'invalid_response_shape' && e.partial.billed === true && e.partial.inputTokens === 33,
  );
});

// ── M3 — Gemini-contents → Anthropic-messages mapping ───────────────────

test('M3: 3-turn injection contents map model→assistant, user/assistant/user', () => {
  const contents = [
    { role: 'user', parts: [{ text: ENV_OK }] },
    { role: 'model', parts: [{ text: 'ack' }] },
    { role: 'user', parts: [{ text: 'Q?' }] },
  ];
  const messages = geminiContentsToAnthropicMessages(contents, BrainBridgeError);
  assert.deepEqual(messages, [
    { role: 'user', content: ENV_OK },
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'Q?' },
  ]);
});

test('M2/M3: the L2 salted injection envelope SURVIVES the Anthropic mapping verbatim', () => {
  // The injection defense lives in the salted BEGIN/END datamarking. The
  // failover reuses the same assembled contents (already salt-checked by
  // assembleBrainContents), but this locks that the mapping does not strip
  // or mangle the envelope — messages[0] must carry the salt verbatim.
  const contents = [
    { role: 'user', parts: [{ text: ENV_OK }] },
    { role: 'model', parts: [{ text: 'ack' }] },
    { role: 'user', parts: [{ text: 'Q?' }] },
  ];
  const messages = geminiContentsToAnthropicMessages(contents, BrainBridgeError);
  assert.equal(messages[0].content, ENV_OK, 'salted envelope passed through unchanged');
  assert.match(messages[0].content, /^--- BEGIN REFERENCE [0-9a-f]{4,12} ---/);
  assert.match(messages[0].content, /--- END REFERENCE [0-9a-f]{4,12} ---/);
});

test('M3: empty contents / first-not-user / consecutive-same-role all fail loud', () => {
  assert.throws(() => geminiContentsToAnthropicMessages([], BrainBridgeError),
    (e) => e instanceof BrainBridgeError && e.code === 'misconfigured');
  assert.throws(() => geminiContentsToAnthropicMessages([{ role: 'model', parts: [{ text: 'x' }] }], BrainBridgeError),
    (e) => e instanceof BrainBridgeError && e.code === 'misconfigured' && /start with a user/.test(e.message));
  assert.throws(() => geminiContentsToAnthropicMessages([
    { role: 'user', parts: [{ text: 'a' }] },
    { role: 'user', parts: [{ text: 'b' }] },
  ], BrainBridgeError),
    (e) => e instanceof BrainBridgeError && e.code === 'misconfigured' && /alternate/.test(e.message));
});

// ── Haiku-only cost guard ───────────────────────────────────────────────

test('assertAnthropicModelAllowed: non-haiku and -latest are rejected; dated haiku ok', () => {
  for (const bad of ['claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-4o', 'claude-haiku-latest', undefined]) {
    assert.throws(() => assertAnthropicModelAllowed(bad, 'ANTHROPIC_MODEL', BrainBridgeError),
      (e) => e instanceof BrainBridgeError && e.code === 'misconfigured');
  }
  assert.doesNotThrow(() => assertAnthropicModelAllowed('claude-haiku-4-5-20251001', 'ANTHROPIC_MODEL', BrainBridgeError));
});

// ── getAnthropicBrainPricing fail-closed ────────────────────────────────

test('getAnthropicBrainPricing: fail-closed on each missing env', async () => {
  for (const drop of ['ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_USD_PER_INPUT_TOKEN', 'ANTHROPIC_USD_PER_OUTPUT_TOKEN', 'ANTHROPIC_QUOTED_AT']) {
    await withEnv({ ...ANTHRO_ENV, [drop]: undefined }, () => {
      _resetAnthropicConfigForTests();
      assert.throws(() => getAnthropicBrainPricing(),
        (e) => e instanceof BrainBridgeError && e.code === 'misconfigured');
    });
  }
});

test('getAnthropicBrainPricing: returns pinned Haiku rates when env valid', async () => {
  await withEnv(ANTHRO_ENV, () => {
    _resetAnthropicConfigForTests();
    const p = getAnthropicBrainPricing();
    assert.equal(p.modelId, 'claude-haiku-4-5-20251001');
    assert.equal(p.usdPerInputToken, 0.000001);
    assert.equal(p.usdPerOutputToken, 0.000005);
    assert.equal(p.quotedAt, '2026-05-21');
    assert.equal(p.apiKey, 'sk-ant-test');
  });
});
