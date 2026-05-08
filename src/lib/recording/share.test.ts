import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionForMime, shareOrSave } from './share';

describe('extensionForMime', () => {
  it('returns mp4 for video/mp4 with codec params', () => {
    expect(extensionForMime('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('mp4');
  });
  it('returns webm for video/webm with codec params', () => {
    expect(extensionForMime('video/webm;codecs=vp9,opus')).toBe('webm');
  });
  it('returns mp4 for bare video/mp4', () => {
    expect(extensionForMime('video/mp4')).toBe('mp4');
  });
  it('handles uppercase MIME (per RFC, case-insensitive)', () => {
    expect(extensionForMime('VIDEO/MP4')).toBe('mp4');
  });
  it('defaults to webm for unknown/empty', () => {
    expect(extensionForMime('')).toBe('webm');
    expect(extensionForMime('application/octet-stream')).toBe('webm');
  });
});

// ── shareOrSave: jsdom is not running for this Node-env vitest, so we
// stub the bits we need. The point is that the codepath chooses correctly
// and never includes text/url alongside files.

function installFakeDom(opts: {
  share?: (data: ShareData) => Promise<void> | void;
  canShare?: (data: ShareData) => boolean;
}): { sharedWith: ShareData[]; downloads: { href: string; download: string }[] } {
  const sharedWith: ShareData[] = [];
  const downloads: { href: string; download: string }[] = [];

  vi.stubGlobal('navigator', {
    share: opts.share
      ? async (d: ShareData) => { sharedWith.push(d); await opts.share!(d); }
      : undefined,
    canShare: opts.canShare,
  });

  const fakeAnchor = {
    set href(v: string) { (this as unknown as Record<string, unknown>)._href = v; },
    get href(): string { return ((this as unknown as Record<string, unknown>)._href as string) ?? ''; },
    set download(v: string) { (this as unknown as Record<string, unknown>)._dl = v; },
    get download(): string { return ((this as unknown as Record<string, unknown>)._dl as string) ?? ''; },
    rel: '', click: vi.fn(),
  };
  vi.stubGlobal('document', {
    createElement: () => fakeAnchor,
    body: {
      appendChild: () => {
        downloads.push({ href: fakeAnchor.href, download: fakeAnchor.download });
      },
      removeChild: () => {},
    },
  });
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  });

  return { sharedWith, downloads };
}

afterEach(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  // Stub File globally — Node 18 has File, but vitest's pool may not.
  if (typeof globalThis.File === 'undefined') {
    globalThis.File = class FakeFile {
      name: string; type: string; size: number;
      constructor(parts: BlobPart[], name: string, opts?: { type?: string }) {
        this.name = name;
        this.type = opts?.type ?? '';
        this.size = parts.reduce((acc, p) => acc + (p instanceof Blob ? p.size : (p as string | ArrayBuffer).toString().length), 0);
      }
    } as unknown as typeof File;
  }
});

describe('shareOrSave — Web Share path', () => {
  it('passes files-only payload (NEVER text or url — iOS quirk)', async () => {
    const { sharedWith } = installFakeDom({
      share: () => {},
      canShare: () => true,
    });
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });
    const r = await shareOrSave({ blob, mimeType: 'video/mp4', shortId: 'ABC123' });
    expect(r.kind).toBe('shared');
    expect(sharedWith).toHaveLength(1);
    expect(sharedWith[0].files).toBeDefined();
    expect(sharedWith[0].text).toBeUndefined();
    expect(sharedWith[0].url).toBeUndefined();
  });

  it('falls back to download when canShare returns false', async () => {
    const { downloads, sharedWith } = installFakeDom({
      share: () => {},
      canShare: () => false,
    });
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/webm' });
    const r = await shareOrSave({ blob, mimeType: 'video/webm', shortId: 'XYZ789' });
    expect(r.kind).toBe('downloaded');
    expect(sharedWith).toHaveLength(0);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].download).toMatch(/\.webm$/);
  });

  it('returns cancelled on AbortError from share()', async () => {
    installFakeDom({
      share: () => { const e = new Error('user cancelled'); (e as Error & { name: string }).name = 'AbortError'; throw e; },
      canShare: () => true,
    });
    const blob = new Blob([new Uint8Array([1])], { type: 'video/mp4' });
    const r = await shareOrSave({ blob, mimeType: 'video/mp4', shortId: 'A' });
    expect(r.kind).toBe('cancelled');
  });

  it('falls back to download on non-Abort share() throw', async () => {
    const { downloads } = installFakeDom({
      share: () => { throw new Error('share platform error'); },
      canShare: () => true,
    });
    const blob = new Blob([new Uint8Array([1])], { type: 'video/mp4' });
    const r = await shareOrSave({ blob, mimeType: 'video/mp4', shortId: 'A' });
    expect(r.kind).toBe('downloaded');
    expect(downloads).toHaveLength(1);
  });

  it('uses the correct extension based on MIME', async () => {
    const { downloads } = installFakeDom({ canShare: () => false });
    await shareOrSave({
      blob: new Blob([new Uint8Array([1])]),
      mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      shortId: 'TOK1',
    });
    expect(downloads[0].download).toMatch(/\.mp4$/);
  });

  it('sanitizes the filename segment', async () => {
    const { downloads } = installFakeDom({ canShare: () => false });
    await shareOrSave({
      blob: new Blob([new Uint8Array([1])]),
      mimeType: 'video/webm',
      shortId: '../../etc/passwd',
    });
    expect(downloads[0].download).toBe('oakleague-etcpasswd.webm');
  });

  it('handles missing navigator gracefully (download fallback)', async () => {
    const { downloads } = installFakeDom({ /* no share, no canShare */ });
    const r = await shareOrSave({
      blob: new Blob([new Uint8Array([1])]),
      mimeType: 'video/mp4',
      shortId: 'Q',
    });
    expect(r.kind).toBe('downloaded');
    expect(downloads).toHaveLength(1);
  });

  it('mp4 input yields a File with bare video/mp4 type and .mp4 extension (Android WhatsApp regression 2026-05-08)', async () => {
    // The bug this guards: WhatsApp on Android refuses WebM and refuses MP4
    // files whose `type` carries codec params. We strip the params (via
    // stripCodecParams) and the extension comes from extensionForMime.
    const { sharedWith } = installFakeDom({
      share: () => {},
      canShare: () => true,
    });
    await shareOrSave({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }),
      mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      shortId: 'WHATSAPP',
    });
    expect(sharedWith).toHaveLength(1);
    const file = (sharedWith[0].files ?? [])[0] as File | undefined;
    expect(file).toBeDefined();
    expect(file!.type).toBe('video/mp4'); // bare — no codec params
    expect(file!.name).toBe('oakleague-WHATSAPP.mp4');
  });
});
