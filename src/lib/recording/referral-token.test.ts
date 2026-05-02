import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  candidateTokenHashes,
  constantTimeHexEqual,
  isValidTokenPlaintext,
  mintReferralToken,
  shareUrlForToken,
} from './referral-token';

const ENV_KEYS = [
  'RECORDING_REFERRAL_HMAC_SECRET_CURRENT',
  'RECORDING_REFERRAL_HMAC_SECRET_NEXT',
  'NEXT_PUBLIC_REFERRAL_HOST',
] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) original[k] = process.env[k];
  process.env.RECORDING_REFERRAL_HMAC_SECRET_CURRENT = 'test-current-secret';
  delete process.env.RECORDING_REFERRAL_HMAC_SECRET_NEXT;
  delete process.env.NEXT_PUBLIC_REFERRAL_HOST;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe('mintReferralToken', () => {
  it('produces a 20-char Crockford base32 plaintext + a 64-char hex hash', () => {
    const { plaintext, tokenHash } = mintReferralToken();
    expect(plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens across calls', () => {
    const a = mintReferralToken();
    const b = mintReferralToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('throws if CURRENT secret is missing', () => {
    delete process.env.RECORDING_REFERRAL_HMAC_SECRET_CURRENT;
    expect(() => mintReferralToken()).toThrow(/HMAC_SECRET_CURRENT/);
  });
});

describe('candidateTokenHashes', () => {
  it('returns just the CURRENT hash when only CURRENT is set', () => {
    const list = candidateTokenHashes('ABCDEFGHJKMNPQRSTVWX');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns CURRENT + NEXT hashes when rotation is in flight', () => {
    process.env.RECORDING_REFERRAL_HMAC_SECRET_NEXT = 'test-next-secret';
    const list = candidateTokenHashes('ABCDEFGHJKMNPQRSTVWX');
    expect(list).toHaveLength(2);
    expect(list[0]).not.toBe(list[1]);
  });

  it('CURRENT minted tokens validate against CURRENT', () => {
    const { plaintext, tokenHash } = mintReferralToken();
    const cands = candidateTokenHashes(plaintext);
    expect(cands).toContain(tokenHash);
  });

  it('returns empty when no secrets are set', () => {
    delete process.env.RECORDING_REFERRAL_HMAC_SECRET_CURRENT;
    expect(candidateTokenHashes('x')).toEqual([]);
  });
});

describe('constantTimeHexEqual', () => {
  it('matches identical hex strings', () => {
    expect(constantTimeHexEqual('deadbeef', 'deadbeef')).toBe(true);
  });
  it('rejects different-length strings', () => {
    expect(constantTimeHexEqual('deadbeef', 'deadbee')).toBe(false);
  });
  it('rejects different content', () => {
    expect(constantTimeHexEqual('deadbeef', 'cafebabe')).toBe(false);
  });
  it('rejects non-hex input', () => {
    expect(constantTimeHexEqual('deadbeez', 'deadbeez')).toBe(false);
    expect(constantTimeHexEqual('', '')).toBe(false); // empty isn't hex
  });
  it('rejects non-string input safely', () => {
    expect(constantTimeHexEqual(undefined as unknown as string, 'a')).toBe(false);
    expect(constantTimeHexEqual('a', null as unknown as string)).toBe(false);
  });
});

describe('isValidTokenPlaintext', () => {
  it('accepts a valid Crockford 20-char string', () => {
    expect(isValidTokenPlaintext('ABCDEFGHJKMNPQRSTVWX')).toBe(true);
  });
  it('rejects forbidden Crockford chars (I/L/O/U)', () => {
    expect(isValidTokenPlaintext('IBCDEFGHJKMNPQRSTVWX')).toBe(false);
    expect(isValidTokenPlaintext('LBCDEFGHJKMNPQRSTVWX')).toBe(false);
    expect(isValidTokenPlaintext('OBCDEFGHJKMNPQRSTVWX')).toBe(false);
    expect(isValidTokenPlaintext('UBCDEFGHJKMNPQRSTVWX')).toBe(false);
  });
  it('rejects wrong length', () => {
    expect(isValidTokenPlaintext('ABCDEFGHJKMNPQRSTVW')).toBe(false);  // 19
    expect(isValidTokenPlaintext('ABCDEFGHJKMNPQRSTVWXY')).toBe(false); // 21
  });
  it('rejects lowercase', () => {
    expect(isValidTokenPlaintext('abcdefghjkmnpqrstvwx')).toBe(false);
  });
});

describe('shareUrlForToken', () => {
  it('uses the env-configured host', () => {
    process.env.NEXT_PUBLIC_REFERRAL_HOST = 'staging.oakl.gg';
    expect(shareUrlForToken('ABCDEFGHJKMNPQRSTVWX')).toBe('staging.oakl.gg/r/ABCDEFGHJKMNPQRSTVWX');
  });
  it('falls back to oakl.gg', () => {
    expect(shareUrlForToken('ABCDEFGHJKMNPQRSTVWX')).toBe('oakl.gg/r/ABCDEFGHJKMNPQRSTVWX');
  });
});
