# Voice proxy image. Minimal Node runtime.
# Deps: @google/genai (Live client + deep-answer), @anthropic-ai/sdk (Step-2
# Claude Haiku deep-answer failover), @supabase/supabase-js (sessions/cogs),
# ws (WebSocket server), @sentry/node (error capture with ticket-scrub).
#
# IMPORTANT: every first-party source file must be COPY'd here. A previous
# agent-session spent hours debugging `ERR_MODULE_NOT_FOUND` because
# gemini-bridge.js was not copied — see .claude_learnings.md 2026-04-21
# "Dockerfile missed gemini-bridge.js". When adding files, update this line.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# `npm ci`, NOT `npm install`. With caret ranges in package.json (e.g.
# `^1.50.1`), `npm install` resolves to whatever satisfies the range at
# build time and can silently drift past the lockfile pin (e.g. 1.50.1 →
# 1.51.0 when the latter ships). `npm ci` reads the lockfile authoritatively
# and fails the build if package.json and lockfile disagree.
# Background: 2026-05-02 — when Gemini Live multi-turn regressed we initially
# suspected `@google/genai` 1.50.1 → 1.51.0 drift (1.51.0 published Apr 29,
# same window as the regression). The running image turned out to still be
# 1.50.1, but it took a `flyctl ssh` to prove it. Pinning removes that class
# of false leads. Lockfile is now load-bearing — keep it committed.
RUN npm ci --omit=dev --no-audit --no-fund

# Full first-party closure derived from `madge --json index.js` (transitive,
# excluding *.test.js). When `index.js` reaches a NEW first-party file, add
# it here. Transitive deps (e.g. brain-llm-common.js,
# internal-request-signature.js) must be added by hand when a direct dep
# is added. Verification gate (from server/voice-proxy/):
#
#   npx --yes madge@8 --json --extensions js index.js
#
# walked from index.js MUST yield exactly the set below. Full procedure +
# the `comm`-based quick gate live in docs/_planning/PROD_DEPLOY_GATE.md
# (search "Blocker #1 CLEARED"). If that doc is ever renamed, update this
# pointer at the same time. If the closure differs from this COPY list,
# the prod build is broken — add it before `fly deploy`.
COPY index.js \
     brain-bridge.js \
     brain-llm-common.js \
     build-injection-envelope.js \
     cartesia-bridge.js \
     decoupled-boot.js \
     decoupled-orchestrator.js \
     embed-client.js \
     embed-worker.js \
     face-upload-reaper.js \
     gemini-bridge.js \
     hume-bridge.js \
     internal-request-signature.js \
     paraphrase.js \
     posthog-client.js \
     proxy-handlers.js \
     quota-gate.js \
     retrieval-path.js \
     retrieve-knowledge-v2-client.js \
     retrieve-knowledge.js \
     sentry.js \
     simli-face-delete-worker.js \
     voice-delete-worker.js \
     voice-session-state-writer.js \
     ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
