import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VOICE_CLONE_MIME_ALLOWLIST } from './voice-clone-mimes';

// R4-S10 — drift guard between TS allowlist and SQL CHECK constraint.
// If the SQL is rewritten in a way this regex misses, fix the regex; do
// not silence the assertion.
describe('voice-clone-mimes parity with migration', () => {
  const migrationPath = resolve(
    __dirname,
    '../../../supabase/migrations/20260427000003_voice_clone_uploads.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('every TS entry appears verbatim inside the table CHECK literal', () => {
    for (const mime of VOICE_CLONE_MIME_ALLOWLIST) {
      expect(sql, `migration missing MIME ${mime}`).toContain(`'${mime}'`);
    }
  });

  it('migration MIME literals are all present in the TS allowlist', () => {
    // Pull every quoted MIME-shaped literal from the mime CHECK clause.
    const checkBlock = sql.match(/CHECK \(mime IN \(([\s\S]*?)\)\)/);
    expect(checkBlock, 'mime CHECK block not found in migration').toBeTruthy();
    const literals = Array.from(checkBlock![1].matchAll(/'([a-z0-9./+-]+)'/gi)).map(
      (m) => m[1],
    );
    expect(literals.length).toBeGreaterThan(0);
    const ts = new Set(VOICE_CLONE_MIME_ALLOWLIST as readonly string[]);
    for (const m of literals) {
      expect(ts.has(m), `SQL MIME ${m} missing from TS allowlist`).toBe(true);
    }
  });
});
