// Unit tests for paraphrase.js — DECOUPLED_BRAIN_PLAN P1-4.
//
// The paraphrase is the dead-air mask: a stateless fast Gemini STREAMING
// generate (audit C1), NO retrieval / NO reference, spoken in the
// creator's cloned voice. Per D10 its output MUST be hedged /
// non-committal so a retrieval-fail degrades naturally (never a
// confidence-then-retreat contradiction). Per P0-5 the STT transcript
// is untrusted input → L1 instruction-hierarchy still applies (but no
// L2 envelope / no L3 ack — there is no reference).
//
// Sibling of brain-bridge.test.js — same streaming fake (stubs
// `models.generateContentStream`), fail-closed pricing / single-shot /
// taxonomy / client-DI idiom. Run:
//   cd server/voice-proxy && node --test paraphrase.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateParaphrase,
  assembleParaphrasePrompt,
  getParaphrasePricing,
  _resetParaphraseConfigForTests,
  _resetClientsForTests,
  ParaphraseError,
} from './paraphrase.js';

process.env.NODE_ENV = 'test'; // _resetClientsForTests is NODE_ENV-guarded

const PRICING_ENV = {
  PARAPHRASE_MODEL: 'gemini-2.5-flash',
  PARAPHRASE_USD_PER_INPUT_TOKEN: '0.0000003',
  PARAPHRASE_USD_PER_OUTPUT_TOKEN: '0.0000025',
  PARAPHRASE_QUOTED_AT: '2026-05-18',
};
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    _resetParaphraseConfigForTests();
  }
}
function fakeStreamClient({ throwOnOpen, chunks } = {}) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContentStream(args) {
        calls.push(args);
        if (throwOnOpen) throw throwOnOpen;
        const seq = chunks ?? [
          { text: 'Let me think ' },
          { text: 'about how to put this…', usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 18 } },
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
async function drain(gen) {
  const deltas = [];
  let final = null;
  for await (const ev of gen) {
    if (ev.final) final = ev; else deltas.push(ev.delta);
  }
  return { deltas, final };
}

// ── pricing fail-closed ─────────────────────────────────────────────────

test('getParaphrasePricing throws when PARAPHRASE_USD_PER_INPUT_TOKEN missing', () => {
  withEnv({ ...PRICING_ENV, PARAPHRASE_USD_PER_INPUT_TOKEN: undefined }, () => {
    _resetParaphraseConfigForTests();
    assert.throws(() => getParaphrasePricing(), /PARAPHRASE_USD_PER_INPUT_TOKEN/);
  });
});

test('getParaphrasePricing throws on zero / negative / non-finite', () => {
  for (const bad of ['0', '-1', 'abc']) {
    withEnv({ ...PRICING_ENV, PARAPHRASE_USD_PER_OUTPUT_TOKEN: bad }, () => {
      _resetParaphraseConfigForTests();
      assert.throws(() => getParaphrasePricing(), /positive finite/);
    });
  }
});

test('getParaphrasePricing rejects a banned model string', () => {
  withEnv({ ...PRICING_ENV, PARAPHRASE_MODEL: 'gemini-2.5-flash-preview' }, () => {
    _resetParaphraseConfigForTests();
    assert.throws(() => getParaphrasePricing(), /PARAPHRASE_MODEL/);
  });
});

test('getParaphrasePricing returns pinned rates when env valid', () => {
  withEnv(PRICING_ENV, () => {
    _resetParaphraseConfigForTests();
    const p = getParaphrasePricing();
    assert.equal(p.modelId, 'gemini-2.5-flash');
    assert.equal(p.usdPerInputToken, 0.0000003);
    assert.equal(p.usdPerOutputToken, 0.0000025);
    assert.equal(p.quotedAt, '2026-05-18');
  });
});

// ── D10 hedge + P0-5 L1 (no L2/L3) + C2 empty_input + example-echo ──────

test('assembleParaphrasePrompt: systemInstruction = persona + L1 hierarchy + D10 hedge', () => {
  const { systemInstruction, contents } = assembleParaphrasePrompt({
    persona: 'You are Alex.',
    question: 'how do two upbringings diverge?',
  });
  assert.match(systemInstruction, /You are Alex\./);
  assert.match(systemInstruction, /DATA|untrusted|never obey|outranks/i);
  assert.match(systemInstruction, /non-committal|do not answer|buy|gather|hedge/i);
  // Small (example-echo): the prompt must explicitly forbid verbatim reuse
  assert.match(systemInstruction, /illustration only|never repeat it verbatim|fresh sentence/i);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[0].parts[0].text, 'how do two upbringings diverge?');
});

test('assembleParaphrasePrompt: C2 — empty/whitespace question → empty_input', () => {
  for (const q of ['', '   ', '\n', undefined, null, 7]) {
    assert.throws(
      () => assembleParaphrasePrompt({ persona: 'p', question: q }),
      (e) => e instanceof ParaphraseError && e.code === 'empty_input',
    );
  }
});

