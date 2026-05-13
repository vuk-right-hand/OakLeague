// preprocess.ts — sanitize sample_content.raw_text before LLM-driven chunking
// AND before Anthropic-style contextual-gen.
//
// Two pure functions:
//
//   1. stripSlideMarkers(raw)        — removes "42-" line-start prefixes that
//      survive transcript exports from slide-driven talks. These numbers add
//      positional noise to embeddings (the model correlates "1-" with intro-
//      content) without carrying semantic value. Conservative: only matches
//      at line start so a mid-sentence "I lived in NYC from 42-46" survives.
//
//   2. sanitizeForLLMPrompt(text)    — Unicode-aware defense against prompt
//      injection in creator content that gets passed verbatim inside
//      <document>...</document> envelopes to Haiku 4.5 (Anthropic Contextual
//      Retrieval) and to Gemini Flash (narrative chunking).
//
// Audit-2 C3 spec (round-3 Unicode-aware fix; supersedes the original
// ASCII-only XML-tag strip): 5 passes, in order:
//   (a) NFKC normalize — collapse fullwidth (＜／document＞
//       → </document>) and other compatibility forms BEFORE the literal-
//       string strip.
//   (b) Strip zero-width and bidi-control codepoints that smuggle invisible
//       payload past visual review.
//   (c) Strip C0/C1 controls except \t \n \r.
//   (d) Strip XML-tag-shaped delimiters that match our prompt envelope tags.
//   (e) Escape line-start markdown structural tokens (Haiku honors # / ###
//       headers, --- thematic breaks, triple-backtick code fences as structural
//       cues — adversarial content can use these to "escape" the data envelope).
//
// Output is plain text safe to interpolate into a prompt without re-parsing
// the LLM's intent. Test fixture coverage in preprocess.test.ts spans 4
// attack classes (fullwidth, zero-width, RTL-override, markdown).
//
// Pure functions, no I/O. Server-only because the module is only meaningful
// inside the embed-worker pipeline.

import 'server-only';

// ── Pass 1: Slide-marker stripping ──────────────────────────────────────────
//
// Targets line-start "<digits>-<optional-space>" prefixes that survive slide-
// to-text transcript exports. The /m flag anchors ^ to each line start, not
// just the start of the input. Conservative pattern — requires line start so
// natural mid-sentence number-dash usage ("from 42-46") is untouched.
//
// Multi-digit slide numbers and "X-" (with no trailing space — common in CSV-
// style exports) both match. Trailing newline/whitespace preserved so the
// stripped slide markers don't collapse paragraphs.
//
// Audit-7 M7 fix: negative lookahead `(?!\d)` rejects digit-dash-DIGIT so
// "1980-1990 was a great decade" at line start is preserved (a year range,
// not a slide marker). Slide markers are always "<N>-<word/text>", never
// "<N>-<digits>".

const SLIDE_MARKER_RE = /^[ \t]*\d+-(?!\d)[ \t]*/gm;

export function stripSlideMarkers(raw: string): string {
  return raw.replace(SLIDE_MARKER_RE, '');
}


// ── Pass 2-6: sanitizeForLLMPrompt ──────────────────────────────────────────

// Zero-width + bidi-control codepoints we strip. These are the standard
// invisible-glyph attack surface for prompt smuggling. ALL ranges below use
// explicit \u{...} escapes — literal control chars in source are fragile
// (editors / git autocrlf / copy-paste lose them silently).
//   U+200B  ZERO WIDTH SPACE
//   U+200C  ZERO WIDTH NON-JOINER
//   U+200D  ZERO WIDTH JOINER
//   U+200E  LEFT-TO-RIGHT MARK
//   U+200F  RIGHT-TO-LEFT MARK
//   U+2028  LINE SEPARATOR
//   U+2029  PARAGRAPH SEPARATOR
//   U+202A-U+202E  bidi formatting (LRE/RLE/PDF/LRO/RLO — the RLO attack)
//   U+2060-U+2064  word joiner + invisible math ops
//   U+FEFF  ZERO WIDTH NO-BREAK SPACE (BOM)
//   U+E0000-U+E007F  Tag block (ZWJ-encoded payloads — requires /u flag for surrogate-pair handling)
const ZERO_WIDTH_AND_BIDI_RE =
  /[\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2064}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

// C0 controls (\x00-\x1F) except \t (\x09) \n (\x0A) \r (\x0D), and C1
// controls (\x7F-\x9F). Keep whitespace because LLM prompts depend on
// paragraph structure.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Combining-mark codepoints (audit-7 C3). NFKC does NOT strip these — a
// payload like </d\u{0301}ocument> (d + combining acute) survives NFKC AND
// the literal `document` regex misses because the codepoint sequence is
// `d` `́` `o` `c` `u` `m` `e` `n` `t`. Strip these between Pass (a) NFKC and
// Pass (d) tag strip so the regex matches the bare ASCII tag spelling.
// Covers: Combining Diacritical Marks (U+0300-U+036F), Extended (U+1AB0-U+1AFF),
// Supplement (U+1DC0-U+1DFF), Symbols (U+20D0-U+20FF), Half Marks (U+FE20-U+FE2F).
const COMBINING_MARKS_RE =
  /[\u{0300}-\u{036F}\u{1AB0}-\u{1AFF}\u{1DC0}-\u{1DFF}\u{20D0}-\u{20FF}\u{FE20}-\u{FE2F}]/gu;

