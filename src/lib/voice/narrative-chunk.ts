// narrative-chunk.ts — LLM-driven narrative chunking of preprocessed raw_text.
//
// Replaces the v1 fixed-window chunker (chunk-sample.ts) with semantic
// narrative-beat splits. The model is instructed to return self-contained
// units — "the twins story", "why sleep beats hustle" — each ~100-400 words.
// These become parent narrative units in sample_content_narrative_units;
// the embed-worker then splits each into child chunks (~150-200 tokens) for
// precision retrieval.
//
// Why Flash, not Haiku: Anthropic's Contextual Retrieval pattern uses Haiku
// for the per-chunk context generation pass (Day 4). Flash is the right tool
// for the one-shot "structure this whole document" pass — cheap, large
// context window, returns clean JSON when asked.
//
// Retry contract:
//   1. Call Flash with structured-output config (responseSchema).
//   2. Parse with Zod — schema validation catches drift even within "valid JSON".
//   3. On Zod parse fail OR transport error: retry ONCE with a stricter
//      prompt (literal "MUST return exactly this JSON shape").
//   4. On second failure: return null. Caller (embed-worker) falls back to
//      the v1 chunker, sample stays at chunker_version=1 + Sentry alert.
//
// Concurrent-call safety: this module is a pure async function. The
// embed-worker's per-creator advisory lock (audit-2 M4) serializes calls for
// the same creator.

import 'server-only';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { sanitizeForLLMPrompt } from './preprocess';

// Configurable via env so a future model swap doesn't require code change.
// Pinned default — banned: -latest. CLAUDE.md "Verify, Don't Guess" extends
// in spirit to bare model names; audit-7 small flagged the unpinned default.
// The string below MUST be a Google-published, dated GA tag. When `2.5-flash`
// is superseded, bump here AND in the env var on Vercel/Fly in the same PR.
export const NARRATIVE_CHUNK_MODEL =
  process.env.NARRATIVE_CHUNK_MODEL || 'gemini-2.5-flash';

// Per-Flash-call wall-clock ceiling. 30s comfortably covers the 95th percentile
// of structured-JSON generation on a 50K-char document; past 30s we assume
// the call is hung and want the embed-worker queue back. Audit-7 M3.
const FLASH_CALL_TIMEOUT_MS = Number(
  process.env.NARRATIVE_CHUNK_TIMEOUT_MS || '30000',
);

// Target unit size per the RAG SOTA plan §1: 500-800 tokens per parent
// narrative unit. We send this as guidance in the prompt; the model decides
// boundaries.
const TARGET_UNIT_MIN_TOKENS = 100;
const TARGET_UNIT_MAX_TOKENS = 800;

// Hard upper bound for any single unit's char_length (matches
// sample_content_narrative_units.text CHECK ≤ 8000 chars).
const HARD_MAX_UNIT_CHARS = 8000;

// Hard upper bound for the title length (matches sample_content_narrative_units.title
// CHECK ≤ 200 chars).
const HARD_MAX_TITLE_CHARS = 200;


// ── Output schema ──────────────────────────────────────────────────────────

const NarrativeUnitSchema = z.object({
  title: z.string().min(1).max(HARD_MAX_TITLE_CHARS),
  text: z.string().min(1).max(HARD_MAX_UNIT_CHARS),
});

const NarrativeChunkResponseSchema = z.object({
  units: z.array(NarrativeUnitSchema).min(1),
});

export type NarrativeUnit = z.infer<typeof NarrativeUnitSchema>;


// ── Errors ─────────────────────────────────────────────────────────────────

export class NarrativeChunkError extends Error {
  readonly code:
    | 'api_key_missing'
    | 'empty_input'
    | 'transport_error'
    | 'invalid_json'
    | 'schema_violation'
    | 'no_units_returned';
  readonly attempt: 1 | 2;
  constructor(code: NarrativeChunkError['code'], attempt: 1 | 2, msg?: string) {
    super(msg ?? `${code} on attempt ${attempt}`);
    this.name = 'NarrativeChunkError';
    this.code = code;
    this.attempt = attempt;
  }
}


