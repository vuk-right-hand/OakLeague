// decoupled-boot.js — DECOUPLED_BRAIN_PLAN P1-5 C3 ordering gate.
//
// The C3 audit finding: boot-prime is a HARD ordering gate and must land
// BEFORE any decoupled-branch behavioral code. The decoupled
// brain/paraphrase pricing must be FATAL-at-boot (never silently
// mis-price a paid LLM call) — the SAME posture as Cartesia/Hume in
// index.js provisionPricing().
//
// `decoupled` is data-driven (per-creator `creators.decoupled`; there is
// NO global env gate — D7 fail-safe + the migration default make the
// flag inert until a creator is flagged). So — exactly like the verified
// Hume per-creator-override probe (index.js:127-163) — we probe for any
// decoupled creator; if one exists, BRAIN_*/PARAPHRASE_* pricing is
// required at boot. Probe FAILURE → defer to the lazy
// getBrainPricing()/getParaphrasePricing() throw (C4 resilience: a
// Supabase blip at Fly boot must NOT crash-loop a fleet that has zero
// decoupled creators).
//
// Note (M3 / α'): a decoupled creator also requires the α' TTS layer
// (the deep answer is spoken in the cloned voice — Gemini stock voice is
// never user-facing). index.js calls this from INSIDE provisionPricing()
// (α' already known on). Enforcing "decoupled ⇒ α' on" at flag-flip time
// is owed to the M3 `admin_set_creator_decoupled` RPC, not this gate.
//
// Fully DI'd (probe / pricing getters / log / fatal) so the boot gate is
// a real unit test, not an un-testable top-level-await + process.exit
// side effect. Mirrors the proxy idiom (proxy-handlers
// `_humePricingPrimeForBoot`, retrieve-knowledge-v2-client `getConfig`).

import { getBrainPricing } from './brain-bridge.js';
import { getParaphrasePricing } from './paraphrase.js';

/**
 * @param {object} a
 * @param {() => Promise<{found?:boolean, error?:string}>} a.probeAnyDecoupledCreator
 *        resolves `{found:true}` if ≥1 creator has `decoupled=true`,
 *        `{found:false}` if none, `{error}` on a query error.
 * @param {boolean} a.ttsLayerEnabled  VOICE_TTS_LAYER_ENABLED. Audit C2:
 *        a decoupled creator with α' OFF is itself FATAL — the decoupled
 *        deep-answer is spoken in the cloned voice; with α' off there is
 *        no TTS bridge and Gemini stock voice would leak (CLAUDE.md hard
 *        rule). This is why index.js MUST call this BEFORE its
 *        `!VOICE_TTS_LAYER_ENABLED` early-return — the gate can never be
 *        silently skipped by the two flags disagreeing.
 * @param {() => void} [a.getBrain]      defaults to getBrainPricing
 * @param {() => void} [a.getParaphrase] defaults to getParaphrasePricing
 * @param {{warn?:Function, log?:Function}} [a.log]
 * @param {(msg:string)=>void} [a.fatal] defaults to console.error+exit(1)
 * @returns {Promise<{primed:boolean, fatal?:boolean, deferred?:boolean, inert?:boolean}>}
 */
export async function provisionDecoupledBrainPricing({
  probeAnyDecoupledCreator,
  ttsLayerEnabled = true,
  getBrain = getBrainPricing,
  getParaphrase = getParaphrasePricing,
  log = console,
  fatal = (msg) => { console.error(msg); process.exit(1); },
}) {
  let needDecoupled = false;
  let probeFailed = false;
  try {
    const r = await probeAnyDecoupledCreator();
    if (r && r.error) {
      log.warn?.(`[boot] decoupled-creator probe failed: ${r.error} — skipping decoupled pre-validation; lazy-validate at session-open if needed`);
      probeFailed = true;
    } else if (r && r.found) {
      needDecoupled = true;
    }
  } catch (e) {
    log.warn?.(`[boot] decoupled-creator probe threw: ${e?.message || e} — skipping decoupled pre-validation; lazy-validate at session-open if needed`);
    probeFailed = true;
  }

  if (needDecoupled) {
    // Audit C2 — α' MUST be on for any decoupled creator. Checked here
    // (not deferred to the M3 RPC) because index.js calls this BEFORE
    // its !VOICE_TTS_LAYER_ENABLED early-return, so this is the ONLY
    // backstop until the M3 flip-time RPC exists.
    if (!ttsLayerEnabled) {
      fatal(
        'FATAL: a creator is flagged decoupled but VOICE_TTS_LAYER_ENABLED ' +
          "is off — the decoupled deep-answer cannot reach the cloned voice " +
          "(Gemini stock voice would leak; CLAUDE.md hard rule). The α' TTS " +
          'layer is required for decoupled. Set VOICE_TTS_LAYER_ENABLED=1 or ' +
          'unflag the creator.',
      );
      return { primed: false, fatal: true };
    }
    try {
      // Prime BOTH singletons — a decoupled turn always fires the
      // paraphrase (dead-air mask) AND the deep answer.
      getBrain();
      getParaphrase();
    } catch (e) {
      fatal(`FATAL: a creator is flagged decoupled but decoupled brain pricing is misconfigured: ${e?.message || e}`);
      return { primed: false, fatal: true };
    }
    log.log?.('[boot] decoupled brain pricing primed (creator(s) flagged decoupled)');
    return { primed: true, fatal: false };
  }
  if (probeFailed) {
    log.warn?.('[boot] decoupled brain pricing deferred to lazy validation due to probe failure');
    return { primed: false, deferred: true };
  }
  return { primed: false, inert: true };
}
