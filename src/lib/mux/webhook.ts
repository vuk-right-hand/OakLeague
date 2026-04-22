import 'server-only';
import { muxServer } from './client';

export type MuxEventLite = {
  id: string;          // Mux event.id (webhook idempotency key)
  type: string;        // e.g. 'video.asset.ready'
  payload: unknown;    // raw JSON; matches jsonb column
};

export class MuxWebhookError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'MuxWebhookError';
    this.status = status;
  }
}

// Mux events are typically <10 KiB. Matches the DB CHECK on
// mux_webhook_events.payload (131072 bytes) — keep these in lockstep so
// an oversize event rejects at the HTTP layer, not with a CHECK violation
// inside apply_mux_event (which would 500 and trigger Mux retries).
const MAX_BODY_BYTES = 128 * 1024;

/**
 * Verifies the Mux signature header and returns a minimal event shape.
 * Body cap: 128 KiB. Oversize → 413.
 */
export function verifyAndParse(rawBody: string, signature: string | null): MuxEventLite {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    throw new MuxWebhookError('body too large', 413);
  }
  if (!signature) {
    throw new MuxWebhookError('missing signature', 401);
  }
  const secret = process.env.MUX_WEBHOOK_SECRET;
  if (!secret) {
    throw new MuxWebhookError('webhook secret not configured', 500);
  }

  let event: { type?: unknown; id?: unknown; data?: unknown };
  try {
    // `unwrap` verifies the Mux-Signature header and returns the parsed
    // payload. Throws on mismatch / expired timestamp.
    event = muxServer().webhooks.unwrap(
      rawBody,
      { 'mux-signature': signature },
      secret,
    ) as { type?: unknown; id?: unknown; data?: unknown };
  } catch (err) {
    throw new MuxWebhookError(
      err instanceof Error ? `signature verification failed: ${err.message}` : 'signature verification failed',
      401,
    );
  }

  if (typeof event.type !== 'string' || typeof event.id !== 'string') {
    throw new MuxWebhookError('malformed event payload', 400);
  }

  return {
    id: event.id,
    type: event.type,
    payload: event,
  };
}