test('assembleParaphrasePrompt: persona null/whitespace does not stringify into the prompt', () => {
  for (const persona of [null, undefined, '   ']) {
    const { systemInstruction } = assembleParaphrasePrompt({ persona, question: 'q' });
    assert.ok(!systemInstruction.startsWith('null') && !systemInstruction.startsWith('undefined'));
    assert.match(systemInstruction, /non-committal|gather/i);
  }
});

// ── generateParaphrase: streaming + cogs + thinking-off + taxonomy ──────

test('generateParaphrase streams {delta}* then ONE terminal token-cogs contract', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const client = fakeStreamClient();
    const { deltas, final } = await drain(generateParaphrase({
      persona: 'p', question: 'q', apiKey: 'k', genaiClient: client,
    }));
    assert.deepEqual(deltas, ['Let me think ', 'about how to put this…']);
    assert.equal(final.text, 'Let me think about how to put this…');
    assert.equal(final.operation, 'brain_paraphrase'); // M3 — verb in contract
    assert.equal(final.modelId, 'gemini-2.5-flash');
    assert.equal(final.inputTokens, 140);
    assert.equal(final.outputTokens, 18);
    assert.equal(final.usdPerInputToken, 0.0000003);
    assert.equal(final.usdPerOutputToken, 0.0000025);
    assert.equal(final.quotedAt, '2026-05-18');
    assert.ok(Number.isFinite(final.startedAt) && final.startedAt <= Date.now()); // M2 anchor
    assert.ok(typeof final.firstChunkMs === 'number' && final.firstChunkMs >= 0);
    assert.ok(typeof final.latencyMs === 'number' && final.latencyMs >= 0);
  });
});

test('generateParaphrase disables thinking (P0-4b — paraphrase is the latency-buyer)', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const client = fakeStreamClient();
    await drain(generateParaphrase({ persona: 'p', question: 'q', apiKey: 'k', genaiClient: client }));
    assert.deepEqual(client.calls[0].config.thinkingConfig, { thinkingBudget: 0 });
  });
});

test('generateParaphrase maps open-time AbortError → timeout, single-shot', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = fakeStreamClient({ throwOnOpen: abortErr });
    await assert.rejects(
      () => drain(generateParaphrase({ persona: 'p', question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof ParaphraseError && e.code === 'timeout' && e.retryable === false,
    );
    assert.equal(client.calls.length, 1, 'single-shot — never retried');
  });
});

test('generateParaphrase M6 — mid-stream abort throws with billed .partial + pricing identity', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = fakeStreamClient({
      chunks: [
        { text: 'Let me think', usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 4 } },
        { __throw: abortErr },
      ],
    });
    await assert.rejects(
      () => drain(generateParaphrase({ persona: 'p', question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => {
        assert.ok(e instanceof ParaphraseError && e.code === 'timeout');
        assert.equal(e.partial.text, 'Let me think');
        assert.equal(e.partial.billed, true);
        assert.equal(e.partial.operation, 'brain_paraphrase'); // M3 verb on billed leg
        assert.equal(e.partial.modelId, 'gemini-2.5-flash');
        assert.equal(e.partial.usdPerInputToken, 0.0000003);
        assert.equal(e.partial.quotedAt, '2026-05-18');
        return true;
      },
    );
  });
});

test('generateParaphrase maps transport throw → network_error', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const client = fakeStreamClient({ throwOnOpen: new Error('ECONNRESET') });
    await assert.rejects(
      () => drain(generateParaphrase({ persona: 'p', question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof ParaphraseError && e.code === 'network_error',
    );
  });
});

test('generateParaphrase throws invalid_response_shape on empty stream', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const client = fakeStreamClient({ chunks: [{ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } }] });
    await assert.rejects(
      () => drain(generateParaphrase({ persona: 'p', question: 'q', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof ParaphraseError && e.code === 'invalid_response_shape',
    );
  });
});

test('generateParaphrase: empty_input short-circuits BEFORE the model is called', async () => {
  await withEnv(PRICING_ENV, async () => {
    _resetParaphraseConfigForTests();
    const client = fakeStreamClient();
    await assert.rejects(
      () => drain(generateParaphrase({ persona: 'p', question: '  ', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof ParaphraseError && e.code === 'empty_input',
    );
    assert.equal(client.calls.length, 0, 'no paid call on empty transcript');
  });
});

test('generateParaphrase: C3 — empty_input wins even when pricing env is MISSING', async () => {
  // Deferred-pricing path (Supabase blip at boot): an empty transcript
  // must degrade, never 1011 via misconfigured.
  await withEnv({ ...PRICING_ENV, PARAPHRASE_MODEL: undefined, PARAPHRASE_QUOTED_AT: undefined }, async () => {
    _resetParaphraseConfigForTests();
    const client = fakeStreamClient();
    await assert.rejects(
      () => drain(generateParaphrase({ persona: 'p', question: '   ', apiKey: 'k', genaiClient: client })),
      (e) => e instanceof ParaphraseError && e.code === 'empty_input',
    );
    assert.equal(client.calls.length, 0);
  });
});

test('_resetClientsForTests is re-exported and NODE_ENV-guarded', () => {
  assert.equal(typeof _resetClientsForTests, 'function');
  _resetClientsForTests();
});
