import 'server-only';
import sharp from 'sharp';
import { probeImage } from './image-probe';

// Avatar ingestion for /api/me/avatar (PROFILE_SYSTEM_PLAN U2 / §3.5).
//
// Every upload is re-encoded to a stripped 512px WEBP. This is the security
// boundary the audit (Round-1 §3.5) demands:
//   - probeImage() accepts ONLY JPEG/PNG — SVG (XSS vector), GIF, and anything
//     else return null → bad_format. No SVG ever reaches storage.
//   - sharp re-encodes with NO .withMetadata() call, so EXIF/GPS, ICC color
//     profiles, and embedded thumbnails are dropped (privacy + abuse).
//   - { animated: false } flattens any multi-frame input to a single frame.
//   - .rotate() bakes in EXIF orientation BEFORE the metadata is stripped, so
//     the visible orientation is preserved without keeping the EXIF tag.

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const AVATAR_OUT_DIM = 512;

export type AvatarResult = { webp: Buffer; width: number; height: number };

export class AvatarError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'AvatarError';
  }
}

export async function processAvatar(input: Buffer): Promise<AvatarResult> {
  if (!input || input.length === 0) throw new AvatarError('empty');
  if (input.length > AVATAR_MAX_BYTES) throw new AvatarError('too_large');

  // Magic-byte gate: JPEG/PNG only. Rejects SVG/GIF/HEIC/etc. and bytes that
  // merely claim to be an image.
  const probe = probeImage(input);
  if (!probe) throw new AvatarError('bad_format');

  let out: { data: Buffer; info: sharp.OutputInfo };
  try {
    out = await sharp(input, { failOn: 'error', animated: false })
      .rotate() // apply EXIF orientation, then it's discarded with the rest of the metadata
      .resize(AVATAR_OUT_DIM, AVATAR_OUT_DIM, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AvatarError('decode_failed');
  }

  return { webp: out.data, width: out.info.width, height: out.info.height };
}
