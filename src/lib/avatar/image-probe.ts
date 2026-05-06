// Magic-byte image probe for face-upload (FACE_UI_PLAN §4).
//
// Replaces `wav-probe.ts` for the face lane: server-side sniff of MIME +
// pixel dimensions from JPEG / PNG byte streams. Zero deps; no Sharp,
// no native bindings — both formats expose width/height in fixed
// positions or marker-prefixed segments we can walk.
//
// Phase 0 (PHASE_0_FACE_API.md) confirmed Simli enforces:
//   - max 5 MB per image (we cap at 4.5 MB pre-flight)
//   - JPEG and PNG only
// And our plan adds:
//   - 256–4096 px on each axis
//   - aspect ratio in {9:16, 16:9, 1:1}, ±5% tolerance.
//
// All clamps are enforced at the route layer; this module only returns
// the raw probe (mime + dims). The route maps probe results to error
// codes (bad_image_dims / bad_aspect / etc.).

export type ImageProbe = {
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = 0xffd8;

// JPEG SOFn markers — frame headers carrying width/height.
// SOF0 (baseline) and SOF2 (progressive) are 99% of consumer encoder
// output (iPhone, Android, browsers). We prefer those when present.
// SOF3+ (lossless / hierarchical / arithmetic-coded) are exotic; we
// still read them but track them separately so a hierarchical JPEG
// (multi-resolution thumbnail-first stream) doesn't trick us into
// classifying the lowest-res frame as the image dimensions
// (auditor R2-M6).
const JPEG_SOF_PRIMARY = new Set<number>([0xc0, 0xc2]);
const JPEG_SOF_SECONDARY = new Set<number>([
  0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function probeImage(buf: Buffer): ImageProbe | null {
  if (!buf || buf.length < 24) return null;

  // PNG: 8-byte signature, then IHDR chunk at offset 8 with width/height
  // as big-endian uint32 at offsets 16 / 20.
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // IHDR length is at offset 8; chunk type "IHDR" at offset 12.
    const chunkType = buf.subarray(12, 16).toString('ascii');
    if (chunkType !== 'IHDR') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { mime: 'image/png', width, height };
  }

  // JPEG: starts with FF D8, then a sequence of segments, each beginning
  // FF <marker> <length-uint16-BE> <length-2 bytes of data>. Walk every
  // segment to find SOFn markers. We prefer SOF0/SOF2 (baseline /
  // progressive) and remember the largest dimensions we see — defends
  // against hierarchical JPEGs whose first SOF is a low-res thumbnail
  // (auditor R2-M6). Stop walking after SOS (start of scan) — SOFs after
  // SOS aren't part of the primary frame.
  if (buf.readUInt16BE(0) === JPEG_SOI) {
    let primary: { width: number; height: number } | null = null;
    let secondaryBest: { width: number; height: number } | null = null;
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) return null;
      let mi = offset + 1;
      while (mi < buf.length && buf[mi] === 0xff) mi += 1;
      if (mi >= buf.length) return null;
      const marker = buf[mi];
      // SOS — stop walking; subsequent bytes are entropy-coded data.
      if (marker === 0xda) break;
      // Standalone markers without segment payload (RST*, SOI, EOI, TEM).
      const isStandalone =
        (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01;
      if (isStandalone) {
        offset = mi + 1;
        continue;
      }
      if (mi + 2 >= buf.length) return null;
      const segLen = buf.readUInt16BE(mi + 1);
      if (segLen < 2) return null;
      if (JPEG_SOF_PRIMARY.has(marker) || JPEG_SOF_SECONDARY.has(marker)) {
        // SOF body: precision (1B) | height (2B BE) | width (2B BE) | components ...
        if (mi + 1 + segLen > buf.length) return null;
        if (mi + 8 > buf.length) return null;
        const height = buf.readUInt16BE(mi + 4);
        const width = buf.readUInt16BE(mi + 6);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          if (JPEG_SOF_PRIMARY.has(marker)) {
            // First baseline/progressive SOF wins — that's the canonical
            // frame for 99% of consumer JPEGs.
            primary = { width, height };
            break;
          }
          // For exotic SOF variants, keep walking and remember the
          // largest frame we've seen (defeats thumbnail-first hierarchical
          // streams).
          if (!secondaryBest || width * height > secondaryBest.width * secondaryBest.height) {
            secondaryBest = { width, height };
          }
        }
      }
      offset = mi + 1 + segLen;
    }
    const chosen = primary ?? secondaryBest;
    if (chosen) return { mime: 'image/jpeg', width: chosen.width, height: chosen.height };
    return null;
  }

  return null;
}

// Aspect-ratio classification with ±5% tolerance. Returns the closest
// canonical aspect or null when it doesn't match any allowed bucket.
export type AllowedAspect = '9:16' | '16:9' | '1:1';

const ASPECT_TOLERANCE = 0.05;

const ASPECT_TARGETS: Array<{ name: AllowedAspect; ratio: number }> = [
  { name: '1:1', ratio: 1 },
  { name: '9:16', ratio: 9 / 16 },
  { name: '16:9', ratio: 16 / 9 },
];

export function classifyAspect(width: number, height: number): AllowedAspect | null {
  if (width <= 0 || height <= 0) return null;
  const ratio = width / height;
  for (const t of ASPECT_TARGETS) {
    if (Math.abs(ratio - t.ratio) / t.ratio <= ASPECT_TOLERANCE) return t.name;
  }
  return null;
}
