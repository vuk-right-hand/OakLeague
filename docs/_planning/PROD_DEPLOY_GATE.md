# PROD DEPLOY GATE — READ BEFORE ANY `fly deploy` OR `main` MERGE

**Status: 🔴 BLOCKED. Do NOT `fly deploy`. Do NOT push branch `rag-sota-phase-2-days-8-12` → `main` yet.**

Last updated: 2026-05-18. Branch: `rag-sota-phase-2-days-8-12`.
This file is the single source of truth for "why is prod not deployed yet."
If you are a new session/agent and prod voice is broken or you're about to
deploy — read this whole file first.

---

## 🔴 HARD BLOCKER #1 — Dockerfile COPY is missing 4 proxy modules

`server/voice-proxy/index.js` imports these files, but the `Dockerfile`
`COPY` line (line ~27) does NOT ship them into the image:

- `hume-bridge.js`                  (Hume work, commit `ab0b7d7`)
- `posthog-client.js`               (Day-13 RAG, commit `7f4a2ec`)
- `retrieve-knowledge-v2-client.js` (Day-13 RAG)
- `voice-session-state-writer.js`   (Day-13 RAG)

Plus the **transitive** dependency: `retrieve-knowledge-v2-client.js`
imports `internal-request-signature.js` — that must be COPY'd too.

**Consequence if you `fly deploy` anyway:** the container boots, hits
`import { HumeTTSBridge } from './hume-bridge.js'`, the file isn't in the
image → `ERR_MODULE_NOT_FOUND` → proxy crash-loops → **production avatar
completely dead.** This is the exact failure the Dockerfile header comment
already warns about (.claude_learnings.md 2026-04-21).

**Why not fixed yet:** the RAG decoupled-brain re-architecture (in progress)
will add/remove proxy modules, so the final COPY list isn't known. Fixing
the Dockerfile now = redo later. Finalize it as the LAST step before the
coordinated deploy (see checklist).

**Verification command (run from `server/voice-proxy/`):**
```bash
comm -23 \
  <(grep -oE "from '\./[a-z0-9-]+\.js'" index.js | sed "s/from '\.\///;s/'//" | sort -u) \
  <(grep "^COPY index.js" Dockerfile | tr ' ' '\n' | grep '\.js$' | sort -u)
```
Empty output = COPY list is complete. Any filename printed = still missing →
do not deploy. (Also manually confirm transitive imports like
`internal-request-signature.js`.)

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
- **b985303 mic-fix divergence** must be resolved at the `main` merge.
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

1. ⛔ RAG decoupled paraphrase→brain re-architecture lands on the branch
   and vector mode actually works (planned; not started as of 2026-05-18).
2. ⛔ Update `server/voice-proxy/Dockerfile` COPY to include the full
   **transitive** module closure. Run the verification command above →
   must be empty.
3. ⛔ Resolve the b985303 mic-fix divergence into the merge.
4. ⛔ `fly deploy` the proxy (Hume-aware + re-architected). Confirm it
   boots (`/healthz`, logs show `voice-proxy listening`).
5. ⛔ Push `rag-sota-phase-2-days-8-12` → `main` (triggers Vercel prod).
   Do step 4 before or together with this.
6. ⛔ Only AFTER 4+5 green: optionally flip a single test prod creator to
   Hume / vector and smoke-test before any broader rollout.

Until every box above is checked, prod stays on the current main (Phase-1
behavior). That is the safe state.

---

## Tracked non-blocking follow-ups (not gates)

- Remove dead `HUME_SECRET_KEY` from `.env.local` / Fly / Vercel (Hume M5).
- Fold `tts_provider_at_session` into `session_open` RPC (Hume M4).
- Hume `api_key`-in-URL → access-token flow (Hume M5 security).
- Symmetric boot-probe pricing validation.
