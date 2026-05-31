// Unit tests for the M1 zombie-claim guard helpers in embed-worker.js
// (Step-9 deferred audit M1). A worker that woke AFTER losing its claim (reaper
// reassigned the job to another worker) must NOT clobber the new owner's job row
// or burn its `attempts`. The corpus_reprocess_jobs failure writers
// (markJobErrored / bumpFailure) scope their UPDATE on `claimed_by` and treat a
// 0-row result as "claim moved → no-op + breadcrumb".
//
// Discriminator is `claimed_by`, NOT `enqueue_version`: the reaper requeue
// (reap_stuck_corpus_reprocess_jobs) does NOT bump enqueue_version — only an
// admin re-enqueue does — so an enqueue_version guard would MISS the
// reaper-driven zombie. claimed_by is the worker's unique identity.
//
// These two helpers are the pure decision seams; the closures that use them
// always pass the closure-scoped `claimedBy` (always truthy in prod).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClaimGuard, isClaimMoved } from './embed-worker.js';

// Minimal fake PostgREST filter builder that records .eq() calls and is
// chainable, like supabase-js's query builder.
function fakeQuery() {
  const calls = [];
  const q = {
    calls,
    eq(col, val) { calls.push(['eq', col, val]); return q; },
    select(cols) { calls.push(['select', cols]); return q; },
  };
  return q;
}

test('applyClaimGuard: with a claimedBy, appends .eq(claimed_by, claimedBy)', () => {
  const q = fakeQuery();
  const out = applyClaimGuard(q, 'reprocess:m1:42');
  assert.equal(out, q, 'returns the same (chainable) builder');
  assert.deepEqual(q.calls, [['eq', 'claimed_by', 'reprocess:m1:42']]);
});

test('applyClaimGuard: without a claimedBy (undefined), leaves the query untouched', () => {
  const q = fakeQuery();
  const out = applyClaimGuard(q, undefined);
  assert.equal(out, q);
  assert.deepEqual(q.calls, [], 'no .eq appended — legacy behavior');
});

test('applyClaimGuard: empty-string claimedBy is treated as absent (no guard)', () => {
  const q = fakeQuery();
  applyClaimGuard(q, '');
  assert.deepEqual(q.calls, [], 'falsy claimedBy → no .eq (never scopes on an empty owner)');
});

test('isClaimMoved: true ONLY when guarded (claimedBy set) AND 0 rows updated', () => {
  // Guarded write that matched 0 rows → the claim moved to another worker.
  assert.equal(isClaimMoved('reprocess:m1:42', []), true);
  // Guarded write that matched our row → not moved.
  assert.equal(isClaimMoved('reprocess:m1:42', [{ id: 'job-1' }]), false);
});

test('isClaimMoved: false when unguarded (no claimedBy) regardless of rows', () => {
  // Legacy / test path: no guard means 0 rows is not a claim-moved signal.
  assert.equal(isClaimMoved(undefined, []), false);
  assert.equal(isClaimMoved('', []), false);
});

test('isClaimMoved: false when the update result is not an array (error/null data)', () => {
  // A supabase error returns data:null — that is NOT a claim-moved signal
  // (the catch block handles errors); only an explicit empty array is.
  assert.equal(isClaimMoved('reprocess:m1:42', null), false);
  assert.equal(isClaimMoved('reprocess:m1:42', undefined), false);
});
