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
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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


// ── Defensive oversized-unit splitter ─────────────────────────────────────
//
// Flash sometimes emits narrative units whose `text` exceeds HARD_MAX_UNIT_CHARS
// (8000) even when the prompt forbids it. Rather than rejecting the whole
// response and retrying (which hits the same deterministic merge), we split
// oversized units locally at paragraph → sentence → space boundaries.
// Schema validation becomes a backstop, not the load-bearing chunker.

function findSplitPoint(text: string, target: number): number {
  // Prefer paragraph break, then newline, then sentence end, then space.
  // Look up to 1000 chars past target for a clean boundary.
  const windowEnd = Math.min(target + 1000, text.length);
  const slice = text.slice(0, windowEnd);
  const minAcceptable = Math.floor(target * 0.5);

  const paraIdx = slice.lastIndexOf('\n\n', target);
  if (paraIdx > minAcceptable) return paraIdx + 2;

  const newlineIdx = slice.lastIndexOf('\n', target);
  if (newlineIdx > minAcceptable) return newlineIdx + 1;

  const sentenceIdx = Math.max(
    slice.lastIndexOf('. ', target),
    slice.lastIndexOf('? ', target),
    slice.lastIndexOf('! ', target),
  );
  if (sentenceIdx > minAcceptable) return sentenceIdx + 2;

  const spaceIdx = slice.lastIndexOf(' ', target);
  if (spaceIdx > minAcceptable) return spaceIdx + 1;

  return target; // last resort: hard cut
}

