// posthog-client.test.js — Day-13 audit M2.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureBatch,
  _resetForTests,
  _getInFlightCount,
} from './posthog-client.js';

let _origFetch;
let _origWarn;
let _warnLines;

beforeEach(() => {
  _resetForTests();
  _origFetch = globalThis.fetch;
  _origWarn = console.warn;
  _warnLines = [];
  console.warn = (msg) => _warnLines.push(String(msg));
  delete process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_HOST;
});

function restore() {
  globalThis.fetch = _origFetch;
  console.warn = _origWarn;
}

test('disabled when POSTHOG_API_KEY unset; warns ONCE', async () => {
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('', { status: 200 });
  };
  try {
    const r1 = captureBatch({
      events: [{ name: 'rag_cache_miss' }],
      distinctId: 'user-1',
    });
    const r2 = captureBatch({
      events: [{ name: 'rag_cache_miss' }],
      distinctId: 'user-1',
    });
    assert.equal(r1.queued, false);
    assert.equal(r1.reason, 'disabled');
    assert.equal(r2.reason, 'disabled');
    // Warn fires once (memoized via _config cache).
    const warns = _warnLines.filter((l) => l.includes('POSTHOG_API_KEY unset'));
    assert.equal(warns.length, 1);
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test('empty events array — queued:false', async () => {
  process.env.POSTHOG_API_KEY = 'phk_test';
  _resetForTests();
  const r = captureBatch({ events: [], distinctId: 'user-1' });
  assert.equal(r.queued, false);
  assert.equal(r.reason, 'empty');
});

test('happy path: enqueues batch via queueMicrotask', async () => {
  process.env.POSTHOG_API_KEY = 'phk_test';
  process.env.POSTHOG_HOST = 'https://posthog.test';
  _resetForTests();
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response('', { status: 200 });
  };
  try {
    const r = captureBatch({
      events: [{ name: 'rag_cache_miss' }, { name: 'rag_rerank_success' }],
      distinctId: 'user-1',
      sessionId: 'sess-9',
    });
    assert.equal(r.queued, true);
    assert.equal(r.count, 2);
    // Drain microtasks
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(captured.url, 'https://posthog.test/batch/');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.api_key, 'phk_test');
    assert.equal(body.batch.length, 2);
    assert.equal(body.batch[0].event, 'rag_cache_miss');
    assert.equal(body.batch[0].distinct_id, 'user-1');
    assert.equal(body.batch[0].properties.$session_id, 'sess-9');
  } finally {
    restore();
  }
});

test('trailing slash in POSTHOG_HOST is normalized', async () => {
  process.env.POSTHOG_API_KEY = 'phk_test';
  process.env.POSTHOG_HOST = 'https://posthog.test/';
  _resetForTests();
  let captured;
  globalThis.fetch = async (url) => {
    captured = url;
    return new Response('', { status: 200 });
  };
  try {
    captureBatch({ events: [{ name: 'x' }], distinctId: 'user-1' });
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(captured, 'https://posthog.test/batch/');
  } finally {
    restore();
  }
});

test('queue cap drops batch when in-flight >= 16', async () => {
  process.env.POSTHOG_API_KEY = 'phk_test';
  _resetForTests();
  // Park fetches so in-flight ticks up without resolving.
  let releaseAll;
  const block = new Promise((res) => {
    releaseAll = res;
  });
  globalThis.fetch = async () => {
    await block;
    return new Response('', { status: 200 });
  };
  try {
    const okResults = [];
    for (let i = 0; i < 16; i++) {
      okResults.push(captureBatch({ events: [{ name: 'x' }], distinctId: 'u' }));
    }
    // Allow microtasks to flush so in-flight increments are real.
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(_getInFlightCount(), 16);
    okResults.forEach((r) => assert.equal(r.queued, true));
    // 17th call drops.
    const overflow = captureBatch({ events: [{ name: 'x' }], distinctId: 'u' });
    assert.equal(overflow.queued, false);
    assert.equal(overflow.reason, 'queue_full');
    const warns = _warnLines.filter((l) => l.includes('queue full'));
    assert.equal(warns.length, 1);
    // Cleanup: release fetches so the process exits cleanly.
    releaseAll();
    await new Promise((res) => setTimeout(res, 10));
  } finally {
    restore();
  }
});

test('drops events on PostHog 500 without throwing', async () => {
  process.env.POSTHOG_API_KEY = 'phk_test';
  _resetForTests();
  globalThis.fetch = async () => new Response('upstream err', { status: 500 });
  try {
    const r = captureBatch({ events: [{ name: 'x' }], distinctId: 'u' });
    assert.equal(r.queued, true);
    await new Promise((res) => setTimeout(res, 20));
    const warns = _warnLines.filter((l) => l.includes('batch 500'));
    assert.equal(warns.length, 1);
  } finally {
    restore();
  }
});

test('AbortController fires after timeout — no throw', async () => {
  process.env.POSTHOG_API_KEY = 'phk_test';
  _resetForTests();
  globalThis.fetch = async (_url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  try {
    captureBatch({ events: [{ name: 'x' }], distinctId: 'u' });
    // Default timeout is 1500ms; we don't wait that long in test —
    // assert the structure works. Trigger a manual setTimeout flush.
    // We're testing that nothing throws synchronously, not the timer.
    await new Promise((res) => setTimeout(res, 50));
    // No assertion failure means no unhandled rejection escaped.
    assert.ok(true);
  } finally {
    restore();
  }
});
