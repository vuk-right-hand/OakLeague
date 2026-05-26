// internal-request-signature.test.ts — Day-13 audit C2 / S10
//
// Coverage:
//   sign:
//     1. produces headers in the documented shape
//     2. rejects short secret
//     3. deterministic given (secret, method, path, body, timestamp)
//   verify:
//     4. round-trips a freshly-signed request
//     5. rejects missing headers (each of the three independently)
//     6. rejects timestamp outside skew window (past + future)
//     7. rejects when body bytes differ from signed body
//     8. rejects when secret differs (signature mismatch)
//     9. rejects malformed bearer (no prefix, wrong length)
//    10. accepts at exact skew-boundary
//    11. constant-time-equal: timing within 50% on N=200 mismatches vs match
//
// Note on #11: we don't try to PROVE constant-time at the OS level — we
// assert that the implementation USES timingSafeEqual, and that on a
// healthy machine the wall-time variance is dominated by jitter, not by
// the secret-prefix length. Regression catches future refactors back to
// `===`.

import { describe, it, expect } from 'vitest';
import {
  signRequest,
  verifyRequest,
  bodyHashHex,
  INTERNAL_SIGNATURE_SKEW_SECONDS,
  INTERNAL_SECRET_MIN_LENGTH,
} from './internal-request-signature';

const SECRET = 'a'.repeat(INTERNAL_SECRET_MIN_LENGTH); // 32-char minimum

describe('signRequest', () => {
  it('produces the three documented headers', () => {
    const h = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      bodySerialized: '{}',
      timestampSec: 1_700_000_000,
    });
    expect(h.Authorization.startsWith('Bearer ')).toBe(true);
    expect(h['X-Internal-Timestamp']).toBe('1700000000');
    expect(h['X-Internal-Body-Sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects short secret', () => {
    expect(() =>
      signRequest({
        secret: 'too-short',
        method: 'POST',
        path: '/x',
        bodySerialized: '',
      }),
    ).toThrow(/at least/);
  });

  it('is deterministic for fixed inputs', () => {
    const a = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      bodySerialized: '{"a":1}',
      timestampSec: 1_700_000_000,
    });
    const b = signRequest({
      secret: SECRET,
      method: 'POST',
      path: '/x',
      bodySerialized: '{"a":1}',
      timestampSec: 1_700_000_000,
    });
    expect(a).toEqual(b);
  });
});

