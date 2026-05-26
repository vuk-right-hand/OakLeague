// semantic-cache.test.ts — vitest for the Day 8 MIG-3 RPC wrapper.
//
// Coverage:
//   hashQueryText:
//     1. Deterministic — same input → same digest
//     2. Normalization: trim + lowercase + whitespace collapse
//     3. Returns Buffer of exactly 32 bytes (sha256)
//     4. Different inputs → different hashes (canary, not exhaustive)
//
//   lookupCache:
//     5. Invalid corpus_version → null without hitting RPC
//     6. Invalid queryVec length → null without hitting RPC
//     7. RPC error (non-miss) → throws SemanticCacheError
//     8. RPC zero-row → null
//     9. RPC hit → maps to CacheLookupHit shape
//
//   upsertCache:
//    10. empty creator_id → ok:false reason:invalid_creator_id
//    11. invalid corpus_version → ok:false reason:malformed_input
//    12. wrong queryVec dimension → ok:false reason:malformed_input
//    13. empty arrays → ok:false reason:empty_arrays
//    14. array length mismatch → ok:false reason:array_length_mismatch
//    15. >50 parent ids → ok:false reason:array_too_long
//    16. RPC returns null (stale corpus) → ok:false reason:stale_corpus
//    17. RPC returns uuid → ok:true rowId
//    18. RPC error → ok:false reason:db_error
//
//   VectorEncodingError catch (Day-8/9/10 unit-audit C3):
//    19. lookupCache with NaN-poisoned queryVec → null + console.warn (no throw)
//    20. upsertCache with NaN-poisoned queryVec → ok:false reason:vector_encoding_failed

import { describe, it, expect, vi } from 'vitest';
import {
  hashQueryText,
  lookupCache,
  upsertCache,
  SemanticCacheError,
  CACHE_MAX_PARENT_IDS,
} from './semantic-cache';
import { HALFVEC_DIM } from './halfvec';

function makeVec(at = 1): number[] {
  const v = new Array<number>(HALFVEC_DIM).fill(0);
  v[at] = 1;
  return v;
}

function mockClient(rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc: vi.fn(rpc) } as any;
}

