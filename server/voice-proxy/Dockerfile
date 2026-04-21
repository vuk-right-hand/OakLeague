# Voice proxy image. Minimal Node runtime.
# Deps: @google/genai (Live client), @supabase/supabase-js (sessions/cogs),
# ws (WebSocket server), @sentry/node (error capture with ticket-scrub).
#
# IMPORTANT: every first-party source file must be COPY'd here. A previous
# agent-session spent hours debugging `ERR_MODULE_NOT_FOUND` because
# gemini-bridge.js was not copied — see .claude_learnings.md 2026-04-21
# "Dockerfile missed gemini-bridge.js". When adding files, update this line.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js gemini-bridge.js quota-gate.js sentry.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