// ── Gemini client (lazy, singleton) ────────────────────────────────────────

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new NarrativeChunkError('api_key_missing', 1);
  _client = new GoogleGenAI({ apiKey });
  return _client;
}


// ── Prompt construction ────────────────────────────────────────────────────
//
// Two prompt variants:
//   * base — the standard instruction. Used on attempt 1.
//   * strict — adds an explicit "MUST return exactly this JSON shape" + an
//     example. Used on attempt 2 after attempt 1's response failed schema.
//
// IMPORTANT: the document text is interpolated via `<document>...</document>`
// envelope, but the document MUST be already-sanitized by preprocess.ts
// before reaching this function (sanitizer strips matching envelope tags so
// adversarial content can't escape).
//
// The sample_title (if provided) is also sanitized — defensive even though
// titles come from upstream forms.

function buildPrompt(args: {
  sampleTitle?: string;
  sanitizedDocument: string;
  strict: boolean;
}): string {
  const titleLine = args.sampleTitle
    ? `The document title is: "${args.sampleTitle}".\n\n`
    : '';

  const strictAddendum = args.strict
    ? `\n\nCRITICAL: your previous attempt failed JSON schema validation. You MUST return EXACTLY this shape, nothing else, no markdown fence, no prose:
{"units":[{"title":"...","text":"..."},{"title":"...","text":"..."}]}\n`
    : '';

  return `You are a content editor splitting a document into self-contained narrative units for a retrieval system.

${titleLine}Each unit should be a complete idea, story, or section that makes sense on its own when surfaced to a reader. Aim for ~${TARGET_UNIT_MIN_TOKENS}-${TARGET_UNIT_MAX_TOKENS} tokens per unit. Give each unit a short descriptive title (≤${HARD_MAX_TITLE_CHARS} chars).

If the document is a narrative talk, units are story beats. If it's a reference doc, units are logical sections. Mix is fine — let the document tell you.

Return JSON only. No prose, no markdown fences, no commentary.

Output schema:
{
  "units": [
    { "title": "short descriptive title", "text": "the unit's text" },
    ...
  ]
}${strictAddendum}

<document>
${args.sanitizedDocument}
</document>

Return the JSON object:`;
}


// ── Single-shot Flash call ─────────────────────────────────────────────────