function splitOversizedUnit(unit: { title: string; text: string }): {
  title: string;
  text: string;
}[] {
  const TARGET_PART_SIZE = 6000; // well under HARD_MAX_UNIT_CHARS=8000
  // Reserve room for " (part NN)" suffix so the title doesn't exceed cap.
  const baseTitle = unit.title.length > HARD_MAX_TITLE_CHARS - 12
    ? unit.title.slice(0, HARD_MAX_TITLE_CHARS - 12)
    : unit.title;

  const parts: { title: string; text: string }[] = [];
  let remaining = unit.text;
  let partNum = 1;

  while (remaining.length > HARD_MAX_UNIT_CHARS) {
    const splitAt = findSplitPoint(remaining, TARGET_PART_SIZE);
    const piece = remaining.slice(0, splitAt).trim();
    if (piece.length > 0) {
      parts.push({ title: `${baseTitle} (part ${partNum})`, text: piece });
      partNum++;
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    parts.push({
      title: parts.length > 0 ? `${baseTitle} (part ${partNum})` : unit.title,
      text: remaining,
    });
  }

  // Audit M3 — postcondition: EVERY part must be ≤ HARD_MAX_UNIT_CHARS so the
  // DB CHECK (text BETWEEN 1 AND 8000) and the Zod schema are backstops, not
  // the gate. The loop above already guarantees this (it exits at remaining ≤
  // 8000 and findSplitPoint always advances ≥ target*0.5), but a future edit
  // to findSplitPoint could break that invariant — hard-cut any straggler so
  // the splitter's contract holds by construction, not by reasoning.
  const safe: { title: string; text: string }[] = [];
  for (const p of parts) {
    if (p.text.length <= HARD_MAX_UNIT_CHARS) { safe.push(p); continue; }
    for (let off = 0, n = 1; off < p.text.length; off += HARD_MAX_UNIT_CHARS, n++) {
      safe.push({ title: `${baseTitle} (part ${partNum + n - 1})`, text: p.text.slice(off, off + HARD_MAX_UNIT_CHARS).trim() });
    }
  }
  return safe;
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

HARD LIMIT: each unit's "text" field MUST be ≤${HARD_MAX_UNIT_CHARS} characters. If a single narrative beat would exceed ${HARD_MAX_UNIT_CHARS} chars, split it at a paragraph or sentence boundary into two or more consecutive units that together cover the same content. Never emit a "text" longer than ${HARD_MAX_UNIT_CHARS} chars under any circumstance.

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
    // Disable thinking mode — structured-output JSON task at temp 0.2;
    // reasoning tokens add 10-20s of latency before first output token and
    // don't improve schema adherence. Family-aware shape (2.5: thinkingBudget,
    // 3.x: thinkingLevel) mirrors server/voice-proxy/brain-llm-common.js#thinkingConfigFor.
    const isV3 = /^gemini-3(\.|-)/i.test(NARRATIVE_CHUNK_MODEL);
    // SDK-canonical enum for generateContent (serializes to "MINIMAL", uppercase).
    // Same LOGICAL level as the JS proxy mirror brain-llm-common.js#thinkingConfigFor,
    // but DIFFERENT WIRE CASING — the proxy sends lowercase 'minimal'. Inert today
    // (default model is gemini-2.5-flash → isV3=false → thinkingBudget:0 path). Before
    // any gemini-3.x model is pinned here, the v3 enable gate (P1-9) MUST verify which
    // casing the pinned model actually honors so the two paths don't silently diverge.
    const thinkingConfig = isV3
      ? { thinkingLevel: ThinkingLevel.MINIMAL }
      : { thinkingBudget: 0 };
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
        thinkingConfig,
        // gemini-2.5-flash silently defaults maxOutputTokens to 8192 (model max
        // is 65535). A 70K-char doc needs ~18K tokens of structured JSON; without
        // an explicit cap the response truncates mid-JSON → Zod parse fails →
        // fallback_to_v1. Verified 2026-05-20 against Google AI Dev Forum + the
        // google-gemini/gemini-cli#23081 silent-truncation issue.
        // 2026-05-21 (audit M4) — 32768 → 65535 (model max). A large doc whose
        // units re-emit most of the source text as JSON `text` fields can
        // exceed 32768 output tokens and truncate; the local splitter only
        // runs on SUCCESSFULLY parsed JSON, so it cannot rescue a truncated
        // response. Max headroom here; the real ceiling is the input doc size
        // (chunk the input for pathologically large samples — future work).
        maxOutputTokens: 65535,
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

  // Defensive splitter — if Flash emitted any unit with text > 8000 chars,
  // split it locally before Zod validates. See splitOversizedUnit header.
  if (
    parsed != null &&
    typeof parsed === 'object' &&
    'units' in (parsed as Record<string, unknown>) &&
    Array.isArray((parsed as { units: unknown }).units)
  ) {
    const rawUnits = (parsed as { units: Array<{ title?: unknown; text?: unknown }> }).units;
    const splitUnits: { title: string; text: string }[] = [];
    let splitFiredCount = 0;
    for (const u of rawUnits) {
      if (
        u != null &&
        typeof u.title === 'string' &&
        typeof u.text === 'string'
      ) {
        if (u.text.length > HARD_MAX_UNIT_CHARS) {
          splitFiredCount++;
          for (const piece of splitOversizedUnit({ title: u.title, text: u.text })) {
            splitUnits.push(piece);
          }
        } else {
          splitUnits.push({ title: u.title, text: u.text });
        }
      } else {
        // Pass through malformed unit; Zod will reject with a clearer error.
        splitUnits.push(u as unknown as { title: string; text: string });
      }
    }
    if (splitFiredCount > 0) {
      console.log(
        `[narrative-chunk] split ${splitFiredCount} oversized unit(s) locally → ${splitUnits.length} total units`,
      );
    }
    (parsed as { units: unknown }).units = splitUnits;
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
    // DIAG (2026-05-20): surface per-attempt failure codes so operator can
    // see WHY the chunker fell back to v1. Remove once root cause is known.
    if (e instanceof NarrativeChunkError) {
      console.error(
        `[narrative-chunk] attempt 1 failed: code=${e.code} msg=${(e.message || '').slice(0, 500)}`,
      );
    } else {
      console.error('[narrative-chunk] attempt 1 failed (non-NCE):', e);
    }
    if (e instanceof NarrativeChunkError) {
      if (e.code === 'api_key_missing' || e.code === 'empty_input') {
        throw e;
      }
      try {
        const r2 = await callFlashOnce({
          sanitizedDocument: args.sanitizedDocument,
          sampleTitle: args.sampleTitle,
          strict: true,
          attempt: 2,
        });
        return { units: r2.units, attempt: 2, ms: Date.now() - t0, usage: r2.usage };
      } catch (e2) {
        // DIAG (2026-05-20)
        if (e2 instanceof NarrativeChunkError) {
          console.error(
            `[narrative-chunk] attempt 2 failed: code=${e2.code} msg=${(e2.message || '').slice(0, 500)}`,
          );
        } else {
          console.error('[narrative-chunk] attempt 2 failed (non-NCE):', e2);
        }
        return null;
      }
    }
    throw e;
  }
}
