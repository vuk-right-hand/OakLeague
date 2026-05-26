// HUME_TTS_PLAN §8 audit M1 — drift guard for FATAL_END_REASONS.
//
// Scrapes index.js for every teardown('<reason>') call and asserts the
// reason is either listed in FATAL_END_REASONS or in the documented
// ALLOWED_TRANSIENT list below. If a new teardown reason is added to
// the proxy without being registered, this test fails and the burn-in
// monitor is updated as part of the same PR.
//
// Run: cd server/voice-proxy && node --test fatal-end-reasons.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FATAL_END_REASONS_SET } from './fatal-end-reasons.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Transient / informational reasons that close a session but are NOT
// fatal red-flag signals for burn-in. The monitor doesn't alert on
// these; they're documented as "session ended for normal reasons."
const ALLOWED_TRANSIENT = new Set([
  'client_close',                  // normal client-initiated close
  'tts_reconnecting',              // R4-M2 — TTS WS reconnect window; recoverable
  'backpressure',                  // R3-C2 — slow client; user-actionable
  'upstream_closed',               // Gemini 4xxx — info, not always fatal
  'model_not_compatible_with_cartesia', // config error, not pricing
  // teardown strings interpolated at runtime; matched via prefix below
  // (e.g., `client_close_${code}_...`)
]);

const PREFIX_TRANSIENT = [
  'client_close_',  // ws.on('close', ...) — runtime-interpolated
  'ws_error',       // ws.on('error', ...) — transient transport error
];

// Audit M6 (unit-wide) — fatal template-literal prefixes. These are
// runtime-interpolated with provider names ('cartesia' | 'hume') but the
// prefix is the stable identifier the burn-in monitor watches for.
const PREFIX_FATAL = [
  'brain_unset_with_',    // brain_unset_with_cartesia / brain_unset_with_hume
  'tts_no_voice_',         // tts_no_voice_cartesia / tts_no_voice_hume
];

function isTransient(reason) {
  if (ALLOWED_TRANSIENT.has(reason)) return true;
  for (const p of PREFIX_TRANSIENT) {
    if (reason.startsWith(p)) return true;
  }
  return false;
}

function isPrefixFatal(prefix) {
  return PREFIX_FATAL.some((p) => prefix === p || prefix.startsWith(p));
}

test("every teardown('<reason>') string is either FATAL_END_REASONS or transient", () => {
  const indexPath = path.join(HERE, 'index.js');
  const src = fs.readFileSync(indexPath, 'utf8');
  // Audit M6 (unit-wide, 2026-05-13) — match ALL three JS quote styles
  // (single, double, backtick). Capture group [1] = single, [2] = double,
  // [3] = template-literal contents. Template literals with `${...}`
  // interpolations are validated separately: their prefix must match
  // PREFIX_TRANSIENT, otherwise the runtime-interpolated reason is an
  // unregistered fatal in disguise.
  const re = /teardown\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)\s*\)/g;
  const literalReasons = new Set();
  const templateReasons = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const captured = m[1] ?? m[2] ?? m[3];
    if (m[3] !== undefined && captured.includes('${')) {
      // Template literal with interpolation — capture the constant prefix.
      const prefix = captured.split('${')[0];
      templateReasons.add(prefix);
    } else {
      literalReasons.add(captured);
    }
  }
  assert.ok(literalReasons.size + templateReasons.size > 0, 'index.js has teardown() calls');

  const unregisteredLiterals = [];
  for (const r of literalReasons) {
    if (!FATAL_END_REASONS_SET.has(r) && !isTransient(r)) {
      unregisteredLiterals.push(r);
    }
  }
  assert.deepEqual(
    unregisteredLiterals,
    [],
    `New teardown literal reason(s) not registered in fatal-end-reasons.js: ${unregisteredLiterals.join(', ')}\n` +
      `Either add to FATAL_END_REASONS (and update burn-in monitor) OR ALLOWED_TRANSIENT.`,
  );

  // Audit M6 — template-literal prefixes must be in PREFIX_TRANSIENT
  // (non-fatal, e.g. client_close_<code>) OR PREFIX_FATAL (provider-
  // interpolated fatals like brain_unset_with_<provider>). Any new
  // `teardown(\`new_thing_${x}\`)` requires explicit registration in
  // one of the two arrays.
  const unregisteredTemplates = [];
  for (const p of templateReasons) {
    const transientMatch = PREFIX_TRANSIENT.some((allowed) => p === allowed || p.startsWith(allowed));
    const fatalMatch     = isPrefixFatal(p);
    if (!transientMatch && !fatalMatch) unregisteredTemplates.push(p);
  }
  assert.deepEqual(
    unregisteredTemplates,
    [],
    `New template-literal teardown prefix(es) not registered: ${unregisteredTemplates.join(', ')}\n` +
      `Add the prefix to PREFIX_TRANSIENT (non-fatal) or PREFIX_FATAL (provider-interpolated fatal).`,
  );
});
