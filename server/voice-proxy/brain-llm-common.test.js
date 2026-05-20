// Unit tests for brain-llm-common.js — DECOUPLED_BRAIN_PLAN P1 audit M5+C1.
//
// This module is the SINGLE source of truth shared by brain-bridge.js
// and paraphrase.js (audit M5 killed 4 copy-paste drift surfaces). An
// untested load-bearing core is itself an audit gap, so the streaming
// generator + the 4 dedup'd helpers get DIRECT coverage here — not just
// the transitive coverage from the two sibling suites.
//
// Run: cd server/voice-proxy && node --test brain-llm-common.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertModelAllowed,
  numOrThrow,
  thinkingConfigFor,
  clientFor,
  _resetClientsForTests,
  streamGenerate,
} from './brain-llm-common.js';

// Minimal ErrCls matching the BrainBridgeError/ParaphraseError contract
// (code + .partial enrichment surface).
class TestErr extends Error {
  constructor(code, msg) { super(msg || code); this.name = 'TestErr'; this.code = code; }
}

// ── assertModelAllowed (CLAUDE.md voice rule — banned strings) ──────────

test('assertModelAllowed: unset → misconfigured', () => {
  assert.throws(() => assertModelAllowed(undefined, 'BRAIN_MODEL', TestErr),
    (e) => e instanceof TestErr && e.code === 'misconfigured' && /not set/.test(e.message));
});

test('assertModelAllowed: -latest and undated -preview are banned', () => {
  for (const bad of ['gemini-2.5-flash-latest', 'gemini-2.5-flash-preview']) {
    assert.throws(() => assertModelAllowed(bad, 'BRAIN_MODEL', TestErr),
      (e) => e instanceof TestErr && e.code === 'misconfigured');
  }
});

test('assertModelAllowed: dated -preview and GA aliases are allowed', () => {
  for (const ok of [
    'gemini-2.5-flash',
    'gemini-3.1-flash-live-preview-12-2025',
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-3-pro',
  ]) {
    assert.doesNotThrow(() => assertModelAllowed(ok, 'BRAIN_MODEL', TestErr));
  }
});

// ── numOrThrow (fail-closed numeric env) ────────────────────────────────

test('numOrThrow: unset / empty / non-finite / <=0 all throw', () => {
  for (const [k, v] of [['A', undefined], ['B', ''], ['C', 'abc'], ['D', '0'], ['E', '-1']]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    assert.throws(() => numOrThrow(k, TestErr), (e) => e instanceof TestErr && e.code === 'misconfigured');
    delete process.env[k];
  }
});

test('numOrThrow: a positive finite string parses', () => {
  process.env.RATE_OK = '0.0000003';
  assert.equal(numOrThrow('RATE_OK', TestErr), 0.0000003);
  delete process.env.RATE_OK;
});

// ── thinkingConfigFor (M5/Small — family boundary) ──────────────────────

test('thinkingConfigFor: 2.5/older → thinkingBudget:0', () => {
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.deepEqual(thinkingConfigFor('gemini-1.5-pro'), { thinkingBudget: 0 });
});

test('thinkingConfigFor: 3.x → thinkingLevel:minimal', () => {
  assert.deepEqual(thinkingConfigFor('gemini-3-pro'), { thinkingLevel: 'minimal' });
  assert.deepEqual(thinkingConfigFor('gemini-3.1-flash-live-preview'), { thinkingLevel: 'minimal' });
});

test('thinkingConfigFor: Small — gemini-30-flash is NOT the 3.x family (boundary char required)', () => {
  // /^gemini-3(\.|-)/ — `gemini-30-flash` has no `.`/`-` after the 3, so
  // it must fall through to the 2.5-era thinkingBudget:0 shape, not 3.x.
  assert.deepEqual(thinkingConfigFor('gemini-30-flash'), { thinkingBudget: 0 });
});

// ── clientFor cache + NODE_ENV-guarded reset ────────────────────────────

test('clientFor caches by apiKey; _resetClientsForTests is NODE_ENV-guarded', () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const a1 = clientFor('key-a');
  const a2 = clientFor('key-a');
  const b1 = clientFor('key-b');
  assert.equal(a1, a2, 'same apiKey → cached instance');
  assert.notEqual(a1, b1, 'different apiKey → distinct instance');
  _resetClientsForTests(); // test env → allowed
  assert.notEqual(clientFor('key-a'), a1, 'reset cleared the cache');

  process.env.NODE_ENV = 'production';
  assert.throws(() => _resetClientsForTests(), /test-only/);
  process.env.NODE_ENV = saved;
});

