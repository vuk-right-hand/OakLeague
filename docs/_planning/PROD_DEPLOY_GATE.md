# PROD DEPLOY GATE — READ BEFORE ANY `fly deploy` OR `main` MERGE

**Status: 🟢 1c CLEARED + PROXY DEPLOYED (2026-05-25). Steps 2/3 cleared; P1-9 (1a/1b) + P1-10 code-complete; the RAG/decoupled migration set (incl. `20260522000104` rollover fix) is APPLIED to prod (Vuk-confirmed); Step 1c manual session PASSED (subjective "exactly him", no mid-word cut + COGS billing-integrity spot-check); Step 5 `fly deploy` DONE (build `48e1e1df1524e8` — Haiku failover ARMED, depth=variable, inject_top_k=1). REMAINING: Step 6 `main` push (HELD by choice — Vercel-side only) + apply NEW migration `20260525000100` (BM25 OR, committed, DEFERRED). Do NOT blind `supabase db push` — it would drag the unaudited profile migrations.**

**Active blockers (start here) — updated 2026-05-22:**
  • **P1-10 ✅ CODE-COMPLETE on the branch** (was the blocker for 1c):
    `admin_set_creator_decoupled` RPC (`20260523000001`) + the guard
    (`20260523000002`); the D12 decoupled-persona compiler
    (`20260523000005`, drops the brevity directive from decoupled
    personas); and the session-open route patch
    (`src/app/api/sessions/open/route.ts:171/210/954` forwards
    `creators.decoupled` → `mintVoiceTicket`). Direct UPDATE of
    `creators.decoupled` remains FORBIDDEN — use the RPC (which recompiles).
  • **Step 1c ✅ CLEARED 2026-05-25** — manual staging session passed:
    subjective "exactly him" recognition with NO mid-word cut, PLUS the COGS
    billing-integrity spot-check (per-turn `brain_deep_answer` legs present,
    real costs, quota meters + kill-switch fed truthfully — see
    `scripts/diag-cogs-recent.mjs`).
  • **Apply the branch's migrations to prod ✅ DONE** (Vuk-confirmed 2026-05-25):
    `20260522000100`, `20260522000104` (rollover fix), `20260523000001/000002/000010`,
    `20260523000004`, `20260523000005` are LIVE on prod. ⏳ NEW: `20260525000100`
    (BM25 OR-semantics) is committed but NOT applied — proven read-only on prod
    data, low-risk, DEFERRED (recall improvement; needs the #4 eval harness to
    validate its RRF weight). Do NOT `supabase db push` blind (it would also
    apply the unaudited profile migrations `20260525000001-10`); apply
    `20260525000100` surgically or coordinate with the profile set.
  • **Step 5 (`fly deploy`) ✅ DONE 2026-05-25** — build `48e1e1df1524e8`; boot
    log confirms Haiku failover ARMED + `decoupled depth=variable inject_top_k=1`.
    **Step 6 (`main` push) ⏳ HELD by choice:** the "exactly him" UX lives in the
    PROXY (now deployed); `main` ships only Vercel-side retrieval/rewrite-cap
    changes (the `RAG_CACHE_DISABLED` flag is inert when unset) — do it
    deliberately and coordinate with the profile workstream's eventual merge.

  • **⚠️ NEW REGRESSION FIX — `20260522000104_session_rollover_restore_close_old_session`
    (2026-05-22).** Migrations `20260521000009`/`20260522000100` accidentally
    inverted `session_rollover`'s old-session guard + dropped the
    close-the-old-session UPDATE → EVERY paid-tier rollover (15-min Gemini cap
    overlap) hit `old_session_still_open` (sessions cut off at 15 min) AND
    charged 0s to quota (COGS kill-switch blinded). `20260522000104` restores
    the proven close-the-open-old-session body + keeps the version snapshot.
    MUST be applied to prod with the rest of the RAG migration set, and BEFORE
    any paid creator relies on rollover. Pinned by pgTAP
    `session_open_hook_creator_mismatch_rejected` tests 4/5/6.

Last updated: 2026-05-25. Branch: `rag-sota-phase-2-days-8-12`.
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

## Corpus reprocess worker env (FIVE_CREATOR_ONBOARDING_READINESS P0-2)

