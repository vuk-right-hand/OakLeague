# PROD DEPLOY GATE — READ BEFORE ANY `fly deploy` OR `main` MERGE

**Status: 🟡 PARTIAL — Step 2 (Dockerfile) cleared 2026-05-20. Step 3 (b985303) verified stale. Active blockers below.**

**Active blockers (start here):**
  • Step 1 — P1-9 sub-gates **1a / 1b / 1c**. 1a + 1b are automatable
    real-API spikes (~$0.05 total); 1c is a manual staging-creator
    session you have to drive.
  • Step 4 — migration `20260522000101` (cogs_service ADD VALUE 'voyage')
    must land in prod.

ALL of 1a, 1b, 1c AND step 4 must clear before step 5.

Last updated: 2026-05-20. Branch: `rag-sota-phase-2-days-8-12`.
This file is the single source of truth for "why is prod not deployed yet."
If you are a new session/agent and prod voice is broken or you're about to
deploy — read this whole file first.

---

## ✅ Blocker #1 CLEARED 2026-05-20 — Dockerfile COPY = full 23-file closure

DECOUPLED_BRAIN_PLAN §P1-8 fix. `server/voice-proxy/Dockerfile` COPY now
lists the **authoritative `madge` first-party closure** — 23 files total
(`index.js` entrypoint + 22 modules), sorted alphabetically; `*.test.js`
siblings excluded so the prod image stays test-free:

```
index.js, brain-bridge.js, brain-llm-common.js,
build-injection-envelope.js, cartesia-bridge.js, decoupled-boot.js,
decoupled-orchestrator.js, embed-client.js, embed-worker.js,
face-upload-reaper.js, gemini-bridge.js, hume-bridge.js,
internal-request-signature.js, paraphrase.js, posthog-client.js,
proxy-handlers.js, quota-gate.js, retrieve-knowledge-v2-client.js,
retrieve-knowledge.js, sentry.js, simli-face-delete-worker.js,
voice-delete-worker.js, voice-session-state-writer.js
```

**Verification (run from `server/voice-proxy/`):**

The quick direct-import gate (kept for backward compat — note it ONLY
catches direct imports, not transitive — auditor M1+M2 fixes applied so
it does NOT falsely "pass" via comment-mentioned names and DOES cover the
entrypoint line):
```bash
comm -23 \
  <(grep -oE "from '\./[a-z0-9-]+\.js'" index.js | sed "s/from '\.\///;s/'//" | sort -u) \
  <(sed -E '/^[[:space:]]*#/d' Dockerfile | grep -oE '(^COPY |[[:space:]])[a-z0-9-]+\.js' | grep -oE '[a-z0-9-]+\.js' | tr -d '\r' | sort -u)
```
Empty output = no direct-import drift. (Comment lines stripped first so a
"we used to have X" comment can't mask a true-missing X; `\r` stripped so
a Windows-CRLF working tree doesn't false-alarm. Note: `index.js` itself
is intentionally absent from the LEFT side — entrypoint isn't self-
imported — so the diff is correct even though the right side now lists
it. The load-bearing transitive gate is below.)

The **load-bearing** gate is the full transitive closure (the
direct-import grep above silently misses transitive deps like
`brain-llm-common.js` and `internal-request-signature.js`). Pin
`madge@8` to lock the tool version against future breaking changes:
```bash
npx --yes madge@8 --json --extensions js index.js | node -e \
"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{ \
const g=JSON.parse(s),all=new Set(); \
(function w(n){if(all.has(n))return;all.add(n);for(const x of g[n]||[])w(x);})('index.js'); \
const closure=new Set([...all].filter(f=>!f.endsWith('.test.js'))); \
const raw=require('fs').readFileSync('Dockerfile','utf8'); \
const noComments=raw.split(/\r?\n/).filter(l=>!/^\s*#/.test(l)).join('\n'); \
const dock=new Set([...noComments.matchAll(/\b([a-z0-9-]+\.js)\b/g)].map(m=>m[1])); \
const missing=[...closure].filter(f=>!dock.has(f)); \
console.log(JSON.stringify({closure_size:closure.size,missing}));})"
```
Expected: `{"closure_size":23,"missing":[]}`. (Comments stripped before
filename extraction so a stale comment mention can't mask a true-missing
module — auditor M1.)

