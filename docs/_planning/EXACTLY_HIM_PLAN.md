# Path to "Holy Fuck, That's EXACTLY Him" — Persona Fidelity Plan

Status: DESIGN (2026-05-22 night). No prod changes made. Execution + live testing
deferred to 2026-05-23 per Vuk. North star: `project_decoupled_brain_northstar` —
the recognition moment that makes recall→k>1 viral. This doc is the solution
Vuk asked for: how do we get from "good" to "that's EXACTLY him."

---

## The diagnosis, in one breath

Tonight I traced the full decoupled pipeline against prod (read-only) for creator
#1 `vuk_lehendas`. Three layers determine "is this him":

| Layer | State | Verdict |
|-------|-------|---------|
| **Acoustics** (does it SOUND like him) | Cartesia Sonic 3 cloned voice | ✅ him |
| **Facts** (does it KNOW his content) | v2 retrieval surfaces the right corpus | ✅ works |
| **Style** (does it TALK like him) | deep-answer brain runs on a 207-char template persona, in brief mode | ❌ **generic** |

So today the avatar says **correct things, in his voice, in generic-LLM words.**
That is precisely the "good but not him" valley. The gap is entirely in the
**style layer**, and it is cheaper to close than it looks.

### Evidence captured tonight (all read-only against prod)

- **Corpus is healthy & complete.** 89 v2 chunks (all embedded), 20 narrative
  units, all linked. Reprocess `done` 2026-05-20. One transcript:
  *"One-eyed man in the land of the blind."*
- **`current_corpus_version=1` is NOT a retrieval gate.** `creator_knowledge_topk_v2`
  hardcodes `chunker_version=2`; corpus_version only keys the semantic cache.
  There is no "switch to flip" blocking recall. (Corrects the earlier
  "v1-vs-v2 served version" framing.)
- **Retrieval delivers the content.** Replicated the full pipeline: the
  lumberjack/monk/hunter parable lives in *"Individual Worldviews."* RRF buries
  it at rank #5 (single-strong-chunk parent), but **Voyage rerank promotes it to
  #1 (0.62 vs 0.38).** Brain grounds on it (`assembleBrainContents`).
- **Wiring is on.** Fly boot: `RAG v2 wiring enabled`; `RAG_V2_PROXY_ENABLED=1`,
  shim + secret present. Double-answer bug structurally cleared (decoupled never
  injects into Gemini Live).
- **The persona is a 207-char stub:**
  > "You are Vucko. Topics you cover: mental models, Paradigm &worldview. Speak
  > as yourself. Address the user as {{user_name}} where natural. Outside your
  > experience: say so plainly, then offer what you do know."
  - `_creator_brain_compile_unsafe` builds it from `display_name` + `bio` +
    `creator_topics`. **`bio` is empty** → the stub. Zero idiolect, zero
    worldview, zero of how he actually talks.
- **Variable-depth is built but DISABLED.** No `BRAIN_DEPTH_MODE` secret on Fly →
  `buildDepthClause` falls back to BRIEF → every answer is 1-3 sentences. "Tell
  me the lumberjack story" → a 1-3-sentence summary, never his telling.
- **The architectural unlock:** the 207-char ceiling exists to dodge the
  gemini-3.1-flash-LIVE 200-token *resumption* regression. But in decoupled, the
  deep answer is a **stateless `generateContent`** on `BRAIN_MODEL` — no Live
  resumption, **so that constraint does not bind it.** The DB CHECK caps
  `system_prompt` at 2000 octets and we use 207. ~10× headroom unused, and the
  decoupled deep-answer brain could take far more than 2000 if we want.

---

## The fix — three levers, cheap → deep

### Lever 1 — Flip variable-depth ON  (config, minutes)
Set `BRAIN_DEPTH_MODE=variable` (Fly secret) + redeploy. Now stories get told
fully ("tell it fully and naturally in your own voice — do not truncate") instead
of summarized to 1-3 sentences. vuk's persona has no baked "concise sentences"
clause (decoupled branch omits it), so the C3 self-heal won't force brief — the
flip takes effect cleanly. Tier note: free caps ~150 words, paid ~450. Decide
whether the free recognition moment needs more than 150 (the lumberjack telling
is ~150 words — tight but workable).