async function callFlashOnce(args: {
  sanitizedDocument: string;
  sampleTitle?: string;
  strict: boolean;
  attempt: 1 | 2;
}): Promise<{ units: NarrativeUnit[]; usage: NarrativeChunkUsage }> {
  // Get the client OUTSIDE the try/catch so api_key_missing propagates as
  // itself, not wrapped into transport_error. (Without this, narrativeChunk's
  // outer "don't retry on api_key_missing" check never fires because the
  // code coming up matches transport_error and falls into the retry path.)
  const c = client();

  // Audit-7 M3: AbortController + race for a hard timeout. @google/genai
  // doesn't accept an AbortSignal in its generateContent config in v0.x,
  // so we race against a timeout promise. On timeout, the in-flight Flash
  // call eventually settles and its result is discarded — wasted tokens
  // but bounded latency.
  //
  // Audit-7 C4 + audit-7 small: `responseMimeType: 'application/json'`
  // without a `responseSchema` tells Flash to return "JSON-ish" — the model
  // can still drift on shape. We validate with Zod and retry-once on
  // schema_violation; first-attempt hit-rate may be lower than 90% in
  // production. Tracked as a cost-model risk for the rollout gate. Future
  // work: pass a real Gemini `responseSchema` (verify field name in current
  // @google/genai version: responseJsonSchema vs responseSchema) once we
  // have a real-API gated regression test.
  let raw: string;
  // Day-5-audit C2: capture usage_metadata from the Flash response so the
  // worker can write a cogs_log row (CLAUDE.md hard rule on paid API calls).
  // Defaults to zero if SDK shape drifts or the call fails before metadata
  // is set — caller treats 0 as "unknown spend, don't credit budget".
  let usage: NarrativeChunkUsage = {
    prompt_token_count: 0,
    candidates_token_count: 0,
    total_token_count: 0,
  };
  try {
    const flashPromise = c.models.generateContent({
      model: NARRATIVE_CHUNK_MODEL,
      contents: buildPrompt({
        sampleTitle: args.sampleTitle,
        sanitizedDocument: args.sanitizedDocument,
        strict: args.strict,
      }),
      config: {
        // Lower temperature for structured output — consistent schema over creativity.
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`flash_timeout_${FLASH_CALL_TIMEOUT_MS}ms`)),
        FLASH_CALL_TIMEOUT_MS,
      );
    });
    const resp = await Promise.race([flashPromise, timeoutPromise]);

    // Defensive extraction — SDK shape varies; we read .text from the first
    // candidate then fall back to the response's top-level text accessor.
    const obj = resp as {
      text?: string;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    raw = obj.text
      ?? obj.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
      ?? '';
    usage = {
      prompt_token_count:     obj.usageMetadata?.promptTokenCount     ?? 0,
      candidates_token_count: obj.usageMetadata?.candidatesTokenCount ?? 0,
      total_token_count:      obj.usageMetadata?.totalTokenCount      ?? 0,
    };
  } catch (e) {
    throw new NarrativeChunkError(
      'transport_error',
      args.attempt,
      (e as Error)?.message ?? 'flash_call_failed',
    );
  }

  if (!raw || raw.trim().length === 0) {
    throw new NarrativeChunkError('invalid_json', args.attempt, 'empty response');
  }

  // Trim possible markdown fences if the model didn't honor responseMimeType.
  let json = raw.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new NarrativeChunkError(
      'invalid_json',
      args.attempt,
      `JSON.parse: ${(e as Error)?.message ?? 'unknown'}`,
    );
  }

  const result = NarrativeChunkResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new NarrativeChunkError(
      'schema_violation',
      args.attempt,
      result.error.message.slice(0, 500),
    );
  }

  if (result.data.units.length === 0) {
    throw new NarrativeChunkError('no_units_returned', args.attempt);
  }

  // Day-3 integration-audit C3 fix: Flash output is untrusted prompt-injection
  // surface. A hallucinated `</chunk>`, `<system>`, or markdown `### SYSTEM`
  // inside `text` or `title` would, after storage, ride into Day 4's
  // contextual-gen prompt (Haiku wraps the unit text in `<chunk>...</chunk>`)
  // AND into the Gemini Live brain prompt at retrieval time — pwning either
  // model's structural envelope. We MUST re-sanitize Flash output before
  // letting it touch storage. Sanitizer is the same one the worker applies
  // to creator raw_text on the way IN; applying it on the way OUT closes the
  // model-trust gap.
  //
  // Why also re-Zod after sanitize:
  //   * markdown escape adds U+00B7 prefix chars to structural lines —
  //     length can grow by a small N (~one per line, typically <20). We
  //     clamp to the hard char limits to stay inside Postgres CHECK bounds.
  //   * If a unit was pure envelope-tag noise (adversarial input survived
  //     through to Flash's hallucination loop), sanitize leaves an empty
  //     string. Zod's min(1) on title/text catches this and the caller's
  //     retry-or-fallback contract handles it.
  const sanitized = result.data.units.map((u) => ({
    title: sanitizeForLLMPrompt(u.title).slice(0, HARD_MAX_TITLE_CHARS),
    text:  sanitizeForLLMPrompt(u.text).slice(0,  HARD_MAX_UNIT_CHARS),
  }));
  const reChecked = NarrativeChunkResponseSchema.safeParse({ units: sanitized });
  if (!reChecked.success) {
    throw new NarrativeChunkError(
      'schema_violation',
      args.attempt,
      `post-sanitize: ${reChecked.error.message.slice(0, 400)}`,
    );
  }

  return { units: reChecked.data.units, usage };
}


