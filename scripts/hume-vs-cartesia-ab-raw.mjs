#!/usr/bin/env node
/**
 * HUME_TTS_PLAN §7 — A/B harness, RAW-TEXT variant (informational only).
 *
 * IMPORTANT (audit S18 unit-wide, 2026-05-13): this script bypasses the
 * HARNESS's `normalize()` step (`AB_SKIP_NORMALIZE=1`), but BOTH bridges
 * apply their OWN internal text normalizer at sendText time (curly →
 * straight quotes, em-dash → hyphen, ellipsis → "...", NBSP → space).
 *
 * So in practice this variant measures only the FIRST normalization
 * layer's effect (the harness one). The bridges still receive ASCII at
 * the wire. To truly test un-normalized input, you'd need to add a
 * `normalize: false` opt-out to both bridges — out of scope here.
 *
 * Still useful for confirming the bridge-side normalizer doesn't change
 * provider behavior asymmetrically — but NOT for "what would happen if
 * we removed the normalizer entirely."
 *
 * Output dir defaults to `tmp/ab-raw/`. NOT the decision input.
 *
 * Re-uses the same env contract as hume-vs-cartesia-ab.mjs.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const childEnv = {
  ...process.env,
  // Sibling dir so we don't overwrite the normalized run's WAVs.
  AB_OUTPUT_DIR: process.env.AB_OUTPUT_DIR || path.join(ROOT, 'tmp', 'ab-raw'),
  // Sentinel the main harness checks to skip the normalizer call.
  AB_SKIP_NORMALIZE: '1',
};

// Small (s5) audit fix — use process.execPath so the child runs the same
// Node interpreter as the parent (avoids cross-major-version surprises).
execFile(process.execPath, [path.join(HERE, 'hume-vs-cartesia-ab.mjs')], { env: childEnv }, (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (err) {
    // Small (s6) audit fix — err.code can be a signal NAME (string) when
    // the child was killed by signal. Coerce to a numeric exit code.
    const code = typeof err.code === 'number' ? err.code : 1;
    process.exit(code);
  }
});