// ── streamGenerate (audit C1 core + M6 billed-partial) ──────────────────

function streamClient({ throwOnOpen, chunks } = {}) {
  return {
    models: {
      async generateContentStream() {
        if (throwOnOpen) throw throwOnOpen;
        return (async function* () {
          for (const c of chunks) {
            if (c && c.__throw) throw c.__throw;
            yield c;
          }
        })();
      },
    },
  };
}
async function drain(gen) {
  const deltas = []; let final = null;
  for await (const ev of gen) { if (ev.final) final = ev; else deltas.push(ev.delta); }
  return { deltas, final };
}

test('streamGenerate yields {delta}* then ONE terminal {final,text,usage,...}', async () => {
  const client = streamClient({ chunks: [
    { text: 'a' }, { text: 'b', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
  ] });
  const { deltas, final } = await drain(streamGenerate({
    client, model: 'gemini-2.5-flash', systemInstruction: 's', contents: [], ErrCls: TestErr,
  }));
  assert.deepEqual(deltas, ['a', 'b']);
  assert.equal(final.text, 'ab');
  // P1-9 whole-build audit C3 — usage now also carries thoughtsTokens
  // (null when absent from the stub's usageMetadata).
  assert.deepEqual(final.usage, { inputTokens: 10, outputTokens: 2, thoughtsTokens: null });
  assert.ok(final.firstChunkMs >= 0 && final.latencyMs >= 0);
  // M2 — wall-clock anchor for the orchestrator's (A) dead-air gate.
  assert.ok(Number.isFinite(final.startedAt) && final.startedAt <= Date.now());
});

test('streamGenerate: empty stream → invalid_response_shape (C4: carries billed .partial)', async () => {
  // Usage-bearing chunks but empty text (content-filtered response): the
  // server BILLED. The throw MUST carry .partial or the M6 caller writes
  // no cogs leg for a billed call (the silent-billing hole C4 closed).
  const client = streamClient({ chunks: [{ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 7 } }] });
  await assert.rejects(
    () => drain(streamGenerate({ client, model: 'm', systemInstruction: 's', contents: [], ErrCls: TestErr })),
    (e) => {
      assert.ok(e instanceof TestErr && e.code === 'invalid_response_shape');
      assert.equal(e.partial.billed, true);
      assert.equal(e.partial.text, '');
      assert.equal(e.partial.inputTokens, 1);
      assert.equal(e.partial.outputTokens, 7);
      return true;
    },
  );
});

test('streamGenerate: open-time throw → network_error with empty .partial', async () => {
  const client = streamClient({ throwOnOpen: new Error('ECONNRESET') });
  await assert.rejects(
    () => drain(streamGenerate({ client, model: 'm', systemInstruction: 's', contents: [], ErrCls: TestErr })),
    (e) => e instanceof TestErr && e.code === 'network_error' && e.partial.billed === true && e.partial.text === '',
  );
});

test('streamGenerate: mid-stream AbortError → timeout with billed .partial (M6)', async () => {
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const client = streamClient({ chunks: [
    { text: 'partial', usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } },
    { __throw: abortErr },
  ] });
  await assert.rejects(
    () => drain(streamGenerate({ client, model: 'm', systemInstruction: 's', contents: [], ErrCls: TestErr })),
    (e) => {
      assert.ok(e instanceof TestErr && e.code === 'timeout');
      assert.equal(e.partial.text, 'partial');
      assert.equal(e.partial.billed, true);
      assert.equal(e.partial.inputTokens, 9);
      assert.equal(e.partial.outputTokens, 3);
      return true;
    },
  );
});

test('streamGenerate: C3 — signal aborted BEFORE dispatch → timeout, .partial.billed=false, generator NEVER called', async () => {
  const ac = new AbortController();
  ac.abort(); // pre-dispatch
  let dispatched = false;
  const client = { models: { async generateContentStream() { dispatched = true; throw new Error('should not reach'); } } };
  await assert.rejects(
    () => drain(streamGenerate({ client, model: 'm', systemInstruction: 's', contents: [], signal: ac.signal, ErrCls: TestErr })),
    (e) => {
      assert.ok(e instanceof TestErr && e.code === 'timeout');
      assert.equal(e.partial.billed, false, 'pre-dispatch ⇒ server NOT billed ⇒ no phantom cogs row');
      assert.equal(e.partial.text, '');
      return true;
    },
  );
  assert.equal(dispatched, false, 'must not even call generateContentStream when pre-aborted');
});