describe('hashQueryText', () => {
  it('is deterministic for identical input', () => {
    expect(hashQueryText('How do habits form?')).toBe(hashQueryText('How do habits form?'));
  });

  it('normalizes whitespace + case + trim', () => {
    expect(hashQueryText('  Tell me MORE  about that  ')).toBe(
      hashQueryText('tell me more about that'),
    );
  });

  it('returns Postgres bytea \\x hex string of 32 bytes (64 hex chars + prefix)', () => {
    const h = hashQueryText('x');
    expect(h.startsWith('\\x')).toBe(true);
    expect(h.length).toBe(2 + 64); // \x + 64 hex chars = 32 bytes
    expect(/^\\x[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  it('different inputs → different hashes', () => {
    expect(hashQueryText('a')).not.toBe(hashQueryText('b'));
  });
});

describe('lookupCache', () => {
  it('returns null on invalid corpus_version without RPC call', async () => {
    const client = mockClient(async () => ({ data: [], error: null }));
    const r = await lookupCache({
      client,
      creatorId: 'c1',
      corpusVersion: 0,
      queryVec: makeVec(),
    });
    expect(r).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('returns null on wrong queryVec length', async () => {
    const client = mockClient(async () => ({ data: [], error: null }));
    const r = await lookupCache({
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: [0, 0, 0], // wrong length
    });
    expect(r).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('throws SemanticCacheError on non-miss RPC error', async () => {
    const client = mockClient(async () => ({
      data: null,
      error: { code: '08000', message: 'connection_exception' },
    }));
    await expect(
      lookupCache({
        client,
        creatorId: 'c1',
        corpusVersion: 1,
        queryVec: makeVec(),
      }),
    ).rejects.toBeInstanceOf(SemanticCacheError);
  });

  it('returns null on zero-row response (miss)', async () => {
    const client = mockClient(async () => ({ data: [], error: null }));
    const r = await lookupCache({
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: makeVec(),
    });
    expect(r).toBeNull();
  });

  it('maps RPC hit row to CacheLookupHit shape', async () => {
    const client = mockClient(async () => ({
      data: [
        {
          parent_unit_ids: ['pa', 'pb'],
          scores: [0.9, 0.7],
          age_seconds: 12,
          cached_row_id: 'row-1',
        },
      ],
      error: null,
    }));
    const r = await lookupCache({
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: makeVec(),
    });
    expect(r).toEqual({
      parentUnitIds: ['pa', 'pb'],
      scores: [0.9, 0.7],
      ageSeconds: 12,
      cachedRowId: 'row-1',
    });
  });
});

describe('upsertCache — input validation', () => {
  function baseInput(over: Partial<Parameters<typeof upsertCache>[0]> = {}) {
    const client = mockClient(async () => ({ data: 'row-1', error: null }));
    return {
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: makeVec(),
      rewrittenText: 'how do habits form',
      parentUnitIds: ['pa', 'pb'],
      scores: [0.9, 0.7],
      ...over,
    };
  }

  it('rejects empty creator_id', async () => {
    const r = await upsertCache(baseInput({ creatorId: '' }));
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('invalid_creator_id');
  });

  it('rejects invalid corpus_version', async () => {
    const r = await upsertCache(baseInput({ corpusVersion: 0 }));
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('malformed_input');
  });

  it('rejects wrong queryVec dimension', async () => {
    const r = await upsertCache(baseInput({ queryVec: [0, 0, 0] }));
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('malformed_input');
  });

  it('rejects empty arrays', async () => {
    const r = await upsertCache(baseInput({ parentUnitIds: [], scores: [] }));
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('empty_arrays');
  });

  it('rejects array length mismatch', async () => {
    const r = await upsertCache(
      baseInput({ parentUnitIds: ['a', 'b'], scores: [0.9] }),
    );
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('array_length_mismatch');
  });

  it('rejects oversized arrays', async () => {
    const big = Array.from({ length: CACHE_MAX_PARENT_IDS + 1 }, (_, i) => `p${i}`);
    const r = await upsertCache(
      baseInput({ parentUnitIds: big, scores: big.map(() => 0.5) }),
    );
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('array_too_long');
  });
});

describe('upsertCache — RPC interaction', () => {
  it('returns stale_corpus when RPC data is null', async () => {
    const client = mockClient(async () => ({ data: null, error: null }));
    const r = await upsertCache({
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: makeVec(),
      rewrittenText: 'q',
      parentUnitIds: ['pa'],
      scores: [0.9],
    });
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('stale_corpus');
  });

  it('returns ok:true with rowId when RPC returns uuid', async () => {
    const client = mockClient(async () => ({ data: 'row-7', error: null }));
    const r = await upsertCache({
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: makeVec(),
      rewrittenText: 'q',
      parentUnitIds: ['pa'],
      scores: [0.9],
    });
    expect(r).toEqual({ ok: true, rowId: 'row-7' });
  });

  it('returns db_error on RPC error', async () => {
    const client = mockClient(async () => ({
      data: null,
      error: { code: '23514', message: 'check_violation' },
    }));
    const r = await upsertCache({
      client,
      creatorId: 'c1',
      corpusVersion: 1,
      queryVec: makeVec(),
      rewrittenText: 'q',
      parentUnitIds: ['pa'],
      scores: [0.9],
    });
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('db_error');
    expect(r.detail).toContain('check_violation');
  });
});

describe('VectorEncodingError catch — fail-open contract (Day-8/9/10 unit-audit C3)', () => {
  // Build a 768-dim vector with one non-finite element so vectorToPgText
  // throws before the RPC is even called.
  function poisonedVec(): number[] {
    const v = new Array<number>(HALFVEC_DIM).fill(0);
    v[42] = Number.NaN;
    return v;
  }

  it('lookupCache returns null on NaN queryVec (no throw, console.warn fires)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // RPC mock that fails the test if called — we must short-circuit before any DB call.
    const client = mockClient(async () => {
      throw new Error('RPC should not be called when queryVec is poisoned');
    });
    const r = await lookupCache({
      client,
      creatorId: 'creator-uuid',
      corpusVersion: 3,
      queryVec: poisonedVec(),
    });
    expect(r).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('vector_encoding_failed');
    warnSpy.mockRestore();
  });

  it('upsertCache returns ok:false reason:vector_encoding_failed on NaN queryVec', async () => {
    // RPC mock that fails the test if called.
    const client = mockClient(async () => {
      throw new Error('RPC should not be called when queryVec is poisoned');
    });
    const r = await upsertCache({
      client,
      creatorId: 'creator-uuid',
      corpusVersion: 3,
      queryVec: poisonedVec(),
      rewrittenText: 'how do I deal with my boss',
      parentUnitIds: ['pa', 'pb'],
      scores: [0.9, 0.7],
    });
    if (r.ok) throw new Error('expected ok:false');
    expect(r.reason).toBe('vector_encoding_failed');
    expect(r.detail).toBeDefined();
    expect(r.detail).toContain('non_finite_value_at_42');
  });
});