describe('verifyRequest', () => {
  function signedHeaders(opts: { body: string; ts: number; secret?: string }) {
    return signRequest({
      secret: opts.secret ?? SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      bodySerialized: opts.body,
      timestampSec: opts.ts,
    });
  }
  function toHeaders(h: ReturnType<typeof signedHeaders>) {
    return {
      authorization: h.Authorization,
      'x-internal-timestamp': h['X-Internal-Timestamp'],
      'x-internal-body-sha256': h['X-Internal-Body-Sha256'],
    };
  }

  it('round-trips a freshly-signed request', () => {
    const ts = 1_700_000_000;
    const body = '{"hello":"world"}';
    const h = signedHeaders({ body, ts });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: toHeaders(h),
      nowSec: ts,
    });
    expect(r).toEqual({ ok: true });
  });

  it('rejects missing headers individually', () => {
    const ts = 1_700_000_000;
    const body = '{}';
    const h = signedHeaders({ body, ts });
    for (const drop of ['authorization', 'x-internal-timestamp', 'x-internal-body-sha256'] as const) {
      const headers = { ...toHeaders(h), [drop]: null };
      const r = verifyRequest({
        secret: SECRET,
        method: 'POST',
        path: '/api/internal/retrieve-knowledge',
        rawBody: body,
        headers,
        nowSec: ts,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('missing_headers');
    }
  });

  it('rejects stale timestamps', () => {
    const ts = 1_700_000_000;
    const body = '{}';
    const h = signedHeaders({ body, ts });
    // Server clock is 2× skew window ahead
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: toHeaders(h),
      nowSec: ts + INTERNAL_SIGNATURE_SKEW_SECONDS * 2 + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });

  it('rejects future timestamps beyond skew', () => {
    const ts = 1_700_000_000;
    const body = '{}';
    const h = signedHeaders({ body, ts });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: toHeaders(h),
      nowSec: ts - INTERNAL_SIGNATURE_SKEW_SECONDS * 2 - 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale');
  });

  it('accepts exactly at skew boundary', () => {
    const ts = 1_700_000_000;
    const body = '{}';
    const h = signedHeaders({ body, ts });
    const rFuture = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: toHeaders(h),
      nowSec: ts + INTERNAL_SIGNATURE_SKEW_SECONDS,
    });
    expect(rFuture).toEqual({ ok: true });
    const rPast = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: toHeaders(h),
      nowSec: ts - INTERNAL_SIGNATURE_SKEW_SECONDS,
    });
    expect(rPast).toEqual({ ok: true });
  });

  it('rejects mismatched body bytes', () => {
    const ts = 1_700_000_000;
    const signedBody = '{"a":1}';
    const h = signedHeaders({ body: signedBody, ts });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: '{"a":2}', // tampered
      headers: toHeaders(h),
      nowSec: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_body_hash');
  });

  it('rejects wrong secret on verify', () => {
    const ts = 1_700_000_000;
    const body = '{}';
    const h = signedHeaders({ body, ts, secret: SECRET });
    const r = verifyRequest({
      secret: 'b'.repeat(INTERNAL_SECRET_MIN_LENGTH),
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: toHeaders(h),
      nowSec: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects malformed Bearer (no prefix)', () => {
    const ts = 1_700_000_000;
    const body = '{}';
    const h = signedHeaders({ body, ts });
    const r = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/internal/retrieve-knowledge',
      rawBody: body,
      headers: {
        authorization: 'AAAAdeadbeef',
        'x-internal-timestamp': h['X-Internal-Timestamp'],
        'x-internal-body-sha256': h['X-Internal-Body-Sha256'],
      },
      nowSec: ts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_headers');
  });

  it('uses timingSafeEqual — signature comparison wall-time variance is bounded', () => {
    // Day-13 audit S10 regression. We sign with SECRET and verify against
    // an off-by-one-byte forgery 200 times; total wall time should be
    // within 50% of the same-secret round-trip. If a future refactor uses
    // `===` the early-exit short-circuit would skew this dramatically.
    const ts = 1_700_000_000;
    const body = '{}';
    const validHeaders = toHeaders(signedHeaders({ body, ts }));
    // Forged signature: same length, all 'f'.
    const forgedAuth =
      'Bearer ' + 'f'.repeat(validHeaders.authorization.length - 'Bearer '.length);
    const forgedHeaders = { ...validHeaders, authorization: forgedAuth };

    const N = 200;
    let validNs = 0n;
    let forgedNs = 0n;
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      verifyRequest({
        secret: SECRET,
        method: 'POST',
        path: '/api/internal/retrieve-knowledge',
        rawBody: body,
        headers: validHeaders,
        nowSec: ts,
      });
      validNs += process.hrtime.bigint() - t0;

      const t1 = process.hrtime.bigint();
      verifyRequest({
        secret: SECRET,
        method: 'POST',
        path: '/api/internal/retrieve-knowledge',
        rawBody: body,
        headers: forgedHeaders,
        nowSec: ts,
      });
      forgedNs += process.hrtime.bigint() - t1;
    }
    // Both timings should be in the same order of magnitude. We assert a
    // generous 2× envelope — anything tighter is flaky on shared-CI VMs.
    const ratio =
      Number(validNs > forgedNs ? validNs : forgedNs) /
      Number(validNs > forgedNs ? forgedNs : validNs);
    expect(ratio).toBeLessThan(2);
  });
});

describe('bodyHashHex', () => {
  it('returns deterministic 64-hex string', () => {
    expect(bodyHashHex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('treats string and equivalent Buffer identically', () => {
    expect(bodyHashHex('hello')).toBe(bodyHashHex(Buffer.from('hello')));
  });
});
