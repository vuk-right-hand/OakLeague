// brain-llm-common.js — DECOUPLED_BRAIN_PLAN P1 audit M5 + C1.
//
// Single source of truth shared by brain-bridge.js (deep answer) and
// paraphrase.js (dead-air mask). Audit M5 killed 4 drift surfaces that
// were copy-pasted across the two modules: the CLAUDE.md banned-model
// guard, fail-closed numeric env parse, the @google/genai client cache,
// and the thinking-family detector. Audit C1 moved the core call to
// STREAMING (the P0-4b (A) gate was measured on generateContentStream
// first-CHUNK; non-streaming made "first audio" = full-gen latency and
// made stream-to-Hume structurally impossible).
//
// streamGenerate is an async generator: it yields `{ delta }` text
// fragments as they arrive (caller pipes to TTS for the dead-air mask),
// then yields EXACTLY ONE terminal `{ final:true, usage, firstChunkMs,
// latencyMs, text }`. On abort it throws a typed error carrying
// `.partial` (audit M6 — P0-4a proved the server bills in full on a
// client abort, so a barged turn MUST still be cogs-loggable).

import { GoogleGenAI } from '@google/genai';

// CLAUDE.md voice rule — banned model strings. The ONE copy (was
// duplicated verbatim in both bridges — M5 drift surface). Mirror of
// query-rewrite.ts:84-85: reject -latest and undated -preview; allow
// dated GA / unsuffixed GA aliases.
export function assertModelAllowed(model, envName, ErrCls) {
  if (!model) throw new ErrCls('misconfigured', `${envName} not set`);
  const isLatest = /-latest$/i.test(model);
  const hasPreview = /-preview/i.test(model);
  const hasDatedPreview =
    /-preview-(?:\d{2,}-\d{4}|\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{2}-\d{4})/i.test(model);
  if (isLatest || (hasPreview && !hasDatedPreview)) {
    throw new ErrCls(
      'misconfigured',
      `${envName} invalid: ${model}. Banned: -latest, undated -preview.`,
    );
  }
}

// Fail-closed numeric env (mirrors proxy-handlers getCartesiaPricing /
// R4-S3): missing/empty/non-finite/non-positive → throw. No code default.
export function numOrThrow(envName, ErrCls) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || raw === '') {
    throw new ErrCls('misconfigured', `${envName} not set (fail-closed)`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ErrCls(
      'misconfigured',
      `${envName} must be a positive finite number (fail-closed); got '${raw}'`,
    );
  }
  return n;
}

// Audit M5/Small: robust family detection. `/^gemini-3/` also matched a
// hypothetical `gemini-30-flash`; require a `.` or `-` boundary. 2.5 (and
// older) → integer thinkingBudget:0; 3.x → thinkingLevel:'minimal'
// (CLAUDE.md: 3.1 renamed thinkingBudget → thinkingLevel). Audit M1: the
// thinkingBudget:0 silent-ignore caveat (plan §12 F2) is NOT settled —
// P1-9 must empirically assert thinking-off for the pinned model before
// the (A) gate is re-trusted; this only sets the field correctly.
export function thinkingConfigFor(model) {
  return /^gemini-3(\.|-)/.test(model)
    ? { thinkingLevel: 'minimal' }
    : { thinkingBudget: 0 };
}

const _clients = new Map();
// P1-9 whole-build audit C4 — the cached GoogleGenAI instance is
// per-apiKey, no process-wide state today. Latent risk: a future
// `@google/genai` migration that adds `client.defaults.thinkingConfig`
// (or any other client-level mutable default) would silently leak
// across BOTH spikes and prod within the same node process. If you
// add a client-level default in a future PR, expose a non-test-gated
// `_clearClients()` and call it from the spikes between phases.
export function clientFor(apiKey) {
  const c = _clients.get(apiKey);
  if (c) return c;
  const n = new GoogleGenAI({ apiKey });
  _clients.set(apiKey, n);
  return n;
}
// Audit Small: parity with query-rewrite.ts:182-187 — test-only reset,
// NODE_ENV-guarded so a stray prod caller can't race a live session.
export function _resetClientsForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetClientsForTests is test-only');
  }
  _clients.clear();
}