**Risk:** longer answers raise per-turn COGS + latency. Kill-switch char ceiling
(4000) still bounds it. Instant rollback = unset the secret.

### Lever 2 — Style-faithful generation  (prompt/assembler, ~½ day)
Today L1 says *"use the reference only as background knowledge"* — which actively
pushes the model to **summarize** his words into generic advice. Add a style
directive (in the persona and/or a new assembler clause) that flips the framing:

> "When the reference contains your own words, stories, or analogies, retell them
> in YOUR phrasing and structure — reuse your exact metaphors and beats. Do not
> translate them into neutral advice. You ARE the person who said these things."

This is a few lines in `brain-bridge.js` + the persona. It's the difference
between "different people perceive value differently" and "imagine a lumberjack,
a hunter, a businessman and a monk given a forest — what do they see?"

### Lever 3 — Rich persona v2 ("voice extraction")  (the real lever, ~1-2 days)
Replace the template stub with a **voice-dense persona compiled from his actual
transcript.** New compile path (decoupled creators only; legacy Gemini-Live
creators keep the resumption-bound 2000-octet `system_prompt`):

1. **Extraction job:** LLM reads the creator's `sample_content` (+ narrative units)
   and produces a structured **persona card**:
   - Identity & arc (who he is, the 9-year journey, ex-nightlife → marketing/
     business/money-online).
   - Worldview axioms (paradigms→results; responsibility=power; subjective
     reality / "the contact lens society wears"; abundance).
   - Voice rules: blunt, direct second-person, profanity-for-emphasis
     ("a fucking bonanza"), story → principle → personal challenge.
   - Signature analogies & vocabulary (twins, lumberjack/hunter/monk, YouTube
     channel, obese-vs-skinny, "reality screen").
   - 2-3 **verbatim style exemplars** (short snippets of his actual prose) as
     concrete anchors regardless of what's retrieved that turn.
2. **Storage:** a new `persona_card text` column (or reuse `system_prompt` with a
   raised cap for decoupled). Deep-answer `systemInstruction = persona_card + L1 +
   depthClause`. Legacy path untouched.
3. **Recompile vuk → A/B the lumberjack telling before/after.**

This is what makes it unmistakably him — the model now has his worldview,
cadence, and metaphors as its operating identity, not just his name.

---

## Plus: recall reliability (so the content actually arrives)
Retrieval is correct but can time out on a slow-rewrite turn (~2.9s vs 3000ms
budget) → persona-only → "I don't know." Measured stages: rewrite 0.7-1.3s
(the variable), embed ~0.35s, topk ~0.15s, rerank ~0.4-0.6s. Mitigations:
- Semantic cache already makes repeat asks fast/reliable (15 rows exist).
- Optional: skip/shrink rewrite for clearly-standalone questions (no pronouns,
  no "that/this"), so a first-ask doesn't pay the rewrite tax.
- Optional: pre-warm on session-open.

Not the headline, but it's why recall is sometimes flaky. Worth a small pass.

---

## Suggested sequence for 2026-05-23
1. **Lever 1** (flip `BRAIN_DEPTH_MODE=variable`, redeploy) — immediate, reversible.
2. **Live test** (Vuk talks; I tail Fly logs for `retrieve_ms` + `grounded=y/n` +
   the actual answer) — establishes the real before-state with depth on.
3. **Lever 2** (style-faithful clause) — ship, retest.
4. **Lever 3** (persona v2 extraction) — the build that lands "holy fuck."
5. Optional: recall-reliability pass.

