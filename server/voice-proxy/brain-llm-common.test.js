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
  assert.deepEqual(final.usage, { inputTokens: 10, outputTokens: 2 });
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
