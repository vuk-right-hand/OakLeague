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
  // p95 ≈ 2022ms; 2500 gives margin while bounding worst-case silence.
  retrieveCeilingMs = 2500,
  // Audit C1 — max time the turn_end handler waits for the deep answer
  // to finish speaking before it lets ttsBridge.turnEnd() send
  // continue:false. Bounded so a hung generator can't wedge teardown.
  turnSpokenTimeoutMs = 30000,
  log = console,
  captureException = () => {},
  now = () => Date.now(),
  makeAbort = () => new AbortController(),
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
    degraded: [],
    lastParaFirstMs: null,
    lastDeepFirstMs: null,
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
  function onUserTranscript(text, turnNumber) {
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
      log.info?.(`[decoupled] trivial Q detected (turn=${turnNumber} q="${t.question.slice(0, 40).replace(/[\r\n]/g, ' ')}") — paraphrase will carry the full answer; deep_answer skipped`);
    }
    turn = t;
    session.turns += 1;

    const hasQuestion = t.question.trim().length > 0;
    // Small — don't burn a retrieval call on an empty/garbage transcript
    // (the bridge will throw empty_input on the paraphrase/deep anyway).
    // P1-10 — also skip retrieval on trivial Qs (no deep_answer will use it).
    t.retrievePromise = hasQuestion && !t.isTrivial
      ? Promise.resolve()
          .then(() => retrieve(t.question, t.retrieveAbort.signal))
          .catch((e) => {
            log.warn?.(`[decoupled] retrieval degraded: ${e && e.message}`);
            captureException(e, { op: 'decoupled.retrieve', sessionId, turnNumber });
            return null;
          })
      : Promise.resolve(null);

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
    if (!t || t.done) { resolveSpoken(t); return; }
    t.done = true;
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
    if (t.isTrivial) {
      try { await t.paraphraseSpoken; } catch {}
      // lastCompleted intentionally NOT updated — see M3 above.
      resolveSpoken(t);
      return;
    }

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
      if (t.deepAbort.signal.aborted || fatal) return; // barged/fatal pre-stream

      const gen = generateDeepAnswer({
        persona,
        referenceEnvelopeText: envelopeText || null, // null ⇒ C2 persona-only
        question: t.question,
        apiKey,
        signal: t.deepAbort.signal,
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
      if (r.final) {
        t.lastAssistantResponse = r.final.text;
        lastCompleted = t;                       // C4 — completed-turn snapshot
      }
      if (r.degraded && r.degraded !== 'misconfigured') {
        t.degraded.push(`deep:${r.degraded}`);
        session.degraded.push(`d:${r.degraded}`);
      }
    } catch (e) {
      captureException(e, { op: 'decoupled.onTurnComplete', sessionId, turnNumber: t.turnNumber });
    } finally {
      // Audit C1/M4 — EVERY exit path (success, degrade, barge,
      // early-return, throw) resolves `spoken` so the index.js turn_end
      // handler's bounded await never hangs.
      resolveSpoken(t);
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
      degraded: session.degraded.slice(),
      lastParaFirstMs: session.lastParaFirstMs,
      lastDeepFirstMs: session.lastDeepFirstMs,
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
