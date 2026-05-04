import { describe, it, expect } from 'vitest';
import { probeWav } from './wav-probe';

function buildWav({ sampleRate = 16000, channels = 1, bitsPerSample = 16, dataBytes = 32000 } = {}) {
  const dataLen = dataBytes;
  const buf = Buffer.alloc(44 + dataLen, 0);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 4, 'ascii');
  buf.write('fmt ', 12, 4, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 4, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

describe('probeWav', () => {
  it('parses a 1s 16kHz mono PCM WAV → duration ≈ 1.0', () => {
    const w = probeWav(buildWav({ sampleRate: 16000, dataBytes: 32000 }));
    expect(w).not.toBeNull();
    expect(w!.durationSeconds).toBeCloseTo(1.0, 3);
    expect(w!.sampleRate).toBe(16000);
    expect(w!.channels).toBe(1);
    expect(w!.bitsPerSample).toBe(16);
  });

  it('parses a 5s 24kHz stereo PCM WAV', () => {
    const w = probeWav(buildWav({ sampleRate: 24000, channels: 2, dataBytes: 24000 * 2 * 2 * 5 }));
    expect(w!.durationSeconds).toBeCloseTo(5.0, 3);
    expect(w!.channels).toBe(2);
  });

  it('returns null for non-RIFF buffers', () => {
    expect(probeWav(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('returns null for buffers shorter than 44 bytes', () => {
    expect(probeWav(Buffer.alloc(20))).toBeNull();
  });

  it('returns null for non-PCM (audioFormat != 1)', () => {
    const w = buildWav();
    w.writeUInt16LE(2, 20); // change audioFormat to non-PCM
    expect(probeWav(w)).toBeNull();
  });

  it('S-C1: rejects a chunk whose declared size exceeds the buffer', () => {
    const w = buildWav();
    // Corrupt the data chunk size to 0xFFFFFFFF.
    w.writeUInt32LE(0xffffffff, 40);
    expect(probeWav(w)).toBeNull();
  });

  it('S-C1: rejects a malformed file with a runaway zero-size chunk', () => {
    // Build a file that has only an unknown 0-size chunk after the header.
    const buf = Buffer.alloc(28, 0);
    buf.write('RIFF', 0, 4, 'ascii');
    buf.writeUInt32LE(20, 4);
    buf.write('WAVE', 8, 4, 'ascii');
    // Unknown chunk 'XXXX' with size=0 — would infinite-loop without the iter cap.
    buf.write('XXXX', 12, 4, 'ascii');
    buf.writeUInt32LE(0, 16);
    expect(probeWav(buf)).toBeNull();
  });
});
