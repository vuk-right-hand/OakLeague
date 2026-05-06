import { describe, it, expect } from 'vitest';
import { probeImage, classifyAspect } from './image-probe';

// Synthetic byte buffers — no fixture files needed.

function makePngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // Signature.
  buf.writeUInt8(0x89, 0); buf.writeUInt8(0x50, 1); buf.writeUInt8(0x4e, 2); buf.writeUInt8(0x47, 3);
  buf.writeUInt8(0x0d, 4); buf.writeUInt8(0x0a, 5); buf.writeUInt8(0x1a, 6); buf.writeUInt8(0x0a, 7);
  // IHDR chunk length (always 13 for IHDR) at offset 8.
  buf.writeUInt32BE(13, 8);
  // Chunk type "IHDR" at 12.
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeJpegBaseline(width: number, height: number): Buffer {
  // SOI + SOF0 segment + EOI. Minimal-but-valid header for the probe.
  // Layout:
  //   FF D8           SOI
  //   FF E0 00 10 ... APP0 (JFIF) — included so we exercise the segment-walk loop
  //   FF C0 00 11 08 hh hh ww ww 03 ... SOF0 (8B precision, height, width, components)
  //   FF D9           EOI
  const sof0Body = Buffer.alloc(17);
  sof0Body.writeUInt16BE(17, 0);            // segment length (incl these 2 bytes)
  sof0Body.writeUInt8(8, 2);                // precision
  sof0Body.writeUInt16BE(height, 3);
  sof0Body.writeUInt16BE(width, 5);
  sof0Body.writeUInt8(3, 7);                // components count
  // remainder zero-padded — not parsed by probe.

  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, // marker + segment length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00,
    0x00, 0x48, 0x00, 0x48, 0x00, 0x00, // dpi etc
  ]);
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), sof0Body]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('probeImage — PNG', () => {
  it('returns dims for a valid PNG header', () => {
    const buf = makePngHeader(512, 768);
    const r = probeImage(buf);
    expect(r).toEqual({ mime: 'image/png', width: 512, height: 768 });
  });

  it('rejects a buffer that starts with PNG signature but lacks IHDR', () => {
    const buf = makePngHeader(512, 768);
    buf.write('XXXX', 12, 'ascii');
    expect(probeImage(buf)).toBeNull();
  });

  it('returns null on a too-short buffer', () => {
    expect(probeImage(Buffer.alloc(10))).toBeNull();
  });

  it('rejects width=0', () => {
    const buf = makePngHeader(0, 768);
    expect(probeImage(buf)).toBeNull();
  });
});

describe('probeImage — JPEG', () => {
  it('returns dims for a baseline JPEG with APP0 + SOF0', () => {
    const buf = makeJpegBaseline(1024, 1024);
    expect(probeImage(buf)).toEqual({ mime: 'image/jpeg', width: 1024, height: 1024 });
  });

  it('returns null when no SOF marker is found before end of buffer', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI only
    expect(probeImage(buf)).toBeNull();
  });

  it('returns null on a buffer that is neither PNG nor JPEG', () => {
    expect(probeImage(Buffer.from('not an image'))).toBeNull();
  });

  it('prefers the first baseline SOF0 even if a hierarchical SOF appears first (auditor R2-M6)', () => {
    // Synthetic hierarchical-style JPEG: a tiny SOF3 (0xc3) thumbnail
    // appears first, then the real SOF0 at the canonical resolution.
    // Probe must return the SOF0 dimensions, not the thumbnail.
    function makeSofSegment(marker: number, w: number, h: number): Buffer {
      const body = Buffer.alloc(17);
      body.writeUInt16BE(17, 0);
      body.writeUInt8(8, 2);
      body.writeUInt16BE(h, 3);
      body.writeUInt16BE(w, 5);
      body.writeUInt8(3, 7);
      return Buffer.concat([Buffer.from([0xff, marker]), body]);
    }
    const sof3Thumb = makeSofSegment(0xc3, 64, 64);   // exotic — should NOT win
    const sof0Real = makeSofSegment(0xc0, 1080, 1080); // baseline — should win
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      sof3Thumb,
      sof0Real,
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(probeImage(buf)).toEqual({ mime: 'image/jpeg', width: 1080, height: 1080 });
  });

  it('falls back to largest secondary SOF if no SOF0/SOF2 present', () => {
    function makeSofSegment(marker: number, w: number, h: number): Buffer {
      const body = Buffer.alloc(17);
      body.writeUInt16BE(17, 0);
      body.writeUInt8(8, 2);
      body.writeUInt16BE(h, 3);
      body.writeUInt16BE(w, 5);
      body.writeUInt8(3, 7);
      return Buffer.concat([Buffer.from([0xff, marker]), body]);
    }
    // Two SOF3 segments — small first, large second. Largest must win.
    const small = makeSofSegment(0xc3, 100, 100);
    const large = makeSofSegment(0xc3, 800, 800);
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      small,
      large,
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(probeImage(buf)).toEqual({ mime: 'image/jpeg', width: 800, height: 800 });
  });

  it('stops walking at SOS marker and ignores frame headers in entropy data', () => {
    // SOS (0xda) then a 4-byte payload that happens to contain 0xff 0xc0
    // (looks like a SOF0 marker in entropy-coded data — must NOT be
    // picked up as the frame).
    function makeSofSegment(marker: number, w: number, h: number): Buffer {
      const body = Buffer.alloc(17);
      body.writeUInt16BE(17, 0);
      body.writeUInt8(8, 2);
      body.writeUInt16BE(h, 3);
      body.writeUInt16BE(w, 5);
      body.writeUInt8(3, 7);
      return Buffer.concat([Buffer.from([0xff, marker]), body]);
    }
    const sof0 = makeSofSegment(0xc0, 512, 512);
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      sof0,
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), // SOS
      // entropy bytes that LOOK like a SOF0 segment but should be ignored
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00]),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(probeImage(buf)).toEqual({ mime: 'image/jpeg', width: 512, height: 512 });
  });
});

describe('classifyAspect', () => {
  it('classifies 1080x1920 as 9:16', () => {
    expect(classifyAspect(1080, 1920)).toBe('9:16');
  });
  it('classifies 1920x1080 as 16:9', () => {
    expect(classifyAspect(1920, 1080)).toBe('16:9');
  });
  it('classifies 512x512 as 1:1', () => {
    expect(classifyAspect(512, 512)).toBe('1:1');
  });
  it('accepts 1080x1080 as 1:1', () => {
    expect(classifyAspect(1080, 1080)).toBe('1:1');
  });
  it('rejects an off-spec aspect like 4:3', () => {
    expect(classifyAspect(1024, 768)).toBeNull();
  });
  it('accepts a near-square within tolerance (1024x1056 ≈ 1:1)', () => {
    // ratio 0.97 — within ±5% of 1.
    expect(classifyAspect(1024, 1056)).toBe('1:1');
  });
  it('rejects 0/0', () => {
    expect(classifyAspect(0, 0)).toBeNull();
  });
});