**Before onboarding any creator who needs a v2 corpus reprocess**, confirm the
deployed Fly proxy has ALL THREE set (`server/voice-proxy/index.js` boot gate,
~line 2498-2528):
- `GEMINI_API_KEY`
- `INTERNAL_API_BASE_URL`
- `INTERNAL_API_SECRET` — **must be ≥ 32 chars** (a shorter value logs an error
  and DISABLES the worker without crashing boot, so the proxy looks "healthy").

If any is missing/short, the admin "Re-process v2" button enqueues
`corpus_reprocess_jobs` that sit `pending` forever with no error. The admin
panel now shows a "worker may be offline" warning after ~30s of
pending-with-no-processing (P0-2 stall detection), but the real fix is env
config. Verify with `fly ssh console -C "env | grep -E 'GEMINI_API_KEY|INTERNAL_API'"`
(check presence + the secret's length, not the secret value).

## ⚠️ FLAG (2026-05-22) — creator #1 `vuk_lehendas` is LIVE on the un-gated path

Confirmed via prod read: `vuk_lehendas` (74e897d8) is **published + `decoupled=true` + `brain_mode='vector'`** — the ONLY prod creator on this path (blast radius = 1). A real visitor opening it gets the decoupled brain (works — 1c-tested, latency great) BUT:
- **vector retrieval against a v1 corpus** → won't recall v2-only stories (the "lumberjack" gap); persona-only/degraded grounding. The documented vector "double-answer/desync" risk applies.
- COGS accounting is now FIXED (12-arg leg applies as of the 2026-05-22 push) — kill-switch no longer blind.

**Decision (Vuk, 2026-05-22): leave it live, flag for follow-up — not unpublish.** Follow-up owed before this is "clean": (a) v2-reprocess vuk_lehendas's corpus + verify parents>0 (gate F1 below), (b) clear the vector double-answer bug (the RAG re-arch), OR (c) flip `brain_mode` back to drawer until (a)+(b) land. Revisit when real users start hitting the feed.

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
         `creators.decoupled=true` (via the **P1-10 admin RPC, pending**
         — direct UPDATE remains FORBIDDEN per §M3) AND a real cloned
         voice.
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

   1a ✅ CLEARED 2026-05-20 (`gemini-3-flash-preview`, high=765/490
   minimal=0/0; prod joiner excludes thought parts). 1b ✅ CLEARED
   2026-05-20 (9/9 attacks held including base64-encoded + French
   language-shift). 1c BLOCKED on P1-10 (D12 + admin RPC + route patch
   — see Active Blockers at top of file).

   If ANY of 1a/1b/1c fails, do NOT advance to step 5.
2. ✅ Update `server/voice-proxy/Dockerfile` COPY to include the full
   transitive module closure. **Done 2026-05-20** — verification commands
   above are empty; `docker build` + module-resolution probe both green.
3. ✅ b985303 mic-fix divergence — already in branch + main; no merge work.
4. ✅ **Migrations applied to prod 2026-05-20** — `20260522000101`
   (cogs_service ADD VALUE 'voyage'), `20260522000102`
   (creators.decoupled + voice_tickets.decoupled boolean), `20260522000103`
   (cogs_insert_brain_leg RPC). All three additive + fail-safe defaults.
   Apply confirmed via `supabase migration list --linked`. **Callability
   note (audit M1):** PostgREST schema cache lags 60-300s after a
   CREATE FUNCTION; the first `cogs_insert_brain_leg(...)` call within
   that window returns PGRST202 (documented in `20260522000103` line
   109-110). Verify callability with a named-arg probe BEFORE step 5
   (`select * from cogs_insert_brain_leg(p_user_id => '00000000-…'::uuid, …)`
   — expect a validation error from the function body, NOT PGRST202).
4b. ✅ **APPLIED TO PROD 2026-05-22** (via `supabase db push --include-all`; the
   whole 8-migration pending chain went together). Probe confirmed the 12-arg
   `cogs_insert_brain_leg` is callable on prod (returned a `22023` body
   validation error, not PGRST202 → schema cache reloaded). **Apply migration `20260523000004` (Step-2 Haiku failover COGS).**
   Widens `cogs_insert_brain_leg` with a trailing `p_service cogs_service
   DEFAULT 'gemini'` arg + the `brain_deep_answer_failover` operation so the
   Haiku failover leg writes under `service='anthropic'` and never collides
   with the primary Gemini leg's idempotency slot. Additive + backward-compat
   (the old 11-arg call site keeps working → 'gemini'). Replay-verified on a
   local `db reset` 2026-05-21. Same PGRST202 schema-cache caveat as item 4 —
   probe callability with the 12-arg signature before step 5.
4c. ✅ **APPLIED TO PROD 2026-05-22** + **vuk_lehendas RECOMPILED** (via
   `_creator_brain_compile_unsafe` — the sanctioned path; brevity directive
   confirmed dropped from its decoupled persona, 240→207 chars). **Apply migration `20260523000005` (Phase 3 variable-depth persona).**
   `CREATE OR REPLACE _creator_brain_compile_unsafe` — splits the "1-3 concise
   sentences" depth directive out of the common header: re-appended
   BYTE-IDENTICALLY on legacy (drawer/vector) personas, DROPPED from decoupled
   personas (the deep-answer assembler `buildDepthClause` now supplies a
   tier-aware depth clause per turn). No signature change (same `uuid` arg),
   called only via PERFORM inside `admin_set_creator_decoupled` → no PGRST202
   concern. **POST-APPLY: recompile every existing decoupled creator** (admin
   Recompile button / `admin_set_creator_decoupled` / one-shot script) so the
   baked directive is removed from their stored persona. Until recompiled,
   `buildDepthClause`'s C3 self-heal detects "concise sentences" in the persona
   and FORCES brief depth + warns — a missed recompile degrades to today's
   behavior, never a contradiction. Verify with the persona-shape pgTAP test
   (`creator_brain_compile_persona_shape` — asserts legacy keeps brevity,
   decoupled drops it) after a local `db reset`.
4d. ✅ **APPLIED TO PROD 2026-05-22.** All 8 pending migrations
   (`20260522000104` rollover fix, `20260523000004`/`000005`, and the
   onboarding/consent/ToS set `20260523000006-000010` from commit `6ff93d2`)
   pushed together via `--include-all` (000104 was out-of-order vs the already-
   applied 2026-05-23 remote migrations — safe, nothing applied after it on
   remote touches `session_rollover`). `migration list --linked` shows all 8 on
   Remote. **NOTE: DB is now ahead of deployed code** — the Fly proxy + Vercel
   still run the pre-deploy build. Safe because every migration is additive /
   backward-compat (old 11-arg cogs call → 12-arg default 'gemini'; new consent/
   publish RPCs simply unused until their routes deploy). Original step text:
   **Apply the remaining branch migrations to prod (2026-05-22 set).** All
   additive / CREATE OR REPLACE; replay-verified on a local `db reset`
   2026-05-22 (full pgTAP suite 225/225 green after). Apply in order:
   - `20260522000100` — sessions snapshot `corpus_version`/`retrieval_version`
     at open + rollover. (Doc previously listed this as not-yet-applied.)
   - `20260522000104` — **session_rollover regression FIX** (restores the
     close-the-open-old-session contract + keeps the snapshot). Without it,
     paid rollover is broken in prod (15-min cutoff + 0s quota charge). No
     PGRST202 concern (called via RPC, not PostgREST).
   - `20260523000001` (`admin_set_creator_decoupled`) + `20260523000002`
     (brain_mode↔decoupled guard) + `20260523000010` (`admin_set_creator_published`).
   - (4b/4c above cover `20260523000004`/`20260523000005`.)
   **POST-APPLY:** recompile every existing decoupled creator (per 4c) so the
   baked brevity directive is dropped from stored personas.
5. ⛔ `fly deploy` the proxy (Hume-aware + re-architected). Confirm it
   boots (`/healthz`, logs show `voice-proxy listening`).

   **Phase 3 variable-depth — `BRAIN_DEPTH_MODE` Fly secret (OPTIONAL, A/B'd).**
   Variable depth is OFF unless `BRAIN_DEPTH_MODE` is the EXACT string
   `variable` (strict ===; unset/`0`/`brief`/typo → today's 1-3-sentence brief
   behavior). This is the A/B kill-switch: **rollback = unset the secret + the
   next session is brief again** (no redeploy of logic needed; env-only).
   ```bash
   fly secrets set -a <proxy-app> BRAIN_DEPTH_MODE=variable   # ARM the A/B
   fly secrets unset -a <proxy-app> BRAIN_DEPTH_MODE           # ROLLBACK to brief
   ```
   **PRE-FLIGHT (do NOT skip):** run `node --env-file=.env.local
   scripts/brain-depth-ab-spike.mjs` first and confirm all verdicts PASS —
   never A/B a depth behavior that hasn't been measured on the real model
   (bifurcation holds + nothing exceeds the 4000-char ceiling). **The spike's
   `BRAIN_MODEL` MUST equal the prod `BRAIN_MODEL` secret** (audit M1 —
   depth-following is model-specific; the spike hard-fails if `BRAIN_MODEL` is
   unset rather than silently defaulting). Set the same model in `.env.local`
   before running.

   **⚠️ COGS / kill-switch interaction (variable mode).** The kill-switch is a
   TIME budget (cloned-voice seconds), and a longer answer = more TTS seconds =
   faster quota burn. That's WHY tier bifurcates: free is bounded BOTH by the
   ~150-word soft instruction AND a tier-aware HARD cap (`maxOutputTokens=280`
   ≈ ~215 words, audit C2) so its exposure is actually enforced, not just
   requested; paid (premium/boardroom) gets the full story (~450-word soft
   target under the 800-token / ~600-word default hard cap). When
   `BRAIN_DEPTH_MODE=variable`, expect higher per-turn `output_tokens` on the
   `brain_deep_answer` cogs leg (paid story ≈ 5-8× brief) AND on the
   `brain_deep_answer_failover` (anthropic) leg when Gemini 503s on a long
   answer — the Haiku leg inherits the same depth clause AND the same tier-aware
   `max_tokens` (same systemInstruction + cap) so a failed-over story is just as
   long + billed at the Haiku rate. Watch `metricsSnapshot.maxDeepChars`
   (session-end, running max) for answers brushing the 4000-char ceiling, and
   the daily COGS viewer for a step-change in per-session brain spend after the
   flip. **Stall-then-failover blind spot (audit M4):** a Gemini stall AFTER
   generation began but BEFORE the first delta bills server-side but is counted
   `billed:false` (overloaded path) — longer paid targets enlarge each such
   uncounted leak. Bounded per-turn, but watch the failover rate
   (`deepFailedOver`) alongside it. Hard caps unchanged otherwise: paid
   `max_tokens` 800 + the orchestrator's OUTPUT_CHAR_CEILING sentence-stop both
   still bound a runaway regardless of mode.

   **Step-2 Gemini→Haiku failover — 5 Fly secrets (OPTIONAL but recommended
   for 503-resilience).** The failover is fail-SOFT: if these are unset the
   proxy boots fine and logs `Gemini→Haiku failover DISABLED`; a Gemini 503
   then degrades to persona-only (session survives, no crash). Set all five
   to ARM it. Pricing is fail-closed — a partial set (model but no rate)
   means the lazy getter throws `misconfigured` on the failover path, which
   DEGRADES (never 1011s). Verified Haiku 4.5 rate 2026-05-21: $1/1M input,
   $5/1M output.
   ```bash
   fly secrets set -a <proxy-app> \
     ANTHROPIC_API_KEY=sk-ant-… \
     ANTHROPIC_MODEL=claude-haiku-4-5-20251001 \
     ANTHROPIC_USD_PER_INPUT_TOKEN=0.000001 \
     ANTHROPIC_USD_PER_OUTPUT_TOKEN=0.000005 \
     ANTHROPIC_QUOTED_AT=2026-05-21
   ```
   Guards: `ANTHROPIC_MODEL` MUST start with `claude-haiku-` and be a dated
   pin (no `-latest`) — a non-Haiku string is rejected at use (cost guard,
   ~30× blast radius on the live voice path). Optional tuning:
   `BRAIN_FAILOVER_DETECT_MS` (default 2000) caps how long a STALLED Gemini
   stream waits before failing over. On boot, confirm the log line
   `[boot] Gemini→Haiku deep-answer failover ARMED`.
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