/**
 * Audit C1 — streaming core. Async generator.
 *
 * Yields: `{ delta: string }` for each non-empty text fragment, then
 * EXACTLY ONE `{ final: true, text, usage:{inputTokens,outputTokens},
 * firstChunkMs, latencyMs }`.
 *
 * Throws (typed via ErrCls, single-shot — caller degrades, never retries):
 *   - AbortError      → ErrCls('timeout')   with `.partial` (M6)
 *   - transport        → ErrCls('network_error') with `.partial`
 *   - empty final text → ErrCls('invalid_response_shape')
 *
 * `.partial = { text, inputTokens, outputTokens, billed:true }` — P0-4a:
 * the server-side generation is NOT cancelled by a client AbortSignal and
 * bills in full, so the caller MUST still write a cogs_log leg for a
 * barged turn (a partial usageMetadata may be absent → caller flags an
 * estimate; the contract guarantees the caller is never left with
 * nothing on the billed path).
 */
// Whole-build audit M5 — Gemini's server has no built-in "stop streaming
// after X seconds of no progress." If the network half-opens or the server
// stalls after the first delta, the for-await wedges forever, the
// orchestrator's t.spoken never resolves, awaitTurnSpoken waits its full
// 30s ceiling, and the user hears a few hundred ms of audio then 30s of
// dead air. 8s no-progress is the latency-budget ceiling (P0-4b measured
// 1st-chunk p95 ~ 1.5s; 8s = 5×). On expiry we throw 'timeout' with
// `.partial.billed === true` (the server billed the partial response by
// P0-4a) so the caller writes the cogs leg as a degrade. Env-overridable
// (whole-build audit S1) so a prod incident doesn't require a code change.
const CHUNK_DEADLINE_MS = Number.parseInt(process.env.BRAIN_CHUNK_DEADLINE_MS || '', 10) || 8000;
// P1-9 whole-build audit M6 — the chunk-deadline measures inter-chunk
// gap, not time-to-first-user-visible-byte. After M3's thought-part
// filter, a stream of all-thought chunks now produces ZERO user-visible
// deltas; the chunk-deadline keeps re-arming on each thought chunk so
// the user could hear nothing for the full `awaitTurnSpoken` ceiling
// (30s). The dedicated no-delta guard caps the time from stream open
// to the first non-thought delta. Empirically the (A)-gate p95 budget
// is ~2.2s; 5s gives 2× headroom.
const NO_DELTA_DEADLINE_MS = Number.parseInt(process.env.BRAIN_NO_DELTA_DEADLINE_MS || '', 10) || 5000;

// Whole-build audit C2 — uncapped per-turn TTS spend. The legacy
// audio-out path's `OUTPUT_TRANSCRIPT_MAX_CHARS=4000` cap was load-bearing
// for the 150% kill-switch (CLAUDE.md). On the decoupled text-out path,
// nothing capped output until now: a verbose persona-only generation
// could pump 30 KB into Cartesia at ~$0.000065/char ≈ $2/turn. Per-call
// `maxOutputTokens` is the server-side guard; the orchestrator adds a
// streaming-char ceiling as the second guard.
const PARAPHRASE_MAX_OUTPUT_TOKENS = 120;   // hedged single sentence (~80 words)
const DEEP_ANSWER_MAX_OUTPUT_TOKENS = 800;  // ~600 words; matches OUTPUT_TRANSCRIPT_MAX_CHARS=4000 budget
function maxOutputTokensFor(op) {
  if (op === 'brain_paraphrase') return PARAPHRASE_MAX_OUTPUT_TOKENS;
  return DEEP_ANSWER_MAX_OUTPUT_TOKENS;
}