// XML-tag-shaped delimiters that match our Anthropic / Gemini prompt envelope
// tags. Case-insensitive because Haiku tokenizes case-insensitively in the
// structural context. Audit-7 C1 fix: attribute value pattern now handles
// quoted values explicitly so a `<document foo=">payload</document>"` attack
// is matched as a single tag (greedy on quoted attribute values) instead of
// stopping at the first `>` inside a quoted attribute and leaking the
// payload as plain text.
//
// Expanded tag list per audit-7 small — Anthropic's prompt-injection cookbook
// flags these structural cue words as commonly-respected.
const ENVELOPE_TAG_RE =
  /<\/?(?:document|chunk|reference|system|instructions|context|data|prompt|assistant|human|user|role|tool|function|output)\b(?:"[^"]*"|'[^']*'|[^>])*>/gi;

// Line-start markdown structural tokens. Escape by prefixing a U+00B7 MIDDLE
// DOT so the line reads naturally but doesn't parse as structure to the LLM.
// Multiline flag anchors ^ to each line start.
//
// Audit-7 C2 fix: CommonMark §4.2 allows up to 3 leading spaces before an
// ATX header AND a hrule, and the resulting line still parses as structure.
// The original regexes anchored at column 0, missing leading-space attacks
// like "   # SYSTEM" — adversary slipped past with 1-3 spaces of indent.
// Each pattern now consumes 0-3 leading spaces/tabs.
//
// We escape:
//   * ATX headers   — "#" to "######" followed by whitespace
//   * Horizontal rule / setext underline — 3+ "-" or "=" on a line alone
//   * Triple-backtick fence — ```...
//
// We do NOT escape:
//   * Mid-line "#" (e.g., "C# is a great language")
//   * Mid-line "---" (e.g., "well---maybe")
//   * Bullet lists, numbered lists — too noisy and not a structural cue Haiku
//     uses to escape the document envelope.
const MD_HEADER_RE       = /^([ \t]{0,3})(#{1,6})(\s)/gm;
const MD_HRULE_RE        = /^([ \t]{0,3})([-=]{3,})\s*$/gm;
const MD_CODE_FENCE_RE   = /^([ \t]{0,3})(```+)/gm;

// Escape prefix — U+00B7 MIDDLE DOT. Renders cleanly to humans reading the
// chunk_context in admin tooling; not a markdown structural cue.
const ESC_PREFIX = '\u{00B7}';

export function sanitizeForLLMPrompt(text: string): string {
  if (!text) return text;

  // (a) NFKD normalize (compatibility decomposition). Collapses fullwidth
  // tag-spoofing forms to ASCII AND decomposes precomposed accented characters
  // into base+combining sequences. Audit-7 C3: the original NFKC pass would
  // pre-compose some accent combinations (e.g., `o\u{0301}` → `ó`) BEFORE the
  // combining-mark strip ran, leaving precomposed accented forms in the tag
  // name that the literal-string regex still missed. NFKD keeps everything
  // decomposed so the combining-mark strip catches every accent path.
  let out = text.normalize('NFKD');

  // (a2) Strip combining diacritical marks. After NFKD, every accent is its
  // own combining codepoint attached to a base letter — strip them all so
  // the envelope-tag regex sees bare ASCII for the structural pattern check.
  out = out.replace(COMBINING_MARKS_RE, '');

  // (b) Strip zero-width + bidi. Order matters: do this BEFORE the literal
  // tag strip, otherwise an adversary can interleave ZWSPs to bypass:
  //   "<\u{200B}document\u{200B}>"  — pre-strip is <document>; post-strip
  // alone wouldn't match because the tag regex is greedy on contiguous chars.
  out = out.replace(ZERO_WIDTH_AND_BIDI_RE, '');

  // (c) Strip C0/C1 controls except \t \n \r.
  out = out.replace(CONTROL_CHARS_RE, '');

  // (d) Strip XML-tag-shaped envelope delimiters. Iterate to a FIXED POINT so
  // nested-leftover attacks don't sneak through (audit-7 C1). Example payload
  // pre-fix: `<document foo=">payload</document>"` — single-pass regex
  // strips `<document foo=">` (stops at first `>` inside attr) and leaves
  // `payload</document>"` in the input, where the global-flag scan THEN
  // catches `</document>` on the SAME pass — but the leaking `payload` is
  // already textually-resident. Fixed-point iteration after the quoted-attr
  // regex closes the loop on any residue.
  let prev: string;
  do {
    prev = out;
    out = out.replace(ENVELOPE_TAG_RE, '');
  } while (out !== prev);

  // (e) Escape line-start markdown structural tokens. Prefix with MIDDLE DOT.
  // Audit-7 C2: regexes now consume 0-3 leading spaces so a `   # SYSTEM`
  // attack doesn't bypass the escape. Capture groups: $1 = leading whitespace
  // (preserved), then the structural token, then optional trailing space.
  out = out.replace(MD_HEADER_RE,     `$1${ESC_PREFIX}$2$3`);
  out = out.replace(MD_HRULE_RE,      `$1${ESC_PREFIX}$2`);
  out = out.replace(MD_CODE_FENCE_RE, `$1${ESC_PREFIX}$2`);

  return out;
}


// ── Public composition ─────────────────────────────────────────────────────
//
// Top-level helper used by the embed-worker before passing raw_text into
// either narrative-chunk.ts (Gemini Flash) or contextual-gen (Anthropic Haiku).
// Both LLMs see the SAME sanitized text — the sanitizer is path-agnostic.

export function preprocessRawText(raw: string): string {
  if (!raw) return '';
  return sanitizeForLLMPrompt(stripSlideMarkers(raw));
}
