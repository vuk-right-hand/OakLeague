// chunk-sample.ts — pure-function chunker for sample_content.raw_text.
//
// Splits raw_text into 500-token windows with 80-token overlap, capping each
// chunk at 2048 tokens (the gemini-embedding-001 input ceiling). Splits on
// natural boundaries first (paragraph then sentence), falling back to hard
// byte boundaries if necessary.
//
// Token counting uses a deterministic ~4-chars-per-token approximation for
// budgeting (no tiktoken dep). Real token counts come from the embedding
// API response and are persisted on the chunk row.
//
// Topic_tags propagate from parent sample_content unchanged — chunks inherit;
// no per-chunk auto-tagging (explicitly out of scope per the pgvector plan).

export type SampleChunk = {
  index: number;
  text: string;
  tokenCount: number;   // estimate; refined by API response if available
  topicTags: string[];
};

// Tunables. 500-token target with 80-token overlap balances retrieval recall
// (smaller chunks → better topical precision) against context efficiency.
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 80;
// Hard cap aligned with gemini-embedding-001 input ceiling AND the
// sample_content_chunks.token_count CHECK constraint (≤ 2048).
const HARD_MAX_TOKENS = 2048;
// Approximate char/token ratio for English prose. ~4 chars/token is the
// commonly-cited rule of thumb across OpenAI / Google tokenizers.
const CHARS_PER_TOKEN = 4;
// Character ceiling per chunk to satisfy the 8000-char text CHECK constraint
// even if a paragraph is unusually compact (Asian languages, no spaces, etc).
const HARD_MAX_CHARS = 8000;

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / CHARS_PER_TOKEN));
}

// Split paragraph-or-sentence boundaries. Each returned segment is a candidate
// for inclusion in a chunk; if a segment by itself exceeds HARD_MAX_TOKENS we
// recursively hard-split on character boundary at the segment level.
function splitOnBoundaries(s: string): string[] {
  // First pass: paragraph split (double-newline). Most pasted transcripts use
  // single newlines or no separators; in that case this returns the full text
  // as one segment and the sentence pass below handles it.
  const paragraphs = s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Second pass: within each paragraph, split on sentence terminators.
  const segments: string[] = [];
  for (const p of paragraphs) {
    if (estimateTokens(p) <= HARD_MAX_TOKENS) {
      segments.push(p);
      continue;
    }
    // Sentence boundary regex — matches `.`, `?`, `!` followed by whitespace
    // or end-of-string. Keeps the punctuation with the leading sentence.
    const sentences = p.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [p];
    for (const sent of sentences) {
      const trimmed = sent.trim();
      if (!trimmed) continue;
      if (estimateTokens(trimmed) > HARD_MAX_TOKENS) {
        // Pathological: a single sentence longer than the hard cap. Hard-split
        // on the character boundary at HARD_MAX_CHARS to keep us under the
        // text CHECK constraint.
        for (let i = 0; i < trimmed.length; i += HARD_MAX_CHARS) {
          segments.push(trimmed.slice(i, i + HARD_MAX_CHARS));
        }
      } else {
        segments.push(trimmed);
      }
    }
  }
  return segments;
}

// Pack segments into windowed chunks of ~TARGET_TOKENS each with OVERLAP_TOKENS
// of carry-forward. Overlap helps retrieval recover information that spans a
// chunk boundary.
function pack(segments: string[]): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curTokens = 0;
  // Track the tail of the current chunk for overlap carry-forward; we keep
  // approximately OVERLAP_TOKENS worth of trailing text.
  let tailBuffer: string[] = [];
  let tailTokens = 0;

  const flush = () => {
    if (cur.trim().length > 0) {
      // Defensive: even though pack() bounds at HARD_MAX_TOKENS, an overlap
      // carry-forward + a long segment could in theory push past HARD_MAX_CHARS.
      // Clip on the char boundary as the last line of defense.
      chunks.push(cur.trim().slice(0, HARD_MAX_CHARS));
    }
    cur = tailBuffer.join(' ');
    curTokens = tailTokens;
    tailBuffer = [];
    tailTokens = 0;
  };

  for (const seg of segments) {
    const segTok = estimateTokens(seg);

    // If a single segment is bigger than HARD_MAX_TOKENS even after splitting,
    // emit it as its own chunk standalone.
    if (segTok > HARD_MAX_TOKENS) {
      if (cur.trim().length > 0) flush();
      chunks.push(seg.slice(0, HARD_MAX_CHARS));
      // No overlap carry from a single oversize segment — it's already a
      // discrete unit.
      cur = '';
      curTokens = 0;
      tailBuffer = [];
      tailTokens = 0;
      continue;
    }

    if (curTokens + segTok > TARGET_TOKENS && curTokens > 0) {
      flush();
    }

    if (cur.length > 0) cur += ' ';
    cur += seg;
    curTokens += segTok;

    // Maintain a rolling tail of trailing segments for the next chunk's overlap.
    tailBuffer.push(seg);
    tailTokens += segTok;
    while (tailTokens > OVERLAP_TOKENS && tailBuffer.length > 1) {
      const dropped = tailBuffer.shift()!;
      tailTokens -= estimateTokens(dropped);
    }
  }
  // Final flush — but don't carry overlap forward into a phantom chunk.
  if (cur.trim().length > 0) {
    chunks.push(cur.trim().slice(0, HARD_MAX_CHARS));
  }
  return chunks;
}

export function chunkSample(args: {
  rawText: string;
  topicTags: string[];
}): SampleChunk[] {
  const { rawText, topicTags } = args;
  if (!rawText || rawText.trim().length === 0) return [];

  const segments = splitOnBoundaries(rawText);
  const packed = pack(segments);

  return packed.map((text, index) => ({
    index,
    text,
    tokenCount: estimateTokens(text),
    topicTags: [...topicTags],
  }));
}
