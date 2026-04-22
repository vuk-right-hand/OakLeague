import 'server-only';
import { muxServer } from './client';

export type DirectUploadInput = {
  passthrough: string;  // bare UUID from DB; Mux echoes on every webhook
  corsOrigin: string;
};

export type DirectUploadResult = {
  uploadId: string;
  uploadUrl: string;
};

/**
 * Mints a Mux direct-upload URL. The browser PUTs the file straight to Mux;
 * the asset is created server-side via webhooks (see apply_mux_event RPC).
 *
 * - mp4_support: 'none'  — HLS-only; avoids per-asset MP4 transcoding fees.
 * - playback_policy: ['public'] — v1 is public. Signed v2 will add 'signed'.
 * - timeout: 3600        — 1h to complete the upload.
 * - passthrough          — bare UUID; do not JSON-encode. Matches DB column.
 */
export async function createDirectUpload(
  input: DirectUploadInput,
): Promise<DirectUploadResult> {
  const mux = muxServer();
  const upload = await mux.video.uploads.create({
    cors_origin: input.corsOrigin,
    timeout: 3600,
    new_asset_settings: {
      playback_policy: ['public'],
      mp4_support: 'none',
      passthrough: input.passthrough,
    },
  });

  if (!upload.id || !upload.url) {
    throw new Error('Mux upload response missing id/url');
  }
  return { uploadId: upload.id, uploadUrl: upload.url };
}

/**
 * Deletes a Mux asset. Used by replaceHookTake to stop storage billing on
 * the previous take before a fresh upload.
 */
export async function deleteMuxAsset(assetId: string): Promise<void> {
  const mux = muxServer();
  await mux.video.assets.delete(assetId);
}