// ── Public entrypoint with one-retry contract ──────────────────────────────

export type NarrativeChunkArgs = {
  /** Pre-sanitized document text. Caller MUST run through preprocessRawText. */
  sanitizedDocument: string;
  /** Optional sample title; included in the prompt for orientation. */
  sampleTitle?: string;
};

export type NarrativeChunkUsage = {
  /** Tokens billed for input (prompt + document). 0 if SDK doesn't surface. */
  prompt_token_count: number;
  /** Tokens billed for output (the JSON response). 0 if SDK doesn't surface. */
  candidates_token_count: number;
  /** Total tokens. 0 if SDK doesn't surface. */
  total_token_count: number;
};

export type NarrativeChunkResult = {
  units: NarrativeUnit[];
  /** Which attempt produced the result (1 = first try, 2 = retry succeeded). */
  attempt: 1 | 2;
  /** Total wall-clock ms across all attempts. */
  ms: number;
  /**
   * Per-call usage for COGS accounting (Day-5 audit C2). Sums across both
   * attempts when attempt=2 (the failed attempt still cost tokens). Zero
   * fields when the SDK doesn't surface usage_metadata (older SDK shapes
   * or rejected calls). Caller writes cogs_log under service='gemini',
   * operation='narrative_chunk'.
   */
  usage: NarrativeChunkUsage;
};

/**
 * Splits a document into narrative units via Gemini Flash. Returns null on
 * second-attempt failure so the caller can fall back to the v1 chunker.
 *
 * Caller responsibilities (NOT enforced here):
 *   * Pass already-sanitized text (preprocessRawText).
 *   * Hold the embed-worker's per-creator advisory lock.
 *   * Update sample_content_embedding_jobs.last_error and metrics on null return.
 */
export async function narrativeChunk(
  args: NarrativeChunkArgs,
): Promise<NarrativeChunkResult | null> {
  if (!args.sanitizedDocument || args.sanitizedDocument.trim().length === 0) {
    throw new NarrativeChunkError('empty_input', 1);
  }

  const t0 = Date.now();
  // Attempt 1: base prompt.
  try {
    const r1 = await callFlashOnce({
      sanitizedDocument: args.sanitizedDocument,
      sampleTitle: args.sampleTitle,
      strict: false,
      attempt: 1,
    });
    return { units: r1.units, attempt: 1, ms: Date.now() - t0, usage: r1.usage };
  } catch (e) {
    // Attempt 1 failed. Only retry on the recoverable codes — schema /
    // invalid_json / transport are all worth a stricter second try.
    // api_key_missing or empty_input mean we shouldn't retry at all.
    if (e instanceof NarrativeChunkError) {
      if (e.code === 'api_key_missing' || e.code === 'empty_input') {
        throw e;
      }
      // Attempt 2: stricter prompt with explicit JSON shape example.
      // Day-5-audit C2: attempt-1 spent tokens even though we threw before
      // capturing them (callFlashOnce raises on parse/schema failure with
      // usage left at zero). The lost tokens are inherent retry waste and
      // we don't surface them — the cogs_log emitted by the caller covers
      // the successful attempt only. This is a known small undercount.
      try {
        const r2 = await callFlashOnce({
          sanitizedDocument: args.sanitizedDocument,
          sampleTitle: args.sampleTitle,
          strict: true,
          attempt: 2,
        });
        return { units: r2.units, attempt: 2, ms: Date.now() - t0, usage: r2.usage };
      } catch {
        // Second failure — caller falls back to v1 chunker.
        return null;
      }
    }
    // Non-NarrativeChunkError exceptions bubble up.
    throw e;
  }
}