// P1-9 whole-build audit C3 — `thoughtsTokenCount` plumbing. The PROD_DEPLOY_GATE
// 1c checklist needs to assert "thinking-off honored in the live session" by
// reading per-turn thoughts_tokens from cogs_log. Pre-fix, the SDK's
// `usageMetadata.thoughtsTokenCount` was discarded by streamGenerate — never
// reached the cogs leg's metadata jsonb. Now captured here, threaded through
// the bridge `final` event, and the orchestrator's logBrainLeg closure writes
// it into `meta.thoughts_tokens`. Zero migration; cogs_log.metadata is jsonb.
// P1-9 whole-build audit C1 — `__spike_includeThoughts` is a SPIKE-ONLY
// hook that lets `scripts/brain-p19-thinking-spike.mjs` force the API to
// emit thought parts THROUGH THIS function (the prod joiner), so the spike
// proves the filter works on the actual prod surface — not on a parallel
// re-implementation. Underscore-prefixed + named for grep so a code review
// rejects any non-spike caller; behavior is a no-op when false/undefined,
// which is the prod path.
export async function* streamGenerate({ client, model, systemInstruction, contents, signal, ErrCls, operation, __spike_includeThoughts, __spike_thinkingLevel }) {
  const startedAt = Date.now();
  let firstChunkMs = null;
  let fullText = '';
  let lastUsage = null;

  // Audit C3 — a signal already aborted BEFORE we dispatch means the
  // request never reached the server: it did NOT bill. Throw a typed
  // 'timeout' whose `.partial.billed === false` so the caller writes NO
  // cogs leg (a phantom row here over-counts and mis-feeds the 150%
  // kill-switch). Only a POST-dispatch abort (caught below / mid-stream)
  // is `billed:true` per P0-4a.
  if (signal?.aborted) {
    const err = new ErrCls('timeout', 'aborted before dispatch (server not billed)');
    err.partial = { text: '', inputTokens: null, outputTokens: null, billed: false };
    throw err;
  }

  // P1-9 whole-build audit C1 — spike-only override of thinkingConfig
  // so the M6 spike can drive thought-part emission THROUGH the prod
  // joiner. Prod callers leave both __spike_* fields unset; this branch
  // is a no-op.
  const baseThinking = thinkingConfigFor(model);
  const thinkingConfig = (__spike_includeThoughts || __spike_thinkingLevel)
    ? {
        ...(typeof __spike_thinkingLevel === 'string'
          ? { thinkingLevel: __spike_thinkingLevel }
          : baseThinking),
        ...(__spike_includeThoughts ? { includeThoughts: true } : {}),
      }
    : baseThinking;

  let stream;
  try {
    stream = await client.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction,
        temperature: 0.4,
        thinkingConfig,
        // Whole-build audit C2 — hard per-call output cap so a runaway
        // generation can't pump uncapped chars into TTS.
        maxOutputTokens: maxOutputTokensFor(operation),
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
  } catch (e) {
    throw mapErr(e, ErrCls, { text: '', lastUsage });
  }

  // Whole-build audit M5 — chunk-deadline wrapping of the for-await loop.
  // We can't pass a timeout to the SDK; instead race each `next()` against
  // a deadline timer. On expiry, abort our read; `mapErr` classifies it as
  // 'timeout' with `billed:true` partial state.
  const iter = stream[Symbol.asyncIterator]();
  // P1-9 whole-build audit M6 — no-delta deadline: independent of the
  // inter-chunk timer, this fires if the cumulative time since stream
  // open elapses without ANY user-visible delta (all chunks were
  // thought-only after M3 filter).
  const streamOpenedAt = Date.now();
  try {
    while (true) {
      let timer;
      let noDeltaTimer;
      let result;
      try {
        result = await Promise.race([
          iter.next(),
          new Promise((_res, rej) => {
            timer = setTimeout(
              () => rej(Object.assign(new Error('chunk deadline exceeded'), { name: 'AbortError' })),
              CHUNK_DEADLINE_MS,
            );
          }),
          // M6 — only races while firstChunkMs is still null; we set
          // the timer for the REMAINING time-to-first-delta budget.
          new Promise((_res, rej) => {
            if (firstChunkMs !== null) return; // already had a delta; rely on chunk-deadline
            const remaining = NO_DELTA_DEADLINE_MS - (Date.now() - streamOpenedAt);
            if (remaining <= 0) {
              return rej(Object.assign(new Error('no-delta deadline exceeded'), { name: 'AbortError' }));
            }
            noDeltaTimer = setTimeout(
              () => rej(Object.assign(new Error('no-delta deadline exceeded'), { name: 'AbortError' })),
              remaining,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (noDeltaTimer) clearTimeout(noDeltaTimer);
      }
      if (result.done) break;
      const chunk = result.value;
      // P1-9 audit M3 — filter out thought-parts BEFORE joining.
      // 3.x emits multiple parts per chunk and a part can carry
      // `thought:true` when `includeThoughts:true` (or some server
      // default we don't control) is in effect. The pre-fix joiner
      // concatenated thought text into the user-facing delta → would
      // leak chain-of-thought into the cloned-voice TTS output the
      // moment a future SDK or env-flip flipped the includeThoughts
      // default on. Filter is defensive; idempotent when no thought
      // parts exist (the common case). `chunk?.text` SDK convenience
      // accessor is bypassed when parts are present so the filter is
      // the authoritative path.
      const parts = chunk?.candidates?.[0]?.content?.parts;
      let delta = '';
      if (Array.isArray(parts) && parts.length > 0) {
        delta = parts.filter((p) => p && p.thought !== true).map((p) => p.text ?? '').join('');
      } else if (typeof chunk?.text === 'string') {
        delta = chunk.text;
      }
      const u = chunk?.usageMetadata;
      if (u) {
        lastUsage = {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: u.candidatesTokenCount ?? 0,
          // Audit C3 — null vs 0 vs missing all collapse to a single
          // null sentinel; the orchestrator's cogs writer treats null
          // as "absent" and 0 as "honored thinking-off."
          thoughtsTokens: u.thoughtsTokenCount ?? null,
        };
      }
      if (delta) {
        if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
        fullText += delta;
        yield { delta };
      }
    }
  } catch (e) {
    throw mapErr(e, ErrCls, { text: fullText, lastUsage });
  }

  if (!fullText || fullText.trim().length === 0) {
    // Audit C4 — a usage-bearing stream that produced only empty/
    // whitespace parts (content-filtered response: usageMetadata present,
    // text empty) STILL billed on the server (P0-4a). This throw MUST
    // carry `.partial` exactly like the abort/transport path, or the M6
    // caller writes no cogs leg for a billed call (kill-switch
    // under-fed). Was previously a bare throw — the silent billing hole.
    const err = new ErrCls('invalid_response_shape', 'model stream produced empty text');
    err.partial = billedPartial(fullText, lastUsage);
    throw err;
  }

  yield {
    final: true,
    text: fullText,
    usage: lastUsage ?? { inputTokens: 0, outputTokens: 0, thoughtsTokens: null },
    // Audit M2 — `startedAt` is the wall-clock anchor (epoch ms) the
    // orchestrator needs to compute TRUE first-audio for the (A)
    // dead-air gate; `firstChunkMs` alone omits the orchestrator's
    // TTS-handshake + scheduling delta. firstChunkMs is never null here
    // (empty text throws above), so no fallback — a no-delta final is
    // unreachable by construction.
    startedAt,
    firstChunkMs,
    latencyMs: Date.now() - startedAt,
  };
}

// Audit M6/C4 — the single billed-partial shape. The server bills in
// full on a client abort (P0-4a) AND on a content-filtered empty
// response, so EVERY post-open failure must hand the caller enough to
// write the cogs leg. `billed:true` is the caller's signal to write it.
function billedPartial(text, lastUsage) {
  return {
    text,
    inputTokens: lastUsage?.inputTokens ?? null,
    outputTokens: lastUsage?.outputTokens ?? null,
    // P1-9 whole-build audit C3 — thoughtsTokens on partial too.
    thoughtsTokens: lastUsage?.thoughtsTokens ?? null,
    billed: true,
  };
}

function mapErr(e, ErrCls, partialState) {
  const code = e?.name === 'AbortError' ? 'timeout' : 'network_error';
  const err = new ErrCls(code, e?.message || code);
  // P1-9 whole-build audit M7 — open-time DNS/TLS failures
  // (`ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`) did NOT bill on the
  // server; classifying them as billed:true writes phantom cogs rows
  // (cost=0 — kill-switch cost gate still correct — but inflates the
  // row count, distorting COUNT-based alerts). In-flight aborts /
  // half-open streams DID bill (P0-4a server bills in full on client
  // abort). Distinguish by error code.
  const sysCode = e?.cause?.code || e?.code || '';
  const isPreServer = sysCode === 'ENOTFOUND' || sysCode === 'ECONNREFUSED' || sysCode === 'EAI_AGAIN';
  err.partial = isPreServer
    ? { text: '', inputTokens: null, outputTokens: null, thoughtsTokens: null, billed: false }
    : billedPartial(partialState.text, partialState.lastUsage);
  return err;
}
