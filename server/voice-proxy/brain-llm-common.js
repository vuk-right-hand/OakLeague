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
import Anthropic from '@anthropic-ai/sdk';

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

// Step-2 (Gemini→Haiku failover) — the Anthropic cost guard, mirrored from
// src/lib/voice/anthropic-client.ts (which is `import 'server-only'` and so
// CANNOT run in this plain-Node Fly proxy — Step-2 audit C3). The Anthropic
// API key works for EVERY model; a one-character env typo
// (claude-haiku-4-5-… → claude-opus-4-…) silently switches the failover to
// a ~30× model on the live voice path. Fail-closed: the model MUST start
// with `claude-haiku-` AND must be a pinned dated id (no `-latest`, per
// CLAUDE.md). Editing the family allow-list is a PR-reviewed code change,
// never an env flip anyone can do.
export function assertAnthropicModelAllowed(model, envName, ErrCls) {
  if (!model) throw new ErrCls('misconfigured', `${envName} not set`);
  if (/-latest$/i.test(model)) {
    throw new ErrCls(
      'misconfigured',
      `${envName} invalid: ${model}. Banned: -latest — pin a dated Haiku id (e.g. claude-haiku-4-5-20251001).`,
    );
  }
  if (!/^claude-haiku-/i.test(model)) {
    throw new ErrCls(
      'misconfigured',
      `${envName} must be a claude-haiku-* model (cost guard); got ${model}. ` +
        'Sonnet/Opus are not permitted via env — widen the allow-list in brain-llm-common.js if intentional.',
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
// Step-2 — Anthropic client cache (parallel to the Gemini one). Per-apiKey,
// no process-wide mutable defaults today. The Anthropic SDK is constructed
// HERE (not via src/lib/voice/anthropic-client.ts, which is server-only and
// unimportable in this Fly proxy — audit C3).
const _anthropicClients = new Map();
export function anthropicClientFor(apiKey) {
  const c = _anthropicClients.get(apiKey);
  if (c) return c;
  const n = new Anthropic({ apiKey });
  _anthropicClients.set(apiKey, n);
  return n;
}
// Audit Small: parity with query-rewrite.ts:182-187 — test-only reset,
// NODE_ENV-guarded so a stray prod caller can't race a live session.
export function _resetClientsForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetClientsForTests is test-only');
  }
  _clients.clear();
  _anthropicClients.clear();
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
export async function* streamGenerate({ client, model, systemInstruction, contents, signal, ErrCls, operation, maxOutputTokensOverride, failoverDetectMs, __spike_includeThoughts, __spike_thinkingLevel }) {
  const startedAt = Date.now();
  let firstChunkMs = null;
  let fullText = '';
  let lastUsage = null;
  // Step-2 audit C5 — when the caller (the deep answer) can fail over, a
  // STALLED Gemini stream (opened, but no first token) should be detected
  // FAST and treated as failover-eligible, not left to eat the full 5s
  // NO_DELTA_DEADLINE before degrading. A positive `failoverDetectMs`
  // tightens the no-delta window AND marks the resulting error so mapErr
  // codes it 'overloaded' (failover-eligible) instead of 'timeout'. The
  // paraphrase path passes nothing → unchanged 5s 'timeout' behavior.
  // Audit Small — failover-eligibility is keyed on whether the caller
  // PASSED a detect window, NOT on a value-comparison (an operator setting
  // BRAIN_FAILOVER_DETECT_MS to exactly NO_DELTA_DEADLINE_MS must not
  // silently disable failover).
  const noDeltaIsFailover = typeof failoverDetectMs === 'number' && failoverDetectMs > 0;
  const noDeltaBudgetMs = noDeltaIsFailover ? failoverDetectMs : NO_DELTA_DEADLINE_MS;
  const makeNoDeltaErr = () =>
    Object.assign(new Error('no-delta deadline exceeded'), {
      name: 'AbortError',
      __noDeltaFailover: noDeltaIsFailover,
    });

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
        // generation can't pump uncapped chars into TTS. Phase 3 C2: a
        // positive override (free + variable depth → tighter cap) wins; else
        // the operation default (deep answer 800 / paraphrase 120).
        maxOutputTokens: (typeof maxOutputTokensOverride === 'number' && maxOutputTokensOverride > 0)
          ? maxOutputTokensOverride
          : maxOutputTokensFor(operation),
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
  // Step-2 audit C1 — for the FAILOVER path, anchor the budget at
  // `startedAt` (pre-dispatch), NOT at post-open: the user-observed silence
  // we're bounding includes stream-open latency. A Gemini that accepts the
  // socket but is slow to return the stream object (the realistic overload
  // shape) must still fail over within ~failoverDetectMs of the user
  // finishing, not get a fresh budget after a slow open. The non-failover
  // path keeps the original from-open semantics.
  const streamOpenedAt = Date.now();
  const noDeltaAnchor = noDeltaIsFailover ? startedAt : streamOpenedAt;
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
            const remaining = noDeltaBudgetMs - (Date.now() - noDeltaAnchor);
            if (remaining <= 0) {
              return rej(makeNoDeltaErr());
            }
            noDeltaTimer = setTimeout(() => rej(makeNoDeltaErr()), remaining);
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
    // Step-2 audit C3 — tear down the underlying SDK stream before
    // re-throwing. On a chunk/no-delta deadline (especially the failover
    // path) the for-await is exited by a TIMER rejection, not by the
    // iterator completing — without an explicit return() the HTTP stream is
    // left open. FIRE-AND-FORGET (never `await`): the iterator is suspended
    // in a pending network await, and awaiting return() can hang the catch
    // until that await settles, wedging the whole failover. We only need to
    // REQUEST teardown; the SDK closes the socket when it can. (P0-4a: the
    // Gemini SERVER still bills a generation in full regardless of client
    // teardown — this frees our socket but does NOT recover the server cost
    // of a stall that had already begun generating; a documented kill-switch
    // blind spot on the rare stall-then-failover path. The common open-time
    // 503 never generated, so nothing leaks there.)
    try { const r = iter.return?.(); if (r && typeof r.then === 'function') r.then(undefined, () => {}); } catch {}
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
  // Step-2 audit M1+M2 — transient backend-capacity errors are
  // FAILOVER-ELIGIBLE: a distinct `overloaded` code so generateDeepAnswer
  // can retry on Claude Haiku. `@google/genai` surfaces ApiError.status as
  // a NUMBER (503 UNAVAILABLE "model overloaded", 429 RESOURCE_EXHAUSTED);
  // match on status first (reliable), message as a fallback. These are
  // OPEN-TIME rejections — generation never ran, so Google did NOT bill
  // → billed:false (no phantom cogs row; M2). Defensive: if deltas had
  // already streamed (not expected for an open-time 503), the partial DID
  // bill — preserve it so the leg is still written. An AbortError (barge)
  // is NEVER overloaded.
  // Step-2 audit C5 — a pre-first-delta STALL on a failover-capable caller
  // is failover-eligible (Gemini opened but delivered nothing within the
  // tight detect window). No token was delivered → treat as not-billed
  // (billed:false): no phantom Gemini leg, and on the failover-success path
  // this error is swallowed anyway. An input-only billing tail on a true
  // stall is a negligible, documented under-count.
  if (e?.__noDeltaFailover === true) {
    const err = new ErrCls('overloaded', 'no first token within failover-detect window');
    err.partial = { text: '', inputTokens: null, outputTokens: null, thoughtsTokens: null, billed: false };
    return err;
  }
  const status = typeof e?.status === 'number' ? e.status : null;
  const isOverloaded =
    e?.name !== 'AbortError' &&
    (status === 503 ||
      status === 429 ||
      /\b(unavailable|overloaded|resource[_ ]exhausted)\b/i.test(e?.message || ''));
  if (isOverloaded) {
    const err = new ErrCls('overloaded', e?.message || 'overloaded');
    err.partial = partialState.text
      ? billedPartial(partialState.text, partialState.lastUsage)
      : { text: '', inputTokens: null, outputTokens: null, thoughtsTokens: null, billed: false };
    return err;
  }
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

// ── Step-2: Claude Haiku failover generator ─────────────────────────────
//
// streamGenerateAnthropic mirrors streamGenerate's CONTRACT exactly so the
// orchestrator / streamToTts / cogs path are unchanged on failover:
//   yields `{ delta }` per non-empty text fragment, then EXACTLY ONE
//   `{ final:true, text, usage:{inputTokens,outputTokens,thoughtsTokens},
//      startedAt, firstChunkMs, latencyMs }`.
//
// It accepts the SAME Gemini-shaped `{ systemInstruction, contents }` the
// brain bridge already assembles (with the P0-5 L1/L2/L3 injection defense)
// and maps it to Anthropic's `{ system, messages }` internally so the
// failover call in generateDeepAnswer is symmetric with the primary call.
//
// EVERY streamGenerate guard is replicated (audit M4): chunk-deadline +
// no-delta-deadline racing, max_tokens cap, thinking-block FILTER, the
// `.partial`/billed cogs contract. The contract DIVERGES from Gemini on ONE
// axis (audit C2): Anthropic does NOT bill-in-full on a client abort — it
// stops generating when the connection closes and bills only the tokens
// emitted up to the abort. The P0-4a "server bills in full on client abort"
// rule is GEMINI-ONLY and explicitly does NOT transfer here. We therefore
// track cumulative `output_tokens` per message_delta and bill the
// partial-to-abort, never a full-gen estimate.

// Map Gemini-shaped contents → Anthropic messages. Anthropic requires the
// first message be role:user and STRICT user/assistant alternation (Gemini
// is lenient). The L3 model-ack turn (role:'model') becomes role:'assistant'.
// Audit M3 — fail LOUD on a shape Anthropic would reject (or that would
// silently drop the injection-defense turn structure).
export function geminiContentsToAnthropicMessages(contents, ErrCls) {
  const messages = [];
  for (const c of contents || []) {
    const role = c?.role === 'model' ? 'assistant' : 'user';
    const text = Array.isArray(c?.parts)
      ? c.parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
      : '';
    messages.push({ role, content: text });
  }
  if (messages.length === 0 || messages[0].role !== 'user') {
    throw new ErrCls('misconfigured', 'anthropic messages must start with a user turn');
  }
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      throw new ErrCls('misconfigured', 'anthropic messages must strictly alternate user/assistant');
    }
  }
  return messages;
}

// Audit C2 — the Anthropic billed-partial shape. `billed:true` means the
// request reached the server (we saw input_tokens via message_start); the
// token counts are the LAST observed cumulative values (the terminal
// message_delta carrying the final count does NOT arrive on abort).
function anthropicBilledPartial(text, inputTokens, outputTokens) {
  return {
    text,
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    // Extended thinking is OFF for the Haiku failover; no separate
    // thinking-token field on this path. Kept for cogs-shape parity.
    thoughtsTokens: null,
    billed: true,
  };
}

function mapAnthropicErr(e, ErrCls, { text, inputTokens, outputTokens }) {
  const status = typeof e?.status === 'number' ? e.status : null;
  const name = e?.name || '';
  let code;
  // Anthropic overload is 529 (their dedicated code) or 503; 429 is rate
  // limit. All transient. (We're already on the fallback here, so the
  // orchestrator just degrades — but the code is honest.)
  if (status === 529 || status === 503 || status === 429) code = 'overloaded';
  else if (name === 'AbortError' || name === 'APIUserAbortError') code = 'timeout';
  else code = 'network_error';
  const err = new ErrCls(code, e?.message || code);
  // Billed iff the request reached the server (message_start gave us
  // input_tokens). A pre-dispatch abort / connection-refused did NOT bill
  // → billed:false, no phantom row (mirrors the Gemini M7 reasoning).
  const billed = inputTokens !== null && inputTokens !== undefined;
  err.partial = billed
    ? anthropicBilledPartial(text, inputTokens, outputTokens)
    : { text: '', inputTokens: null, outputTokens: null, thoughtsTokens: null, billed: false };
  return err;
}

export async function* streamGenerateAnthropic({ client, model, systemInstruction, contents, signal, ErrCls, operation, maxOutputTokensOverride }) {
  const startedAt = Date.now();
  let firstChunkMs = null;
  let fullText = '';
  let inputTokens = null;   // from message_start
  let outputTokens = null;  // cumulative, last seen message_delta (C2)

  // Mirror streamGenerate's pre-dispatch abort guard — a signal already
  // aborted means the request never reached the server: it did NOT bill.
  if (signal?.aborted) {
    const err = new ErrCls('timeout', 'aborted before dispatch (anthropic not billed)');
    err.partial = { text: '', inputTokens: null, outputTokens: null, thoughtsTokens: null, billed: false };
    throw err;
  }

  // throws misconfigured on a bad message shape (M3) — BEFORE any paid call.
  const messages = geminiContentsToAnthropicMessages(contents, ErrCls);

  let stream;
  try {
    stream = await client.messages.create(
      {
        model,
        // Anthropic REQUIRES max_tokens. Match the Gemini deep-answer budget
        // (audit M4) so the failover answer is the same length — Phase 3 C2:
        // inherit the same tier-aware override the primary path used.
        max_tokens: (typeof maxOutputTokensOverride === 'number' && maxOutputTokensOverride > 0)
          ? maxOutputTokensOverride
          : maxOutputTokensFor(operation),
        temperature: 0.4,
        system: systemInstruction,
        messages,
        stream: true,
      },
      // Audit M5 — barge-in: the AbortSignal goes in the request options
      // (2nd arg). On abort the SDK aborts the underlying fetch → iteration
      // throws → mapAnthropicErr classifies it 'timeout' with a billed
      // partial-to-abort.
      signal ? { signal } : undefined,
    );
  } catch (e) {
    throw mapAnthropicErr(e, ErrCls, { text: '', inputTokens, outputTokens });
  }

  const iter = stream[Symbol.asyncIterator]();
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
          new Promise((_res, rej) => {
            if (firstChunkMs !== null) return; // already had a delta
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
      const event = result.value;
      const type = event?.type;
      if (type === 'message_start') {
        const u = event.message?.usage;
        if (u) {
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
        }
      } else if (type === 'message_delta') {
        // output_tokens is CUMULATIVE here (audit C2). Keep the latest.
        // Audit M1 — do NOT overwrite inputTokens from message_delta: the
        // authoritative full prompt count arrives ONCE in message_start;
        // message_delta usage may omit it or echo a cache-adjusted value,
        // either of which would clobber the correct number.
        const u = event.usage;
        if (u && typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
      } else if (type === 'content_block_delta') {
        // Audit M4 — ONLY text deltas reach TTS. `thinking_delta` /
        // `input_json_delta` are filtered so chain-of-thought never
        // streams into the cloned voice (defensive; extended thinking is
        // off for Haiku, but a future config flip must not leak).
        const d = event.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
          fullText += d.text;
          yield { delta: d.text };
        }
      }
    }
  } catch (e) {
    // Tear down the underlying request so a deadline-fired race doesn't
    // leave the HTTP stream running (and billing) in the background.
    try { stream.controller?.abort?.(); } catch {}
    throw mapAnthropicErr(e, ErrCls, { text: fullText, inputTokens, outputTokens });
  }

  if (!fullText || fullText.trim().length === 0) {
    // A content-filtered / empty response still billed input on the server.
    const err = new ErrCls('invalid_response_shape', 'anthropic stream produced empty text');
    err.partial = anthropicBilledPartial(fullText, inputTokens, outputTokens);
    throw err;
  }

  yield {
    final: true,
    text: fullText,
    usage: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      thoughtsTokens: null,
    },
    startedAt,
    firstChunkMs,
    latencyMs: Date.now() - startedAt,
  };
}
