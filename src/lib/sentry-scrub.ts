// S-C4 — Next.js / Vercel-side Sentry transcript scrub.
//
// Mirror of the proxy's scrub helper at server/voice-proxy/sentry.js. Same
// denylist of keys; same explicit-set membership rule (no substring match).
// Wired into sentry.client.config.ts and sentry.server.config.ts via
// `beforeSend`. The proxy and Vercel paths must stay in lock-step — when
// you add a key to one, add it to the other.

const TRANSCRIPT_KEYS = new Set<string>([
  'transcript',
  'transcripttext',
  'output_transcript',
  'outputtranscript',
  'outputtranscription',
  'output_transcription',
  'input_transcript',
  'inputtranscript',
  'inputtranscription',
  'input_transcription',
  '_currentturnoutputtranscript',
  'chunktext',
  'chunk_text',
  'prompt',
  'systeminstruction',
  'system_instruction',
  'userprompt',
  'user_prompt',
  'usermessage',
  'user_message',
  'modelprompt',
  'model_prompt',
  'responsebody',
  'response_body',
  'requestbody',
  'request_body',
  'cartesia_transcript',
]);

export function scrubTranscriptKeys(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) scrubTranscriptKeys(item);
    return obj;
  }
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (TRANSCRIPT_KEYS.has(k.toLowerCase())) {
      o[k] = '[redacted]';
      continue;
    }
    if (o[k] && typeof o[k] === 'object') scrubTranscriptKeys(o[k]);
  }
  return obj;
}

// Apply the scrub to the Sentry event's structured channels:
// extra, contexts, breadcrumbs[].data.
export function applyTranscriptScrub<T extends {
  extra?: unknown;
  contexts?: unknown;
  breadcrumbs?: Array<{ data?: unknown; message?: string }> | undefined;
}>(event: T): T {
  scrubTranscriptKeys(event.extra);
  scrubTranscriptKeys(event.contexts);
  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) {
      if (b && typeof b === 'object') scrubTranscriptKeys(b.data);
    }
  }
  return event;
}
