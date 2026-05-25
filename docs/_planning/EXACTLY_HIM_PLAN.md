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

## Read-only diagnostic scripts added tonight (keep)
- `scripts/diag-v2-corpus.mjs` — creator/corpus/jobs/cache state.
- `scripts/diag-corpus-keyword.mjs` — keyword presence raw vs chunked.
- `scripts/diag-retrieve-v2.mjs` — full topk_v2 + Voyage rerank for a query.
- `scripts/diag-retrieve-latency.mjs` — per-stage latency probe.
- `scripts/diag-find-unit.mjs` — locate a narrative unit by keyword.
