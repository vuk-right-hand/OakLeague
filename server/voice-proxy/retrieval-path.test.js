// retrieval-path.test.js -- the single dispatch chokepoint must be loud + correct.
//
// Run via `node --test` (proxy's test runner per package.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRetrievalPath,
  assertRetrievalPathSupportedOnSpike,
  UnknownRetrievalVersionError,
} from './retrieval-path.js';

test('resolveRetrievalPath maps 1/2/3 to v1/v2/v3 tokens', () => {
  assert.equal(resolveRetrievalPath(1), 'v1');
  assert.equal(resolveRetrievalPath(2), 'v2');
  assert.equal(resolveRetrievalPath(3), 'v3');
});

test('resolveRetrievalPath throws on null/undefined (no silent v1 default -- the bug class)', () => {
  assert.throws(() => resolveRetrievalPath(null), UnknownRetrievalVersionError);
  assert.throws(() => resolveRetrievalPath(undefined), UnknownRetrievalVersionError);
});

test('resolveRetrievalPath throws on unknown integers (forward-fail for v4+)', () => {
  assert.throws(() => resolveRetrievalPath(0), UnknownRetrievalVersionError);
  assert.throws(() => resolveRetrievalPath(4), UnknownRetrievalVersionError);
  assert.throws(() => resolveRetrievalPath(99), UnknownRetrievalVersionError);
});

test('resolveRetrievalPath throws on non-integer / non-numeric', () => {
  assert.throws(() => resolveRetrievalPath('2'), UnknownRetrievalVersionError);
  assert.throws(() => resolveRetrievalPath(2.5), UnknownRetrievalVersionError);
  assert.throws(() => resolveRetrievalPath(NaN), UnknownRetrievalVersionError);
  assert.throws(() => resolveRetrievalPath('two'), UnknownRetrievalVersionError);
});

test('resolveRetrievalPath throw message lists allowed versions + cites plan §5', () => {
  try {
    resolveRetrievalPath(null);
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /1, 2, 3/);
    assert.match(e.message, /plan §5 chokepoint/);
  }
});

test('assertRetrievalPathSupportedOnSpike is silent on v=1 + returns true (only spike-a-supported version)', () => {
  const calls = [];
  const ok = assertRetrievalPathSupportedOnSpike(1, (m) => calls.push(m));
  assert.equal(calls.length, 0);
  assert.equal(ok, true);
});

test('assertRetrievalPathSupportedOnSpike warns on v=2 + returns false (caller must refuse)', () => {
  const calls = [];
  const ok = assertRetrievalPathSupportedOnSpike(2, (m) => calls.push(m));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /retrieval_version=2/);
  assert.match(calls[0], /ZERO retrieval/);
  assert.equal(ok, false);
});

test('assertRetrievalPathSupportedOnSpike warns on v=3 + returns false + points to real session-open path', () => {
  const calls = [];
  const ok = assertRetrievalPathSupportedOnSpike(3, (m) => calls.push(m));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /retrieval_version=3/);
  assert.match(calls[0], /\/api\/sessions\/open/);
  assert.equal(ok, false);
});

test('assertRetrievalPathSupportedOnSpike does NOT throw + returns true on unknown input (admin never locked out)', () => {
  const calls = [];
  assert.doesNotThrow(() => assert.equal(assertRetrievalPathSupportedOnSpike(null, (m) => calls.push(m)), true));
  assert.doesNotThrow(() => assert.equal(assertRetrievalPathSupportedOnSpike(99, (m) => calls.push(m)), true));
  assert.doesNotThrow(() => assert.equal(assertRetrievalPathSupportedOnSpike('foo', (m) => calls.push(m)), true));
});