**Boot proof (P1-8 acceptance):** `docker build` + `docker run` succeed on
the image — every import resolves; boot only fails on the env-var
validator (`FATAL: env SUPABASE_URL missing`), which is the *user-level*
check inside `index.js`, NOT an `ERR_MODULE_NOT_FOUND` from the module
loader. Image is safe to `fly deploy` from the module-resolution
perspective.

---

## Other carry-forward gates (from Hume agent handoff + Day-13)

- **Deploy ordering:** `fly deploy` the Hume-aware proxy **before or together
  with** the `main` → Vercel-prod push. New-Vercel + old-proxy is only
  back-compat-safe while NO prod creator is on Hume.
- **Hard operational rule:** do NOT flip any prod creator to
  `tts_provider='hume'` until the proxy is fly-deployed Hume-aware.
- **Hard operational rule:** do NOT flip any prod creator to vector brain
  (`brain_mode='vector'`) until the RAG re-architecture lands — current
  vector path has the "double-answer / desync / escalating-latency" bug
  (the "57IQ donkey"). Day-13 v2 is gated OFF (env + per-creator flag);
  keep it off in prod.
- **Prod-readiness gap (DECOUPLED_BRAIN_PLAN §12 F1, found 2026-05-18 by
  the P0-4b real-API latency probe):** prod creator #1's corpus is NOT
  v2-reprocessed — the v2 orchestrator returns `parents=0` for every
  query against it (the old probe used v1 `creator_knowledge_topk`; v2
  needs the parent-unit hybrid schema, which is unpopulated). Therefore,
  even AFTER the RAG re-arch lands and v2 migrations apply, **flipping
  creator #1 to `retrieval_version=2` / vector would yield empty
  retrieval (confident ungrounded answers)** until a v2 corpus reprocess
  (`scripts/seed-rag-test-fixture.mjs` is fixture-only — creator #1
  needs the real reprocess pipeline: narrative_chunk → contextual-gen →
  embed → parent-unit insert). Add "v2-reprocess creator #1's corpus +
  verify parents>0" as a prerequisite to any creator-#1 vector flip.
- ~~**b985303 mic-fix divergence** must be resolved at the `main` merge.~~
  ✅ **Stale (2026-05-20).** Verified — `git branch --contains b985303`:
  ```
  main
  rag-sota-phase-1-days-1-5
  rag-sota-phase-2-days-8-12
  ```
  Commit is in this branch AND `main` — no divergence to resolve.
- **Hume migrations:** already applied to prod (`rbuuwwupxuanalvtipch`),
  including `20260522000001`. ✅ done.
- **RAG migrations NOT yet applied to prod:** `20260522000100`
  (retrieval_version snapshot) and **`20260522000101`
  (cogs_service ADD VALUE 'voyage')**. ⚠️ `20260522000101` MUST be
  applied to prod **before** any Vercel deploy that ships the patched
  `rag-telemetry.ts` AND before any creator is on `retrieval_version=2`
  — otherwise every Voyage rerank row hits the still-missing enum, the
  per-row fallback fires a Sentry event per turn, and Voyage spend stays
  absent from `cogs_log` (kill-switch under-fed). Code+migration ship
  together; nothing enforces apply-before-deploy except this line.

---

## ORDERED CHECKLIST — the first prod cutover (do in this order)

