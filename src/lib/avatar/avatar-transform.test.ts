import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processAvatar, AvatarError, AVATAR_MAX_BYTES, AVATAR_OUT_DIM } from './avatar-transform';

// Real sharp, no mocks — the security guarantees (EXIF strip, SVG rejection,
// resize, format) only matter if the actual encoder does them (audit Round-1 §3.5).

async function makeJpegWithExif(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } },
  })
    .withMetadata({ exif: { IFD0: { Copyright: 'OakLeagueTest', Artist: 'Vuk' } } })
    .jpeg()
    .toBuffer();
}

describe('processAvatar', () => {
  it('re-encodes to 512x512 webp', async () => {
    const out = await processAvatar(await makeJpegWithExif());
    const meta = await sharp(out.webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(AVATAR_OUT_DIM);
    expect(meta.height).toBe(AVATAR_OUT_DIM);
    expect(out.width).toBe(AVATAR_OUT_DIM);
  });

  it('strips EXIF / metadata from the output', async () => {
    const withExif = await makeJpegWithExif();
    // sanity: the input really carries EXIF
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const out = await processAvatar(withExif);
    const meta = await sharp(out.webp).metadata();
    expect(meta.exif).toBeFalsy(); // EXIF/GPS gone
    expect(meta.icc).toBeFalsy(); // ICC profile gone
  });

  it('accepts PNG input', async () => {
    const png = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const out = await processAvatar(png);
    expect((await sharp(out.webp).metadata()).format).toBe('webp');
  });

  it('rejects SVG (XSS vector) as bad_format', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await expect(processAvatar(svg)).rejects.toMatchObject({ code: 'bad_format' });
  });

  it('rejects a non-image blob as bad_format', async () => {
    await expect(processAvatar(Buffer.from('not an image at all, just text bytes here'))).rejects.toMatchObject({
      code: 'bad_format',
    });
  });

  it('rejects empty input', async () => {
    await expect(processAvatar(Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty' });
  });

  it('rejects oversize input before decoding', async () => {
    const huge = Buffer.alloc(AVATAR_MAX_BYTES + 1, 0xff);
    await expect(processAvatar(huge)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('flattens animated input to a single frame (no animation carried over)', async () => {
    // A 2-frame animated WEBP. probeImage rejects WEBP (JPEG/PNG only), so this
    // also documents that animated formats never even reach sharp.
    const frame = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .webp()
      .toBuffer();
    await expect(processAvatar(frame)).rejects.toBeInstanceOf(AvatarError);
  });
});
