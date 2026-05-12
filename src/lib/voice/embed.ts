// embed.ts — Gemini Embedding API client (server-only).
//
// Wraps @google/genai's embedContent for `gemini-embedding-001`.
// Two task types per Gemini's asymmetric retrieval guidance:
//   - 'RETRIEVAL_DOCUMENT' for sample_content_chunks (indexed corpus)
//   - 'RETRIEVAL_QUERY'    for live user-turn transcripts
//
// EMBEDDING_MODEL env var, pinned version (banned: -latest / unversioned).
// Defaults to 'gemini-embedding-001'. Mirrors VOICE_MODEL discipline.
//
// Output dimensionality fixed at 768 for v1.5 (halfvec(768) in pgvector).
// Higher dims (1536/3072) would require a re-embed of the entire corpus
// and a halfvec column-type change — out of scope.
//
// Rate-limit + token-bucket policing happens in the embed-worker, not here.
// This is a thin transport wrapper.

import 'server-only';
import { GoogleGenAI } from '@google/genai';

export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
export const EMBEDDING_DIM = 768;

// Pricing: gemini-embedding-001 standard tier = $0.15 / 1M tokens.
// Sourced from Fly secret at the worker level; this constant is exported
// so the worker has a single source of truth. Override via env in dev.
export const EMBEDDING_USD_PER_TOKEN = Number(
  process.env.EMBEDDING_USD_PER_TOKEN || '0.00000015',
);

export class EmbedError extends Error {
  readonly code:
    | 'api_key_missing'
    | 'empty_input'
    | 'invalid_response'
    | 'dim_mismatch'
    | 'transport_error';
  constructor(code: EmbedError['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'EmbedError';
    this.code = code;
  }
}

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new EmbedError('api_key_missing');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export type EmbedArgs = {
  texts: string[];
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
};

export type EmbedResult = {
  vectors: number[][];   // length == texts.length; each vector length == EMBEDDING_DIM
  tokens: number;        // best-effort sum across batch (Gemini returns total or per-call)
  ms: number;            // wall-clock RTT
};

export async function embedTexts(args: EmbedArgs): Promise<EmbedResult> {
  if (!args.texts || args.texts.length === 0) {
    throw new EmbedError('empty_input');
  }
  if (args.texts.some((t) => typeof t !== 'string' || t.length === 0)) {
    throw new EmbedError('empty_input', 'one or more texts are empty/non-string');
  }

  const t0 = Date.now();
  // @google/genai exposes batch embedding through embedContent with a `contents`
  // array. The SDK shape varies slightly by version; we read the result
  // defensively rather than depending on a stable nested type.
  let resp: unknown;
  try {
    resp = await client().models.embedContent({
      model: EMBEDDING_MODEL,
      contents: args.texts,
      config: {
        outputDimensionality: EMBEDDING_DIM,
        taskType: args.taskType,
      },
    });
  } catch (e) {
    throw new EmbedError('transport_error', (e as Error)?.message ?? 'embed_failed');
  }
  const ms = Date.now() - t0;

  // Defensive extraction. The SDK returns either { embeddings: [{ values: [...] }, ...] }
  // or a similar shape. We normalize to number[][].
  const obj = resp as {
    embeddings?: Array<{ values?: number[] }>;
    embedding?: { values?: number[] };
    metadata?: { totalTokenCount?: number };
  };
  let vectors: number[][];
  if (Array.isArray(obj.embeddings)) {
    vectors = obj.embeddings.map((e) => e.values ?? []);
  } else if (obj.embedding?.values) {
    vectors = [obj.embedding.values];
  } else {
    throw new EmbedError('invalid_response', 'no embeddings field on response');
  }
  if (vectors.length !== args.texts.length) {
    throw new EmbedError('invalid_response', `expected ${args.texts.length} vectors, got ${vectors.length}`);
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      throw new EmbedError('dim_mismatch', `expected ${EMBEDDING_DIM}-dim, got ${v?.length ?? 'undefined'}`);
    }
  }

  // Token count: prefer SDK-reported total. Fallback to char-based estimate
  // (~4 chars/token) so cogs_log always has a non-zero number.
  let tokens = obj.metadata?.totalTokenCount ?? 0;
  if (!tokens || tokens <= 0) {
    tokens = args.texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
  }

  return { vectors, tokens, ms };
}

// Helper: format a number[] embedding as the pgvector text representation
// '[v1,v2,...]'. Used when writing through the Supabase REST client which
// doesn't understand halfvec[] natively.
export function vectorToPgText(v: number[]): string {
  return '[' + v.join(',') + ']';
}