## Explicitly NOT the problem (so we don't chase them)
- Corpus version / "flip the switch" — not a gate.
- Haiku 503 failover — only helps when Gemini is DOWN; does nothing for recall or
  style. (Vuk's correction, 2026-05-22.)
- The 91 dead v1 chunks — storage hygiene, zero UX impact.
- The double-answer bug — structurally gone on decoupled.

## LIVE TEST FINDINGS — 2026-05-25 (Lever 1 on, headroom on, vuk=boardroom)

Test: "tell me a story about a lumberjack and a monk and a businessman." Result: avatar
said "I don't know of such a story" then segued into the oil/Ray-Dalio/British-pound-Soros
worldview content (all his) — then **cut off abruptly mid-answer**; on "please continue"
it said "I didn't get cut off, I finished."

Decoded against logs + prod data (read-only):
- **Headroom WORKED.** `decoupled.metrics ... truncated_turns=0 degraded=none`; retrieves
  1.5/2.3/3.0s, all under the 4000ms ceiling → NOT discarded, NOT a timeout. The recall
  miss is NOT latency.
- **Retrieval NAILED it.** The unit that contains the lumberjack vignette ("Individual
  Worldviews") reranked **#1 @ 0.76**, and it's only **1763 chars** (no 3500 truncation) —
  so lumberjack@987 + monk@1030 + businessman@1011 were ALL injected alongside oil@83 /
  dalio@198 / soros@473. The brain HAD the lumberjack lines in its #1 reference.
- **Root cause = STYLE/INSTRUCTION (Lever 2).** The brain read "a *story*", found only a
  one-line *illustration* (not a narrative arc), disclaimed it ("I don't know such a
  story"), and pivoted to the oil/Dalio/Soros material it could frame as an answer. The L1
  clause "use the reference only as background knowledge" actively encourages this
  abstraction. The word-for-word/BM25 instinct is correct *in general* (BM25 half is dead —
  every bm25_score=0 because websearch_to_tsquery ANDs terms the corpus doesn't contain
  verbatim) but is a RED HERRING here: retrieval already delivered the passage #1.

Two NEW concrete items surfaced (fold into the build):
- **B1 — output cut off mid-sentence.** `DEEP_ANSWER_MAX_OUTPUT_TOKENS=800` (~600 words);
  NO `finishReason`/MAX_TOKENS handling and the `OUTPUT_CHAR_CEILING` sentence-stop only
  fires at 4000 chars. A long boardroom answer hits 800 tokens and is guillotined. Fix:
  detect MAX_TOKENS → trim to last sentence boundary; add finishReason telemetry (auditor
  M7); reconsider the cap for "full story" turns. (Can't confirm exact length from logs —
  that's the missing telemetry.)
- **B2 — "please continue" can't work.** The decoupled deep answer is STATELESS:
  `assembleBrainContents` = [reference, ack, question], no dialogue history. `lastAssistant
  Response` only feeds the rewrite. Fix: thread the last turn's Q + answer into the
  deep-answer contents so follow-ups ("continue", "tell me more about that") have context.

Brainstorm (NOT triggered, per Vuk): when retrieval is ambiguous across units, the brain
could ask a one-line clarifier ("the lumberjack one, or the twins?"). v-next; the immediate
fix is Lever 2 (tell the thing), not a clarification dialog.

## Read-only diagnostic scripts added tonight (keep)
- `scripts/diag-v2-corpus.mjs` — creator/corpus/jobs/cache state.
- `scripts/diag-corpus-keyword.mjs` — keyword presence raw vs chunked.
- `scripts/diag-retrieve-v2.mjs` — full topk_v2 + Voyage rerank for a query.
- `scripts/diag-retrieve-latency.mjs` — per-stage latency probe.
- `scripts/diag-find-unit.mjs` — locate a narrative unit by keyword.

## Re-audit (2026-05-25, pre-commit) — auditor subagent, 2nd pass

Ran the auditor on the full uncommitted change set BEFORE local testing (Vuk's call:
clean tested code, not "audit/fixed unknown"). 3 Critical + 5 Medium + Small. All verified
against code, then fixed. One finding rejected with reason.

- **C1 (real)** — Haiku failover dropped `finishReason`: `streamGenerateAnthropic` never read
  `message_delta.delta.stop_reason` and `failoverToHaiku`'s final yield omitted it. So a cut
  Haiku answer was counted complete → `deepTruncated` blind + B2 told to RESTART not resume,
  exactly during a Gemini outage. Fix: capture stop_reason→'MAX_TOKENS', emit through both
  yields. Tests in brain-bridge.failover.test.js.
- **C2 (real)** — declarative-poisoning PERSISTENCE loop: prior answer feeds BOTH the rewriter
  AND the new B2 preamble, and L2 says "retell confidently" → a once-adopted false claim could
  self-reinforce across turns. Fix: continuity preamble now closes with a defer-to-reference/
  persona guard ("your own past words for recall, not authoritative fact").
- **C3 (real)** — `looksLikeFollowUp` deictic branch ≤5 words matched fresh substantive
  questions ("how do I start", "is it worth it") → wrongly threaded prior answer + steered
  retrieval, widening C2. Fix: tightened to ≤3 words; cue branch unchanged (still catches the
  intended "continue"/"more"/"go on").
- **M1 (real)** — client mic-tap `cancel` never called `onInterrupted`, so `t.barged` stayed
  false (the "skipped on barge" comment was false) AND the deep stream ran to completion +
  billed after a barge. Fix: cancel handler → `decoupledOrch.onInterrupted()` (idempotent).
- **M2** — clearTailFlush() on visibility-hidden (stale carry can't fire after backgrounding).
- **M3** — `deep_answer_done` now gated on `deepStreamedAudio` (a turn that streamed no audio
  has no tail to flush).
- **M4 (REJECTED the suggested fix)** — auditor proposed dropping Haiku to 800 tokens for cost.
  Rejected: that reintroduces the abrupt mid-word cut B1 fixed, ON the failover path, during a
  Gemini outage. Kept shared 1100 (char-ceiling bounds output regardless of provider; C1 now
  makes any Haiku MAX_TOKENS visible). Documented inline.
- **Small** — named TAIL_FLUSH_GRACE_MS; envelope-validation note on the preamble.
- **M5 (LIVE-TEST WATCH, no code change)** — every turn now ends with a zero-padded ≤187ms
  Simli frame. Auditor flags: confirm on-device it reads as a natural beat, not a trailing
  lip-freeze. WATCH during retest.

Suites after fixes: proxy 400/400 (+12), simli-bridge 20/20, tsc clean except 2 pre-existing
thinkingLevel errors (narrative-chunk.ts:303, query-rewrite.ts:297 — not in this change set).

## Deploy notes — RAG live-fix set (post auditor, 2026-05-25)

Auditor verdict: no Criticals; M-1/M-4/M-6 + S-1..S-4 applied in code; the below are
operational couplings the auditor flagged that have NO code fix but MUST be respected.

**Prod env (Vercel + Fly):**
- `RAG_CACHE_DISABLED` — leave UNSET in prod. `=1` turns OFF the semantic cache → ~4 paid
  calls/turn (rewrite+embed+retrieve+rerank). It's a LOCAL iteration flag only. (Boot-warns now if set — audit M4.)
- `DECOUPLED_INJECT_TOP_K` — leave unset (default 1). A value ≤0/non-numeric is boot-FATAL (audit S4).

**M-2 — top-1 inject is validated for SINGLE-STORY questions only.** The live "exactly him" pass was
"tell me the lumberjack story" (reranker decisive 0.77 vs 0.33). Multi-part / comparative questions
("how do your views on X and Y differ", "walk me through your framework") may legitimately need 2-3
units. Before the paid-tier demo, run a multi-part probe set; if answers feel starved/padded, bump
`DECOUPLED_INJECT_TOP_K` to 2-3. Do NOT assume 1 is validated for all question shapes.

**M-3 — bumping `DECOUPLED_INJECT_TOP_K` in prod requires cache invalidation.** The semantic cache key
is (creator, corpus_version, query_hash) — it does NOT include topK. Cache rows written at K=1 hold a
1-parent set for 7 days; bumping K to 3 would silently serve the stale 1-unit answer on every cache
hit. When you change K in prod, EITHER bump `current_corpus_version` (admin RPC) OR run with
`RAG_CACHE_DISABLED=1` for a 7-day TTL window to flush old rows. Hard coupling — put it in the runbook.

**M-5 — BM25 OR-semantics is prod-validated for ONE clean NL query, not across query shapes.** OR-join
now makes BM25 return rows for almost every query (was 0). RRF fuses by RANK, so a chunk matching one
weak shared stem now competes on equal rank-weight and could demote a correct vector hit. It HELPED on
the lumberjack query; it must be measured across a query set by the #4 eval harness before BM25's RRF
weight is trusted. Also (audit M6) URL/email-bearing queries fall back to plainto (AND) or empty — verify
the eval set includes one. "Worked on the lumberjack query" ≠ "OR-semantics validated."

**Migration apply:** `20260525000100` is a function-only CREATE OR REPLACE, zero dependency on the
profile migrations `20260525000001-10`. Do NOT `supabase db push` blind — it would also apply the
unaudited profile set. Run `supabase migration list` first; apply ONLY intended files.
