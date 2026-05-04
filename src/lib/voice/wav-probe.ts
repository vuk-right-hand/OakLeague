// Pure-Node WAV header probe. v1 narrowing for the admin voice-clone upload
// route: rather than pull `file-type` + `music-metadata` as Vercel deps,
// accept WAV only and parse duration from the canonical RIFF header.
//
// Other table-allowed MIMEs (audio/mpeg, audio/ogg, audio/x-m4a, audio/mp4)
// are forward-compatible at the SQL layer (0047 CHECK constraint) — the
// route gates them out for now and post-YC we wire a multi-format probe.

export type WavInfo = {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  bytes: number;
};

/**
 * Parse a WAV's metadata from its first ~64 bytes. Returns null if the
 * buffer doesn't look like a canonical PCM WAV. Caller must handle null
 * as "unsupported file."
 */
export function probeWav(buf: Buffer | Uint8Array): WavInfo | null {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 44) return null;
  if (b.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  if (b.slice(8, 12).toString('ascii') !== 'WAVE') return null;

  // Walk subchunks looking for fmt + data (some WAVs have JUNK first).
  // S-C1 — every chunk size MUST fit inside the buffer; reject any that
  // doesn't. Also cap iterations to defeat a malformed file with a chunk
  // size of 0 that would loop on `offset += 8` indefinitely.
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let dataLen: number | null = null;
  let iter = 0;
  const MAX_ITERS = 64;
  while (offset + 8 <= b.length) {
    if (++iter > MAX_ITERS) return null;
    const id = b.slice(offset, offset + 4).toString('ascii');
    const size = b.readUInt32LE(offset + 4);
    // S-C1 — chunk must fit in the buffer.
    if (size > b.length || offset + 8 + size > b.length) return null;
    if (id === 'fmt ') {
      if (size < 16 || offset + 8 + 16 > b.length) return null;
      const audioFormat = b.readUInt16LE(offset + 8);
      // 1 = PCM (canonical). 0xFFFE = WAVE_FORMAT_EXTENSIBLE — common for
      // 24-bit PCM exports; treat as PCM if subFormat first 2 bytes are
      // 0x0001 (KSDATAFORMAT_SUBTYPE_PCM). Anything else: reject.
      if (audioFormat === 1) {
        // canonical PCM — accept
      } else if (audioFormat === 0xfffe && size >= 40) {
        const subFormat = b.readUInt16LE(offset + 8 + 24);
        if (subFormat !== 1) return null;
      } else {
        return null;
      }
      const channels = b.readUInt16LE(offset + 10);
      const sampleRate = b.readUInt32LE(offset + 12);
      const bitsPerSample = b.readUInt16LE(offset + 22);
      fmt = { sampleRate, channels, bitsPerSample };
    } else if (id === 'data') {
      dataLen = size;
      break;
    }
    // chunks are padded to 2-byte alignment. size===0 + iter cap above
    // protects against a 0-size unknown chunk infinite-walking.
    offset += 8 + size + (size % 2);
  }
  if (!fmt || dataLen === null) return null;
  if (fmt.sampleRate === 0 || fmt.channels === 0 || fmt.bitsPerSample === 0) return null;

  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  if (bytesPerSecond <= 0) return null;
  const durationSeconds = dataLen / bytesPerSecond;
  return {
    durationSeconds,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    bytes: b.length,
  };
}