// ── P1-9 audit M3 — thought-part FILTER in the delta joiner ────────────
//
// 3.x emits multi-part chunks; a part can carry `thought:true` when the
// server-side feature is on (whether by explicit includeThoughts:true or
// any future SDK default). The pre-fix joiner CONCATENATED thought text
// into the user-facing delta — would leak chain-of-thought into the
// cloned-voice TTS output. These tests lock the filter in place so a
// future "simplification" of the joiner is caught in CI.

test('M3: a chunk with thought:true parts has them EXCLUDED from delta', async () => {
  const client = {
    models: {
      async generateContentStream() {
        return (async function* () {
          yield { candidates: [{ content: { parts: [
            { thought: true, text: 'Let me think step by step...' },
            { text: 'Hello' },
          ] } }] };
          yield { candidates: [{ content: { parts: [
            { thought: true, text: 'Now I should be polite.' },
            { text: ' world.' },
          ] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } };
        })();
      },
    },
  };
  const { deltas, final } = await drain(streamGenerate({
    client, model: 'gemini-3.1-flash-preview',
    systemInstruction: 's', contents: [], ErrCls: TestErr,
  }));
  assert.deepEqual(deltas, ['Hello', ' world.'],
    'M3: thought-part text MUST NOT appear in delta — only user-facing parts');
  assert.equal(final.text, 'Hello world.',
    'M3: terminal text MUST be the filtered-and-joined non-thought content');
  // Drift guard — any "Let me think" or "polite" leak indicates the
  // filter regressed (the prod bug the P1-9 audit caught).
  assert.equal(final.text.includes('think'), false, 'no thought-part text in delta');
  assert.equal(final.text.includes('polite'), false, 'no thought-part text in delta');
});

test('M3: a chunk with NO parts but a top-level `text` falls back to chunk.text', async () => {
  // Some SDK responses use the convenience `chunk.text` accessor and
  // omit parts. The filter path only triggers when parts is an array.
  const client = {
    models: {
      async generateContentStream() {
        return (async function* () {
          yield { text: 'a' };
          yield { text: 'b', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        })();
      },
    },
  };
  const { deltas, final } = await drain(streamGenerate({
    client, model: 'gemini-2.5-flash', systemInstruction: 's', contents: [], ErrCls: TestErr,
  }));
  assert.deepEqual(deltas, ['a', 'b']);
  assert.equal(final.text, 'ab');
});

test('whole-build M2: a stream of ONLY thought-parts → invalid_response_shape with billed partial', async () => {
  // Whole-build audit M2 — after M3 filter, all-thought-only streams
  // produce zero user-visible deltas. The terminal-empty-text guard
  // already rejects this with `invalid_response_shape`, but the new
  // failure mode (pre-fix, deltas leaked from thoughts) is suppressed.
  // Locks the behavior so streamToTts degrades cleanly.
  const client = {
    models: {
      async generateContentStream() {
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ thought: true, text: 'thinking 1' }] } }] };
          yield { candidates: [{ content: { parts: [{ thought: true, text: 'thinking 2' }] } }],
                  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 12 } };
        })();
      },
    },
  };
  await assert.rejects(
    () => drain(streamGenerate({
      client, model: 'gemini-3.1-flash-preview',
      systemInstruction: 's', contents: [], ErrCls: TestErr,
    })),
    (e) => {
      assert.ok(e instanceof TestErr && e.code === 'invalid_response_shape');
      assert.equal(e.partial.billed, true,
        'server billed for thought tokens even though nothing user-visible came out');
      assert.equal(e.partial.thoughtsTokens, 12, 'thoughtsTokens travel on the partial too');
      return true;
    },
  );
});

test('M3: an ALL-thought-parts chunk yields NO delta (treated as zero progress)', async () => {
  // A pathological model that emits only thinking on a chunk MUST NOT
  // emit a phantom empty delta — that would advance firstChunkMs to the
  // thinking-emit time instead of the first user-visible byte.
  const client = {
    models: {
      async generateContentStream() {
        return (async function* () {
          yield { candidates: [{ content: { parts: [
            { thought: true, text: 'thinking only here' },
          ] } }] };
          yield { candidates: [{ content: { parts: [
            { text: 'real answer' },
          ] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        })();
      },
    },
  };
  const { deltas, final } = await drain(streamGenerate({
    client, model: 'gemini-3.1-flash-preview',
    systemInstruction: 's', contents: [], ErrCls: TestErr,
  }));
  assert.deepEqual(deltas, ['real answer']);
  assert.equal(final.text, 'real answer');
  // The terminal firstChunkMs records the time of 'real answer', not
  // the all-thought chunk. We can't assert an exact value but it must
  // be >= 0 and the only delta in `deltas` is the post-thought text.
  assert.ok(final.firstChunkMs >= 0);
});