1. 🟡 RAG decoupled paraphrase→brain re-architecture (DECOUPLED_BRAIN_PLAN
   P1-1..P1-7 = LANDED on the branch as of `7be288c`; P1-8 Dockerfile +
   90d7855 whole-build audit fixes also LANDED; **P1-9 staging smoke +
   real-API run still PENDING**). Branch may NOT be deployed until P1-9
   closes. P1-9 splits into three sub-gates; ALL must pass before step 5:

   **1a — M1/M6 real-API spike (automatable, ~$0.05).** Closes the
       (A)-gate re-trust on the pinned model. Run from repo root:
   ```bash
   # bash / WSL / git-bash:
   GEMINI_API_KEY=… BRAIN_MODEL=gemini-3.1-flash-preview \
     node scripts/brain-p19-thinking-spike.mjs
   ```
   ```powershell
   # PowerShell (Windows native shell):
   $env:GEMINI_API_KEY='…'; $env:BRAIN_MODEL='gemini-3.1-flash-preview'
   node scripts/brain-p19-thinking-spike.mjs
   ```
   M1 (COMPARATIVE: thoughtsTokens under `'minimal'` is ≤25% of the
   `'high'` baseline; baseline must show non-trivial thinking) AND M6
   (FORCED positive control with `includeThoughts:true` confirms the
   SDK shape, then asserts the prod `streamGenerate` delta excludes
   thought-part text) MUST both pass. Exit 1 = re-trust not held; exit
   2 = spike premise invalid (missing env, wrong model family, or no
   thoughts emitted under `'high'` so the comparative oracle has no
   baseline). The audit-applied joiner fix (`brain-llm-common.js`:
   `.filter(p => !p.thought)`) is in `90d7855`+; this spike VERIFIES
   it on the live SDK surface.

   **1b — Real-corpus injection-rate run (automatable, ~$0.02).** Use
       the fixture creator if creator #1's corpus is unavailable:
   ```bash
   # one-time, if not already seeded:
   node scripts/seed-rag-test-fixture.mjs
   # spike (bash / WSL):
   GEMINI_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
     BRAIN_MODEL=gemini-3.1-flash-preview \
     node scripts/brain-injection-generatecontent-spike.mjs \
     --from-creator <fixture-or-real-creator-uuid>
   ```
   ```powershell
   # PowerShell:
   $env:GEMINI_API_KEY='…'; $env:SUPABASE_URL='…'
   $env:SUPABASE_SERVICE_ROLE_KEY='…'; $env:BRAIN_MODEL='gemini-3.1-flash-preview'
   node scripts/brain-injection-generatecontent-spike.mjs `
     --from-creator <fixture-or-real-creator-uuid>
   ```
   Defense must hold (0 breaches) OR every breach is a clear refusal
   that quotes the attack. Add `--l0` to also exercise the L0 index-
   time neutralization layer end-to-end through the running
   `/api/internal/preprocess` route. The spike now also exercises
   base64-encoded + language-shift attacks (audit M4).

   **1c — Staging-creator correctness session (manual, Vuk-driven).**
       The "no filler" gate from the plan §13:1262. Cannot be automated
       — requires browser + listening. Checklist:
   - [ ] Boot the local proxy with the decoupled-aware build + α' on:
         `VOICE_TTS_LAYER_ENABLED=1 VOICE_TTS_PROVIDER=cartesia`
         (or `hume`), `BRAIN_MODEL=…`, all pricing envs set.
   - [ ] Open a session against a staging creator that has
         `creators.decoupled=true` (via the admin RPC — direct UPDATE
         is FORBIDDEN per §M3) AND a real cloned voice.
   - [ ] Ask 5+ questions across the creator's topic drawers.
         For EACH turn verify:
         (i)   paraphrase first-audio is fast (<2.2s p75 per (A)-gate);
         (ii)  paraphrase → deep answer is SEAMLESS — one continuous
               utterance, no dead air > ~250ms, no double-speak;
         (iii) the deep answer SOUNDS LIKE THE CREATOR — content, tone,
               vocabulary all in-persona (not a stock-AI hedge);
         (iv)  barge-in halts the voice INSTANTLY (no tail);
         (v)   the proxy's `decoupled.metrics turns=…` log line is
               present at session-end with real numbers (no `na`).
   - [ ] **L0 applied verification (audit M5):** sample one
         `sample_content` row used by the session and confirm its
         `sanitized_text` differs from `raw_text` for any row that
         contained an injection-pattern phrase. If `sanitized_text =
         raw_text` on every row in the corpus, L0 either never ran or
         the corpus has no patterns to neutralize — flag for review.
   - [ ] **cogs_log per-turn writes (audit M5):**
         ```sql
         SELECT operation, COUNT(*), AVG(cost_usd), MAX(cost_usd)
         FROM cogs_log
         WHERE session_id = '<staging-session-id>'
           AND service = 'gemini'
         GROUP BY operation;
         ```
         Expect 2 rows: `brain_paraphrase` and `brain_deep_answer`, COUNT
         equal to turn count, AVG non-zero, MAX bounded (no 4000c overflow
         spend). A missing operation row = silent COGS gap.
   - [ ] **thoughts_tokens = 0 per turn (audit M5 + whole-build C3):**
         the P1-9 audit-applied C3 plumbing now writes
         `metadata->>'thoughts_tokens'` into `cogs_log` on every
         brain_paraphrase + brain_deep_answer row. Query:
         ```sql
         SELECT turn_number, operation, metadata->>'thoughts_tokens' AS tt
         FROM cogs_log
         WHERE session_id = '<staging-session-id>'
           AND service = 'gemini'
         ORDER BY turn_number, operation;
         ```
         Expect `tt` = `0` or `null` on every row. `null` means the SDK
         didn't surface `thoughtsTokenCount` (legacy model family); `0`
         means surfaced + honored; non-zero ⇒ thinking-off NOT honored
         in the live session (1a's comparative oracle is not enough on
         its own — empirically prove it on the real path).
   - [ ] At least ONE long session (>10 min) to exercise D-GoAway
         proactive reopen. Tail the proxy stderr for the exact log
         string `[gemini-bridge] proactive D-GoAway reopen` emitted by
         `gemini-bridge.js _proactiveReopen`. At least ONE such line
         MUST appear in the >10-min session AND the session must
         continue without audible reconnect artifact. If the log line
         text changes, update this bullet to match.
   - [ ] **Cross-session burn-in (audit M5):** immediately after the
         first session ends cleanly, open a SECOND session with a
         different question pattern. Verify no cross-session state
         bleed: `lastAssistantResponse`, `_sessionGen`, no leaked
         `_utteranceInFlight`. Sentry should be clean for both.
   - [ ] One ambiguous / out-of-corpus question to verify the
         persona-only degrade (no fabricated specifics).
   - [ ] Sentry / cogs_log show no red-flag end_reasons. The
         `cogs_log` per-turn rows for `brain_paraphrase` and
         `brain_deep_answer` are present with sane tokens.

   If ANY of 1a/1b/1c fails OR step 4 (migration `20260522000101`) has
   not landed in prod, do NOT advance to step 5.
2. ✅ Update `server/voice-proxy/Dockerfile` COPY to include the full
   transitive module closure. **Done 2026-05-20** — verification commands
   above are empty; `docker build` + module-resolution probe both green.
3. ✅ b985303 mic-fix divergence — already in branch + main; no merge work.
4. ⛔ **Apply migration `20260522000101` (cogs_service ADD VALUE 'voyage')
   to prod** — promoted from "tracked follow-up" to ordered gate by the
   P1-8 whole-build audit (M2). The decoupled path's `retrieveEnvelopeForDecoupled`
   calls `callRetrieveKnowledgeV2` whenever a creator is on
   `retrievalVersionAtSession=2`, and v2 telemetry writes `service='voyage'`.
   Without the migration, every Voyage rerank row dies on the enum, the
   per-row fallback fires a Sentry burst per turn, and Voyage spend is
   absent from `cogs_log` (kill-switch under-fed). Must land BEFORE
   step 5 OR before any creator is on `retrieval_version=2` — whichever
   is first.
5. ⛔ `fly deploy` the proxy (Hume-aware + re-architected). Confirm it
   boots (`/healthz`, logs show `voice-proxy listening`).
6. ⛔ Push `rag-sota-phase-2-days-8-12` → `main` (triggers Vercel prod).
   Do step 5 before or together with this.
7. ⛔ Only AFTER 4+5+6 green: optionally flip a single test prod creator to
   Hume / vector and smoke-test before any broader rollout.

Until every box above is checked, prod stays on the current main (Phase-1
behavior). That is the safe state.

---

## Tracked non-blocking follow-ups (not gates)

- Remove dead `HUME_SECRET_KEY` from `.env.local` / Fly / Vercel (Hume M5).
- Fold `tts_provider_at_session` into `session_open` RPC (Hume M4).
- Hume `api_key`-in-URL → access-token flow (Hume M5 security).
- Symmetric boot-probe pricing validation.

---

## Architectural notes (not gates, but flag at the M3 admin-flip RPC)

- **3.1 Live audio-out tax on the decoupled path** (P1-8 whole-build audit
  M3). Phase 0 (2026-04-22) ruled out `responseModalities=[TEXT]` on
  `gemini-3.1-flash-live-preview` ("Internal error encountered."). On the
  decoupled path we therefore still open Gemini Live in `AUDIO` mode and
  pay for audio synthesis + `outputAudioTranscription` per turn, even
  though the orchestrator discards both (the brain has moved off-Live to
  `generateContentStream`). The decoupled cost model claims "off-Live
  cheaper"; in practice each decoupled turn = (paraphrase generate +
  deep-answer generate + paid Gemini Live audio-out we throw away). Real
  per-turn cost is ~1.4-1.8× the modeled estimate. P1-9 measurement
  burn-in must confirm the (A)-gate cost trade-off survives this overhead
  before any creator is flipped. Re-attempt `responseModalities=[TEXT]`
  on a newer Live preview when one ships; failing that, document the
  audio-out tax in the M3 admin-flip RPC acknowledgment.
