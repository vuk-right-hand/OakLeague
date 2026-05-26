// decoupled-orchestrator.js — DECOUPLED_BRAIN_PLAN P1-5.2.
//
// THE UX CORE. North star (project_decoupled_brain_northstar): the user
// must think "HOLY FUCK — that's EXACTLY what he says." Everything here
// serves that: first audio FAST, paraphrase→deep-answer SEAMLESS (one
// continuous utterance, no two-voice overlap, no dead air), barge-in
// INSTANT, a failure NEVER reaching the user as silence or an error.
//
// Lifecycle (Gemini-event driven). The TTS turn lifecycle
// (turnStart/turnEnd) is owned by index.js's client turn handler; we
// only stream sendText into it — BUT the index.js turn_end handler
// MUST `await awaitTurnSpoken()` before it calls ttsBridge.turnEnd()
// (audit C1: otherwise `continue:false` races ahead of the off-Live
// deep answer and the creator's actual answer is truncated to just the
// hedge — the inverse of the north star).
//
//   onUserTranscript(text, turnNumber)   ← Gemini input_transcription
//     A new utterance SUPERSEDES any still-streaming previous turn
//     (the user moved on — abort it, don't talk over them). Then:
//     start retrieval (parallel, abortable, BOUNDED) + stream the
//     hedged PARAPHRASE to TTS now (the dead-air mask).
//
//   onTurnComplete()                     ← Gemini turn_complete
//     await retrieval UP TO retrieveCeilingMs (audit M3: an unbounded
//     retrieve = seconds of dead air after the paraphrase; on timeout
//     degrade to persona-only so the answer starts immediately), then
//     stream the DEEP ANSWER to TTS, its first chunk gated on the
//     paraphrase finishing. Resolves `turnSpoken` on EVERY exit path
//     (success / degrade / barge / early-return) — audit C1/M4.
//
//   onInterrupted()                      ← Gemini interrupted (barge-in)
//     abort retrieval + both generators of the SPEAKING turn; each
//     throws with `.partial` → we still write the cogs leg IFF the
//     server actually billed (audit C3: a pre-dispatch abort did NOT
//     bill — `.partial.billed===false` ⇒ no phantom cogs row).
//
// Error routing (C2 contract): only 'misconfigured' → onFatal (caller
// 1011) AND it latches `fatal` so no second paid call / second teardown
// can fire. Every other code degrades invisibly.
//
// Fully DI'd so the UX-critical sequencing is unit-tested in isolation.

