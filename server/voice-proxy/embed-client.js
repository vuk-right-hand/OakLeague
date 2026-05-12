// embed-client.js — Gemini Embedding API client (proxy-side, pure ESM Node).
//
// Audit C1 fix: src/lib/voice/embed.ts uses `import 'server-only'` which
// throws outside Next.js. The proxy is plain Node ESM; it cannot import
// TS files at runtime (Node's ESM loader rejects .ts with ERR_UNKNOWN_FILE_EXTENSION).
// This file mirrors the TS version's behavior minus the Next-only side-effect.
//
// The TS version stays in src/lib/voice/embed.ts for tests + future Next-side
// imports; this is the proxy's source of truth at runtime.

import { GoogleGenAI } from '@google/genai';

export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
export const EMBEDDING_DIM = 768;

// Default per-token rate matches gemini-embedding-001 standard tier
// ($0.15 / 1M tokens = 1.5e-7 / token). Override via Fly secret in prod.
export const EMBEDDING_USD_PER_TOKEN = Number(
  process.env.EMBEDDING_USD_PER_TOKEN || '0.00000015',
);

export class EmbedError extends Error {
  constructor(code, msg) {
    super(msg || code);
    this.name = 'EmbedError';
    this.code = code;
  }
}

let _client = null;
function client(apiKey) {
  if (_client) return _client;
  if (!apiKey) throw new EmbedError('api_key_missing');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

// embedTexts({ apiKey, texts, taskType }):
//   apiKey:    GEMINI_API_KEY string (proxy passes it through; we don't read env here).
//   texts:     string[] — one entry per chunk / query.
//   taskType:  'RETRIEVAL_DOCUMENT' (corpus) | 'RETRIEVAL_QUERY' (live user turn).
// Returns:    { vectors: number[][], tokens: number, ms: number }.
export async function embedTexts({ apiKey, texts, taskType }) {
  if (!texts || texts.length === 0) throw new EmbedError('empty_input');
  if (texts.some((t) => typeof t !== 'string' || t.length === 0)) {
    throw new EmbedError('empty_input', 'one or more texts empty/non-string');
  }
  if (taskType !== 'RETRIEVAL_DOCUMENT' && taskType !== 'RETRIEVAL_QUERY') {
    throw new EmbedError('bad_task_type', `taskType=${taskType}`);
  }

  const t0 = Date.now();
  let resp;
  try {
    resp = await client(apiKey).models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: {
        outputDimensionality: EMBEDDING_DIM,
        taskType,
      },
    });
  } catch (e) {
    throw new EmbedError('transport_error', e?.message || 'embed_failed');
  }
  const ms = Date.now() - t0;

  let vectors;
  if (Array.isArray(resp?.embeddings)) {
    vectors = resp.embeddings.map((e) => e?.values || []);
  } else if (resp?.embedding?.values) {
    vectors = [resp.embedding.values];
  } else {
    throw new EmbedError('invalid_response', 'no embeddings field on response');
  }
  if (vectors.length !== texts.length) {
    throw new EmbedError(
      'invalid_response',
      `expected ${texts.length} vectors, got ${vectors.length}`,
    );
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      throw new EmbedError(
        'dim_mismatch',
        `expected ${EMBEDDING_DIM}-dim, got ${v?.length}`,
      );
    }
  }

  let tokens = resp?.metadata?.totalTokenCount || 0;
  if (!tokens || tokens <= 0) {
    // Fallback: char-based estimate so cogs_log + budget RPCs always have a
    // non-zero value. ~4 chars/token rule of thumb across LLM tokenizers.
    tokens = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
  }
  return { vectors, tokens, ms };
}

// Format a number[] as pgvector text wire format '[v1,v2,...]'. PostgREST
// accepts this and the halfvec(768) function parameter casts it.
export function vectorToPgText(v) {
  return '[' + v.join(',') + ']';
}
