import { describe, it, expect } from 'vitest';
import { CONSENT_VERSIONS, buildApplyConsents } from './consent';

// Audit M2: pin the TS consent constants to the DB CHECK + non-empty version
// so a drift (empty version / unknown type) can't ship an apply flow that
// every honest applicant fails at the RPC with an unfixable "bad_consent".
const DB_ALLOWED_TYPES = new Set(['voice_clone', 'likeness', 'content_license', 'tos', 'privacy']);

describe('buildApplyConsents', () => {
  const entries = buildApplyConsents();

  it('includes the three required apply consents', () => {
    const types = new Set(entries.map((e) => e.type));
    for (const required of ['tos', 'voice_clone', 'likeness']) {
      expect(types.has(required as keyof typeof CONSENT_VERSIONS)).toBe(true);
    }
  });

  it('every entry has a DB-allowed type and a non-empty version ≤40 chars', () => {
    for (const e of entries) {
      expect(DB_ALLOWED_TYPES.has(e.type)).toBe(true);
      expect(e.version.length).toBeGreaterThan(0);
      expect(e.version.length).toBeLessThanOrEqual(40);
    }
  });

  it('all CONSENT_VERSIONS values are non-empty and ≤40 chars', () => {
    for (const v of Object.values(CONSENT_VERSIONS)) {
      expect(v.length).toBeGreaterThan(0);
      expect(v.length).toBeLessThanOrEqual(40);
    }
  });
});
