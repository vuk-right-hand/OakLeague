import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { verifyAndParse, MuxWebhookError } from '@/lib/mux/webhook';
import { logMuxCogs } from '@/lib/mux/costs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get('mux-signature');

  let event;
  try {
    event = verifyAndParse(rawBody, signature);
  } catch (err) {
    if (err instanceof MuxWebhookError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const admin = supabaseAdmin();
  const { error } = await admin.rpc('apply_mux_event', {
    p_event_id: event.id,
    p_type: event.type,
    p_payload: event.payload,
  });

  if (error) {
    // Return 500 so Mux retries. apply_mux_event is idempotent via PK on event_id.
    console.error('[mux.webhook] apply_mux_event failed', error);
    return NextResponse.json({ error: 'dispatch failed' }, { status: 500 });
  }

  // COGS logging on asset-ready only. We intentionally do NOT throw from
  // logMuxCogs — Mux must receive a 200 to stop retrying.
  if (event.type === 'video.asset.ready') {
    const payload = event.payload as { data?: { duration?: number; id?: string; passthrough?: string } };
    const durationMs = payload.data?.duration != null
      ? Math.round(payload.data.duration * 1000)
      : 0;
    if (durationMs > 0) {
      await logMuxCogs({
        operation: 'asset.ready',
        durationMs,
        assetId: payload.data?.id,
        passthrough: payload.data?.passthrough,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