// P1-10 trivial-Q classifier (2026-05-20). For greetings, hearing checks,
// mic checks, and other conversational filler, the off-Live deep_answer
// is wasted work: the user gets a hedged paraphrase ("Let me reflect on
// how to best frame this…") followed by a slightly-different deep answer
// ("Yeah I can hear you, what would you like to talk about?") for what
// should be a single 5-word reply. On a detected trivial Q the
// orchestrator now SKIPS the deep_answer entirely; the paraphrase IS the
// answer (paraphrase.js's PARAPHRASE_SYSTEM_SUFFIX handles trivial Qs
// directly, producing a short in-persona answer).
//
// The patterns are intentionally NARROW (false-positives waste a real
// answer; false-negatives produce mild redundancy but still correct).
// P1-10 audit C3 — all patterns anchored ^…$ so a substantive question
// like "can you hear me on this question about pricing?" is NOT
// misclassified. Pre-fix the hearing-check pattern matched mid-string
// via `\b…\b`.
// P1-10 audit M4 — added thanks/bye/ok/wassup/hello-hello coverage.
// Length-bounded (60 chars) is defense-in-depth on top of anchoring.
const TRIVIAL_Q_PATTERNS = [
  // Greetings
  /^(hi|hello|hey|yo|sup|hola)[\s,!?.]*$/i,
  /^hello hello[\s,!?.]*$/i,
  /^(yo |hey )?(wassup|whats up|what'?s up|wzup)[\s,!?.]*$/i,
  // Hearing / connectivity checks (full-string anchored). The verb alt
  // includes both bare "listen/listening" and "listen to/listening to" so
  // "are you actually listening" matches; the optional adverb slot covers
  // "still / actually / really" wraps without falsely admitting trailing
  // clauses (anchored end-of-string defeats those).
  /^(can|do|are) you (still |actually |really )?(hear|hearing|listen|listening|listen to|listening to)( me| us)?[\s,!?.]*$/i,
  /^are you (there|listening|on|here|with me)[\s,!?.]*$/i,
  // Greetings of time-of-day (full-string anchored)
  /^good (morning|afternoon|evening|day|night)[\s,!?.]*$/i,
  // Mic / test / check (full-string anchored)
  /^(test(ing)?|check|mic check|mic test|hello there|one two three)[\s,!?.]*$/i,
  // Closings / acknowledgments
  /^(thanks?|thank you|ty|tysm|appreciate it|much obliged)[\s,!?.]*$/i,
  /^(bye|goodbye|see ya|see you|later|peace|catch you later)[\s,!?.]*$/i,
  /^(ok|okay|got it|gotcha|cool|nice|sweet|cheers|alright|sounds good)[\s,!?.]*$/i,
];
export function isTrivialQuestion(text) {
  const t = (text || '').trim();
  if (!t || t.length > 60) return false;
  return TRIVIAL_Q_PATTERNS.some((re) => re.test(t));
}

// B2 (audit M1) — conservative follow-up detector. The prior-answer continuity
// preamble is attached ONLY when the current utterance looks like it refers
// back to the previous turn, so a FRESH unrelated question gets a clean,
// stateless prompt (no answer-looping / topic-drift, no needless input tokens).
// Two signals: explicit continuation cues, or a VERY short deictic question
// ("why?", "and that?", "how so?"). Deliberately narrow — a false negative just
// means a stateless answer (today's behavior), a false positive feeds one
// bounded background paragraph.
//
// Re-audit C3 — the deictic branch was ≤5 words, which matched ordinary
// substantive short questions that merely CONTAIN a wh/pronoun token: "how do I
// start?" (4w), "why does this work?" (4w), "is it worth it?" (4w). Each wrongly
// threaded the entire prior answer + steered retrieval → topic-drift, and (with
// the C2 loop now closed by the preamble guard) widened the poisoning window.
// Tightened to ≤3 words: a genuine bare-deictic follow-up ("why?", "how so?",
// "and that?") is ≤3; the substantive 4-word questions above no longer match.
// The explicit-cue branch (continue/more/go on/elaborate…) is unchanged and
// already covers the intended "please continue" / "tell me more" cases.
const FOLLOWUP_CUE_RE =
  /\b(continue|go on|keep going|carry on|finish|more|elaborate|expand|and then|what else|go deeper)\b/i;
const FOLLOWUP_DEICTIC_RE = /\b(that|those|this|these|it|them|why|how|again)\b/i;
export function looksLikeFollowUp(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  if (FOLLOWUP_CUE_RE.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 3 && FOLLOWUP_DEICTIC_RE.test(t);
}

export function makeDecoupledOrchestrator({
  generateParaphrase,
  generateDeepAnswer,
  retrieve,            // (question, signal) → Promise<string|null> (L2 envelope | null)
  ttsSendText,         // thin closure over ttsBridge.sendText (index.js owns try/catch)
  logBrainLeg,         // ({userId,sessionId,turnNumber,leg}) → {ok}
  persona,
  apiKey,
  userId,
  sessionId,
  onFatal,             // (code) → caller closes WS 1011 (misconfigured only)
  onPersonaNull,       // () → P1-5.4 breadcrumb
  // Audit M3 — hard ceiling on awaiting retrieval before the deep
  // answer starts. Past this, ground on nothing (C2 persona-only) so
  // the user never hears dead air after the hedge. P0 measured retrieval
  // p95 ≈ 2022ms.
  // 2026-05-21 — bumped 2500 → 3500. Before the decoupled latency fix,
  // retrieval (~2.5s measured live) hid entirely inside Gemini's 7-21s
  // discarded-generation wait, so the ceiling never bit. Now the deep
  // answer starts at the transcript (+250ms) and retrieval is ON the
  // critical path: a 2.6s retrieve against a 2500ms ceiling = coin-flip
  // persona-only fallback. 3500 keeps grounding (the north star) while
  // still bounding worst-case silence to 3.5s if retrieval truly hangs.
  // Real fix for the latency is making retrieve faster (dead semantic
  // cache + starved rerank — see next pass), not a looser ceiling.
  retrieveCeilingMs = 3500,
  // Audit C1 — max time the turn_end handler waits for the deep answer
  // to finish speaking before it lets ttsBridge.turnEnd() send
  // continue:false. Bounded so a hung generator can't wedge teardown.
  turnSpokenTimeoutMs = 30000,
  // DECOUPLED_BRAIN_PLAN — paraphrase (the dead-air latency mask) is OFF by
  // default. When false, the deep answer is the SOLE voice: no hedge opener,
  // no two-mode trivial path, no confidence-then-retreat contradiction. The
  // ~1.5-2s pre-answer silence is the accepted trade (every SOTA voice
  // product lives with it). Flip PARAPHRASE_ENABLED=1 only when a model
  // generation can produce a GROUNDED opener fast enough to be worth it.
  paraphraseEnabled = false,
  // Phase 3 — session tier (snapshot from sessions.tier_at_session via
  // consumed.tier). Gates the variable-depth word budget in the deep-answer
  // assembler (free tighter, paid full). Default 'free' = the SAFE (tighter)
  // budget if a caller ever omits it — never accidentally hand a free session
  // the paid-length budget. Inert unless BRAIN_DEPTH_MODE=variable.
  tier = 'free',
  log = console,
  captureException = () => {},
  now = () => Date.now(),
  makeAbort = () => new AbortController(),
  // Per-utterance "deep answer done" signal (2026-05-25). Fired when a
  // non-barged turn finishes streaming its audio to TTS — the EARLY, accurate
  // boundary (the client turn_end / Gemini turn_complete lands +6–20s later in
  // decoupled mode). index.js forwards it to the browser, which flushes the
  // Simli tail-carry (the last ≤187ms that was stranded → "cut off mid-word").
  onDeepAnswerDone = () => {},
}) {
  if (!persona && typeof onPersonaNull === 'function') {
    try { onPersonaNull(); } catch {}
  }

  let turn = null;            // the latest-created turn
  let lastCompleted = null;   // last turn whose deep answer FINISHED (C4)
  let fatal = false;          // C2 — latched on misconfigured; no 2nd paid call
  // C4 — per-session running tally (the teardown log was single-turn,
  // blind to a session that degraded on turns 1-4 but not turn 5).
  const session = {
    turns: 0,
    barged: 0,
    // P1-10 audit M2 — observability counter for spurious-barge events
    // suppressed by the proxy's interrupted handler (Gemini Live's
    // parallel audio-gen timeline emitting interrupted with no actual
    // Cartesia/Hume playback being interrupted). Incremented by
    // recordInterruptedSuppressed() called from index.js. A rising rate
    // here indicates the architectural mismatch is hitting more often
    // (e.g., model verbose mode increased, Cartesia speed slowed).
    interruptedSuppressed: 0,
    trivialTurns: 0,
    // C-5 — turns whose user transcript looked truncated (>12s audio, transcript
    // <60% of expected chars). Retrieval skipped + persona-only. A rising rate
    // in prod = Gemini STT dropping long utterances; surfaced in metricsSnapshot.
    truncatedTurns: 0,
    // Step-2 — how many deep answers were carried by the Claude Haiku
    // failover (Gemini returned 'overloaded' / stalled before first token).
    // A rising rate in prod is the early-warning that Gemini reliability
    // degraded; surfaced in metricsSnapshot → session-end log + posthog.
    deepFailedOver: 0,
    degraded: [],
    lastParaFirstMs: null,
    lastDeepFirstMs: null,
    // Phase 3 — RUNNING MAX char length across the session's deep answers
    // (audit Small — a per-turn "last" would miss a mid-session ceiling
    // brusher). Read straight off session-end metrics for the depth A/B: are
    // paid sessions getting longer answers, and is anything approaching the
    // OUTPUT_CHAR_CEILING?
    maxDeepChars: null,
    // B1 — count of deep answers the model guillotined at MAX_TOKENS (cut,
    // potentially mid-thought). Was invisible before; a rising count means the
    // token cap is too tight for the depth being asked → tune the cap or the
    // word budget. Surfaced in metricsSnapshot.
    deepTruncated: 0,
  };

  function freshTurn(turnNumber) {
    const t = {
      turnNumber,
      question: '',
      // P1-10 (2026-05-20) — when true, the orchestrator skips
      // generateDeepAnswer entirely; the paraphrase is the full answer.
      // Set in onUserTranscript via isTrivialQuestion.
      isTrivial: false,
      retrievePromise: null,
      retrieveAbort: makeAbort(),
      paraphraseAbort: makeAbort(),
      deepAbort: makeAbort(),
      paraphraseSpoken: null, _resolveParaphraseSpoken: null,
      // Audit C1 — resolves when this turn has FINISHED streaming to TTS
      // (success, degrade, barge, or never-started). The index.js
      // turn_end handler awaits this before ttsBridge.turnEnd().
      spoken: null, _resolveSpoken: null,
      spokenResolved: false,
      done: false,            // onTurnComplete entered
      superseded: false,
      barged: false,          // set by abortTurn({barge:true}) — gates deep_answer_done
      deepStreamedAudio: false, // M3 — true once ≥1 deep delta reached TTS this turn
      wasTruncated: false,    // B2/M3 — set on MAX_TOKENS or char-ceiling for next-turn resume
      lastAssistantResponse: null,
      degraded: [],
    };
    t.paraphraseSpoken = new Promise((r) => { t._resolveParaphraseSpoken = r; });
    t.spoken = new Promise((r) => { t._resolveSpoken = r; });
    return t;
  }
  function resolveSpoken(t) {
    if (t && !t.spokenResolved) { t.spokenResolved = true; t._resolveSpoken(); }
  }

  // Whole-build audit C2 — second-guard char ceiling (per-turn TTS spend).
  // The server-side `maxOutputTokens` is the primary cap; this is the
  // belt-and-suspenders cap on emitted CHARS reaching TTS, matched to
  // gemini-bridge's load-bearing OUTPUT_TRANSCRIPT_MAX_CHARS=4000 (CLAUDE.md).
  // The deep answer fits comfortably; a runaway gets aborted with the
  // partial-text already streamed (no rude mid-word cut: we stop at the
  // first newline or sentence-boundary AFTER the cap, with a 200-char
  // slack window — the user hears a complete-sounding short answer).
  const OUTPUT_CHAR_CEILING = 4000;
  const OUTPUT_CHAR_SLACK = 200;

  async function streamToTts(gen, kind, turnNumber, { gateBeforeFirstSend, deepAbort } = {}) {
    // Whole-build audit M4 — capture firstChunkMs LOCALLY at first delta
    // (the brain-llm-common.streamGenerate `firstChunkMs` field only lands
    // on the terminal `final` event, never on deltas — so a barge mid-
    // stream had no metric. Wall-clock from streamToTts entry is the
    // user-observed "time to first audio" anchor, which is what the (A)
    // gate measures end-to-end anyway).
    const enteredAt = now();
    let firstSent = false;
    let final = null;
    let firstChunkMs = null;
    let charsEmitted = 0;
    let overflowAborted = false;
    try {
      for await (const ev of gen) {
        if (ev.final) { final = ev; continue; }
        if (!firstSent && gateBeforeFirstSend) { await gateBeforeFirstSend; firstSent = true; }
        if (ev.delta) {
          if (firstChunkMs === null) firstChunkMs = now() - enteredAt;
          // Whole-build audit C2 — once past the ceiling, ship up to the
          // FIRST sentence boundary (so the cloned voice doesn't truncate
          // mid-word) and then ABORT the rest of the stream. Pre-fix
          // bug: shipped 1 byte per delta past the ceiling and kept
          // iterating, which meant a model emitting `. xxx` 100× would
          // happily ride all the way to its natural end — the cap did
          // nothing. Correct semantics: hit a boundary OR hit the slack
          // window, EITHER WAY stop processing the stream.
          if (charsEmitted >= OUTPUT_CHAR_CEILING) {
            const tail = ev.delta;
            // Slack window: how many more chars are we allowed to emit?
            const remaining = (OUTPUT_CHAR_CEILING + OUTPUT_CHAR_SLACK) - charsEmitted;
            let endIdx = -1;
            const scanLen = Math.min(tail.length, remaining);
            for (let i = 0; i < scanLen; i++) {
              const c = tail.charCodeAt(i);
              if (c === 10 /* \n */ || c === 46 /* . */ || c === 33 /* ! */ || c === 63 /* ? */) {
                endIdx = i + 1;
                break;
              }
            }
            if (endIdx < 0) endIdx = scanLen; // no boundary in window → hard cap
            if (endIdx > 0) { ttsSendText(tail.slice(0, endIdx)); charsEmitted += endIdx; }
            overflowAborted = true;
            log.warn?.(`[decoupled] ${kind} char-ceiling exceeded — aborted at ${charsEmitted}c (turn=${turnNumber})`);
            try { deepAbort?.abort?.(); } catch {}
            try { gen?.return?.(); } catch {}
            break;
          }
          ttsSendText(ev.delta);
          charsEmitted += ev.delta.length;
        }
      }
    } catch (e) {
      const code = e && e.code;
      if (code === 'misconfigured') {
        fatal = true; // C2 — latch BEFORE onFatal; blocks any further paid call
        log.error?.(`[decoupled] ${kind} misconfigured: ${e.message}`);
        if (typeof onFatal === 'function') { try { onFatal('misconfigured'); } catch {} }
        return { degraded: 'misconfigured', final: null };
      }
      // Degrade bucket. Audit C3: write the billed leg ONLY if the
      // server actually billed. A pre-dispatch abort sets
      // `.partial.billed === false` — writing it would be a phantom
      // cost feeding the kill-switch a number that never happened.
      if (e && e.partial && e.partial.billed === true) {
        await safeLogLeg(e.partial, turnNumber, `${kind}.partial`);
      }
      log.warn?.(`[decoupled] ${kind} degraded (${code || 'unknown'}): ${e && e.message}`);
      return { degraded: code || 'unknown', final: null, firstChunkMs };
    }
    if (final) await safeLogLeg(final, turnNumber, kind);
    return {
      degraded: overflowAborted ? 'char_ceiling' : null,
      final,
      firstChunkMs: firstChunkMs ?? final?.firstChunkMs ?? null,
    };
  }

  async function safeLogLeg(leg, turnNumber, tag) {
    try {
      const r = await logBrainLeg({ userId, sessionId, turnNumber, leg });
      if (!r || r.ok !== true) {
        // Audit M6 — a billed call with no cogs row blinds the
        // kill-switch. logBrainLeg already captureExceptions the RPC
        // error + recordFailure (shared consecutive-failure escalation);
        // surface the decoupled context too so it isn't a silent warn.
        log.warn?.(`[decoupled] cogs leg NOT written (${tag}) — kill-switch may under-count`);
        captureException(new Error('decoupled_cogs_leg_unwritten'), {
          op: 'decoupled.logBrainLeg', sessionId, turnNumber, tag,
        });
      }
    } catch (e) {
      captureException(e, { op: 'decoupled.logBrainLeg', sessionId, turnNumber, tag });
    }
  }

  // Abort a turn's in-flight work and unblock anything awaiting it.
  function abortTurn(t, { barge } = {}) {
    if (!t) return;
    if (barge) { session.barged += 1; t.barged = true; }
    try { t.retrieveAbort.abort(); } catch {}
    try { t.paraphraseAbort.abort(); } catch {}
    try { t.deepAbort.abort(); } catch {}
    if (t._resolveParaphraseSpoken) t._resolveParaphraseSpoken();
    resolveSpoken(t);
  }

  // ── Gemini input_transcription ────────────────────────────────────────
  // opts.truncationSuspected (C-5): index.js's early-trigger passes the SAME
  // truncation heuristic the legacy vector path applies. The early-trigger
  // used to fire BEFORE that check, so a >12s utterance whose transcript Gemini
  // dropped >40% of would silently ground retrieval on a PARTIAL question and
  // answer it confidently — and decoupled answers from the TRANSCRIPT (not the
  // discarded audio), so truncation hits harder here than legacy. When set we
  // skip retrieval (persona-only, matching legacy) AND record it so the quality
  // loss is OBSERVABLE instead of silent (the C-5 symptom).
  // (opts read defensively — `= {}` only defaults `undefined`, not an explicit
  // null; read the field off a guarded ref so a stray null/non-object can't throw.)
  function onUserTranscript(text, turnNumber, opts) {
    const truncationSuspected = !!(opts && opts.truncationSuspected === true);
    if (fatal) {
      // C2 — session dying; no new paid work. Audit M7 — NOT a silent
      // return: onFatal already fired the user-visible WS 1011 + the
      // single teardown (index.js owns that). This breadcrumb makes the
      // "user spoke again during the teardown race" window observable
      // instead of an invisible no-op, so a slow teardown that lets a
      // late transcript through is greppable in triage.
      log.warn?.(`[decoupled] onUserTranscript after fatal latch — dropped (session terminating, turn=${turnNumber})`);
      return;
    }
    // Audit C4/M2 — a new utterance supersedes a still-streaming
    // previous turn. The user moved on; abort the old turn so we don't
    // talk over them and so onInterrupted/turn_end can't target the
    // wrong turn. Its `spoken` is resolved by abortTurn (unblocks any
    // pending turn_end await for it).
    if (turn && !turn.spokenResolved) {
      turn.superseded = true;
      abortTurn(turn);
    }
    const t = freshTurn(turnNumber);
    t.question = typeof text === 'string' ? text : '';
    // P1-10 — classify BEFORE starting paraphrase so the trivial flag is
    // observable by onTurnComplete (and the paraphrase loop, for capturing
    // lastAssistantResponse on the trivial path).
    t.isTrivial = isTrivialQuestion(t.question);
    if (t.isTrivial) {
      session.trivialTurns += 1;
      // Audit M1 — log length only, never the raw utterance (PII).
      log.info?.(`[decoupled] trivial Q detected (turn=${turnNumber} chars=${t.question.length}) — deep_answer ${paraphraseEnabled ? 'skipped; paraphrase carries it' : 'runs persona-only'}`);
    }
    // C-5 — suspected-truncated transcript (heuristic owned by index.js
    // `truncationSuspected`: >12s audio AND transcript < 60% of expected chars;
    // NB its denominator is BYTES-SENT, not speech-seconds, so a frame-dropped
    // long utterance can false-negative — a known limitation we accept). Skip
    // retrieval (grounding on a partial question is worse than persona-only) and
    // flag it so it isn't a silent quality loss. Length only in the log (PII).
    // Asymmetry vs legacy (intentional): the decoupled branch honors the
    // truncation skip but NOT the short-utterance skip — a short utterance is
    // fine to answer persona-only, but a TRUNCATED long one must not ground +
    // answer a fragment confidently.
    t.truncationSuspected = truncationSuspected;
    if (t.truncationSuspected) {
      session.truncatedTurns += 1;
      t.degraded.push('truncation');   // per-turn verbose form
      session.degraded.push('trunc');  // session-compact form (same event)
      log.warn?.(`[decoupled] input transcript truncation suspected (turn=${turnNumber} chars=${t.question.length}) — deep answer runs BRIEF persona-only (retrieval skipped)`);
    }
    turn = t;
    session.turns += 1;

    const hasQuestion = t.question.trim().length > 0;
    // Small — don't burn a retrieval call on an empty/garbage transcript
    // (the bridge will throw empty_input on the paraphrase/deep anyway).
    // P1-10 — also skip retrieval on trivial Qs (no deep_answer will use it).
    // C-5 — and skip on suspected truncation (don't ground on a partial Q).
    t.retrievePromise = hasQuestion && !t.isTrivial && !t.truncationSuspected
      ? Promise.resolve()
          .then(() => retrieve(t.question, t.retrieveAbort.signal))
          .catch((e) => {
            log.warn?.(`[decoupled] retrieval degraded: ${e && e.message}`);
            captureException(e, { op: 'decoupled.retrieve', sessionId, turnNumber });
            return null;
          })
      : Promise.resolve(null);

    if (!paraphraseEnabled) {
      // Paraphrase OFF (default) — deep answer is the sole voice. Resolve
      // paraphraseSpoken NOW so the deep answer's `gateBeforeFirstSend`
      // opens with zero delay (it streams as soon as retrieval resolves).
      // No paraphrase generation, no paraphrase cogs leg, no two-voice
      // handoff (kills the turn-4 Cartesia context-handoff failure mode +
      // the trivial-Q double-talk by construction).
      if (t._resolveParaphraseSpoken) t._resolveParaphraseSpoken();
      return;
    }

    (async () => {
      try {
        const gen = generateParaphrase({
          persona, question: t.question, apiKey, signal: t.paraphraseAbort.signal,
        });
        const r = await streamToTts(gen, 'brain_paraphrase', turnNumber, {
          deepAbort: t.paraphraseAbort,
        });
        // Whole-build audit M4 — record firstChunkMs even on barge/degrade
        // (streamToTts now returns it lazily from the first delta event).
        if (r.firstChunkMs != null) session.lastParaFirstMs = r.firstChunkMs;
        // P1-10 audit M3 — do NOT capture paraphrase text into
        // lastAssistantResponse even on trivial Qs. Trivial answers are
        // conversational filler with no semantic anchors; carrying them
        // forward as the "last response" pollutes the next turn's
        // retrieval context (callRetrieveKnowledgeV2's rewriter reads
        // this). On trivial, lastCompleted stays pointed at the PRIOR
        // substantive turn (or null if none).
        if (r.degraded && r.degraded !== 'misconfigured') {
          t.degraded.push(`paraphrase:${r.degraded}`);
          session.degraded.push(`p:${r.degraded}`);
        }
      } catch {
        // streamToTts no longer rethrows; defensive only.
      } finally {
        if (t._resolveParaphraseSpoken) t._resolveParaphraseSpoken();
      }
    })();
  }

  // ── Gemini turn_complete ──────────────────────────────────────────────
  async function onTurnComplete() {
    const t = turn;
    if (!t) { resolveSpoken(t); return; }
    // t.done — a prior onTurnComplete is ALREADY handling this turn. In
    // decoupled mode onTurnComplete fires twice: the early-trigger at
    // input_transcription (index.js) and the redundant Gemini-turn_complete
    // fallback. The IN-FLIGHT first call owns resolveSpoken (its finally fires
    // only after the deep answer has fully streamed to TTS). Calling
    // resolveSpoken HERE resolves t.spoken EARLY → index.js's turn_end handler
    // awaitTurnSpoken() returns immediately → ttsBridge.turnEnd() closes the
    // Cartesia context (_turnDead=true) → every subsequent deep-answer sendText
    // silently no-ops → 0 chars to Cartesia → dead air (cogs:
    // cartesia/voice_tts_characters=0 despite deep_first_ms set). Latent since
    // the early-trigger; EXPOSED when maxOutputTokens made Gemini's
    // turn_complete fire BEFORE the deep answer finished (the "relying on
    // Gemini being slow" trap). The fallback must NOT resolve — just return.
    if (t.done) return;            // fallback — in-flight call owns resolveSpoken (block above)
    t.done = true;
    // DIAG (2026-05-21) — phase timing so we can SEE where pre-audio latency
    // goes (retrieval wait vs deep-answer first token vs total). Logged once
    // per substantive turn below.
    const tcStart = now();
    let retrieveDoneMs = null;
    if (fatal) { resolveSpoken(t); return; }

    // P1-10 — trivial Q: paraphrase IS the answer. Wait for it to finish
    // streaming to TTS, then mark turn complete. No deep_answer, no
    // retrieval wait.
    //
    // P1-10 audit M3 — DO NOT set lastCompleted = t on a trivial turn.
    // lastAssistantResponse() reads lastCompleted and feeds it into
    // callRetrieveKnowledgeV2 as conversation context for the NEXT
    // turn. A trivial answer ("Loud and clear, Vuk. What's on your
    // mind?") is conversational filler with no semantic anchors; it
    // shouldn't poison the next turn's retrieval context. The PRIOR
    // substantive turn's response remains the lastCompleted value.
    if (t.isTrivial && paraphraseEnabled) {
      // Paraphrase carried the full trivial answer; nothing else to do.
      try { await t.paraphraseSpoken; } catch {}
      // lastCompleted intentionally NOT updated — see M3 above.
      resolveSpoken(t);
      return;
    }
    // Paraphrase OFF + trivial Q: fall through to the deep answer below. It
    // runs persona-only (retrieval was skipped for trivial in
    // onUserTranscript) and gives a short conversational reply ("Yes, loud
    // and clear"). Still NOT recorded as lastCompleted (filler, no anchors).

    try {
      // Audit M3 — bound the retrieval wait. The paraphrase bought a
      // beat; spending it on an unbounded retrieve = dead air.
      let envelopeText = null;
      if (!t.deepAbort.signal.aborted) {
        let timer;
        const ceiling = new Promise((res) => {
          timer = setTimeout(() => res('__retrieve_timeout__'), retrieveCeilingMs);
        });
        let raced;
        try { raced = await Promise.race([t.retrievePromise, ceiling]); }
        catch { raced = null; }
        finally { clearTimeout(timer); }
        if (raced === '__retrieve_timeout__') {
          t.degraded.push('retrieve:timeout');
          session.degraded.push('r:timeout');
          envelopeText = null; // persona-only, deep answer starts NOW
          // Audit M6 — the retrieval HTTP call is now useless (we will
          // never consume its result) but still RUNNING and BILLING up
          // to its budget. Abort it so the socket is killed and the
          // billing tail stops the instant we stop waiting.
          try { t.retrieveAbort.abort(); } catch {}
        } else {
          envelopeText = raced || null;
        }
      }
      retrieveDoneMs = now() - tcStart;
      if (t.deepAbort.signal.aborted || fatal) return; // barged/fatal pre-stream

      const gen = generateDeepAnswer({
        persona,
        referenceEnvelopeText: envelopeText || null, // null ⇒ C2 persona-only
        question: t.question,
        apiKey,
        signal: t.deepAbort.signal,
        // Phase 3 — tier-aware depth + M2 trivial floor. A trivial Q only
        // reaches the deep answer when paraphrase is OFF (it falls through
        // persona-only); forceBrief keeps that reply short instead of letting
        // variable mode answer "hey" with a 450-word story.
        // C-5 (audit M1) — also force brief on a SUSPECTED-TRUNCATED question:
        // we only half-heard it, so a short exploratory persona-only reply beats
        // a confident 450-word monologue answering a fragment.
        tier,
        forceBrief: t.isTrivial || t.truncationSuspected,
        // B2 — dialogue continuity. `lastCompleted` is the PRIOR substantive
        // turn here (t isn't assigned to it until this turn finishes). Only the
        // prior ANSWER is threaded (audit C1/C3 — never the raw prior STT, never
        // a model turn). Gated on looksLikeFollowUp (audit M1) so a fresh
        // question stays stateless. Skipped when THIS question is suspected-
        // truncated (we only half-heard it — anchoring to the prior answer would
        // compound the mishear). `truncated` lets the preamble tell the model to
        // resume rather than restart (audit M3).
        priorTurn:
          (!t.truncationSuspected && looksLikeFollowUp(t.question) && lastCompleted &&
            typeof lastCompleted.lastAssistantResponse === 'string')
            ? { answer: lastCompleted.lastAssistantResponse, truncated: lastCompleted.wasTruncated === true }
            : null,
      });
      const r = await streamToTts(gen, 'brain_deep_answer', t.turnNumber, {
        gateBeforeFirstSend: t.paraphraseSpoken,
        deepAbort: t.deepAbort,
      });
      // Whole-build audit M4 — first-chunk timing now lives outside `final`
      // so it's captured on barge/degrade too. Order matters: set
      // firstChunkMs before degraded-side-effects so the metrics line is
      // populated for a session that ended on a single barged deep turn.
      if (r.firstChunkMs != null) session.lastDeepFirstMs = r.firstChunkMs;
      // Re-audit M3 — did this turn actually stream audio to TTS? firstChunkMs
      // is set iff ≥1 delta reached streamToTts ⟺ Cartesia synthesized ⟺ the
      // Simli chunker holds a tail-carry worth flushing. Gates the
      // deep_answer_done emit below so a degraded/empty/early-return turn never
      // arms a flush of nothing (which trailing audio_out from a NEIGHBOURING
      // turn could otherwise keep re-arming). (Paraphrase is off in current
      // config; if it returns, a paraphrase-only turn's tail would need its own
      // flag — noted, not handled, since there's no paraphrase audio today.)
      t.deepStreamedAudio = r.firstChunkMs != null;
      if (r.final) {
        t.lastAssistantResponse = r.final.text;
        // Phase 3 — track the LONGEST deep answer this session (depth A/B +
        // ceiling watch). Substantive turns only; a trivial persona-only reply
        // isn't representative of the depth experiment.
        if (!t.isTrivial && typeof r.final.text === 'string') {
          session.maxDeepChars = Math.max(session.maxDeepChars ?? 0, r.final.text.length);
        }
        // B1 — surface a MAX_TOKENS guillotine (previously invisible). With the
        // cap now above the graceful 4000-char ceiling this should be rare; a
        // rising count means depth is outrunning the budget.
        if (r.final.finishReason === 'MAX_TOKENS') {
          session.deepTruncated += 1;
          log.warn?.(`[decoupled] deep answer hit MAX_TOKENS turn=${t.turnNumber} chars=${typeof r.final.text === 'string' ? r.final.text.length : 'na'}`);
        }
        // Step-2 — count a Haiku-carried turn (the final event flags it).
        if (r.final.failedOver === true) session.deepFailedOver += 1;
        // C4 — completed-turn snapshot. M3: a trivial Q answered by the deep
        // path (paraphrase-off mode) is still conversational filler — do NOT
        // make it the lastCompleted that feeds next-turn retrieval context.
        if (!t.isTrivial) {
          // B2 (audit M3) — was this answer cut short? Either the server
          // MAX_TOKENS guillotine OR the orchestrator's graceful char-ceiling
          // abort. Threaded into next turn's continuity preamble so "please
          // continue" resumes from the cut instead of restarting/fabricating.
          t.wasTruncated = (r.final.finishReason === 'MAX_TOKENS') || (r.degraded === 'char_ceiling');
          lastCompleted = t;
        }
      }
      if (r.degraded && r.degraded !== 'misconfigured') {
        t.degraded.push(`deep:${r.degraded}`);
        session.degraded.push(`d:${r.degraded}`);
      }
      // Per-turn latency breakdown (retrieve wait / deep first-token / total /
      // grounded). Useful observability, but audit M1 — gate behind
      // VOICE_DIAG_LOGS so it isn't a warn-level line on EVERY prod turn
      // (drowns real warns + log-volume cost). Flip the Fly secret to debug.
      if (process.env.VOICE_DIAG_LOGS === '1') {
        log.warn?.(
          `[decoupled] turn ${t.turnNumber} timing: retrieve_ms=${retrieveDoneMs} ` +
          `deep_first_ms=${r.firstChunkMs ?? 'na'} deep_total_ms=${r.final?.latencyMs ?? 'na'} ` +
          `grounded=${envelopeText ? 'y' : 'n'} degraded=${r.degraded || 'none'}`,
        );
      }
    } catch (e) {
      captureException(e, { op: 'decoupled.onTurnComplete', sessionId, turnNumber: t.turnNumber });
    } finally {
      // Audit C1/M4 — EVERY exit path (success, degrade, barge,
      // early-return, throw) resolves `spoken` so the index.js turn_end
      // handler's bounded await never hangs.
      resolveSpoken(t);
      // Per-utterance "deep answer done" — fire only when this turn actually
      // streamed audio (M3) and was NOT barged. Skipped on barge: both barge
      // paths now set t.barged (Gemini `interrupted` AND the client `cancel`
      // handler in index.js → onInterrupted, re-audit M1), and the browser also
      // dropped the Simli carry via cancel(); a flush signal would be a no-op at
      // best and could nudge a stale frame at worst. The browser gates a short
      // trailing-audio grace before flushing the carry.
      if (!t.barged && t.deepStreamedAudio) { try { onDeepAnswerDone(); } catch {} }
    }
  }

  // ── Gemini interrupted — barge-in ─────────────────────────────────────
  function onInterrupted() {
    // Abort the turn that is actually SPEAKING. With supersede-on-new-
    // transcript there is only ever one live turn (`turn`); aborting it
    // stops the voice instantly and (P0-4a) its generators throw with
    // `.partial` → streamToTts writes the billed leg iff it billed.
    abortTurn(turn, { barge: true });
  }

  // Audit C1 — the index.js turn_end handler MUST await this (decoupled
  // branch only) BETWEEN bridge.turnEnd() and ttsBridge.turnEnd(), so
  // continue:false is not sent until the deep answer finished speaking.
  // Bounded so a wedged generator cannot stall teardown forever.
  function awaitTurnSpoken(timeoutMs = turnSpokenTimeoutMs) {
    const t = turn;
    if (!t || t.spokenResolved) return Promise.resolve();
    return Promise.race([
      t.spoken,
      new Promise((res) => setTimeout(res, timeoutMs)),
    ]);
  }

  // C4 — the COMPLETED turn's answer, never the in-flight global.
  function lastAssistantResponse() {
    return lastCompleted ? lastCompleted.lastAssistantResponse : null;
  }

  // C4 — per-session aggregate, not just the last turn.
  function metricsSnapshot() {
    if (session.turns === 0) return null;
    return {
      turns: session.turns,
      barged: session.barged,
      // P1-10 audit M2 — observability for spurious-barge suppression.
      interruptedSuppressed: session.interruptedSuppressed,
      // P1-10 — observability for trivial-Q skip rate.
      trivialTurns: session.trivialTurns,
      // C-5 — suspected-truncated-transcript turns (persona-only, retrieval skipped).
      truncatedTurns: session.truncatedTurns,
      // Step-2 — Haiku failover rate (Gemini 503/stall early-warning).
      deepFailedOver: session.deepFailedOver,
      degraded: session.degraded.slice(),
      lastParaFirstMs: session.lastParaFirstMs,
      lastDeepFirstMs: session.lastDeepFirstMs,
      // Phase 3 — longest deep-answer char length this session (depth A/B +
      // ceiling watch).
      maxDeepChars: session.maxDeepChars,
      // B1 — count of MAX_TOKENS-guillotined deep answers this session.
      deepTruncated: session.deepTruncated,
      lastTurnNumber: turn ? turn.turnNumber : null,
    };
  }

  // P1-10 audit M2 — counter advance called from index.js's `interrupted`
  // handler when the suppression heuristic fires. Surfaces in
  // metricsSnapshot() so a session-end log line + sentry/posthog records
  // the rate. A rising rate in prod = the architectural mismatch is
  // hitting more often (verbose model, slow Cartesia, etc.).
  function recordInterruptedSuppressed() {
    session.interruptedSuppressed += 1;
  }

  return {
    onUserTranscript, onTurnComplete, onInterrupted,
    awaitTurnSpoken, lastAssistantResponse, metricsSnapshot,
    recordInterruptedSuppressed,
  };
}
