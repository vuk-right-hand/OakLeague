import { ImageResponse } from 'next/og';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

// OG card for /v/[id] (WS7). TEXT-ONLY (audit M3 — no remote image fetch, no
// SSRF). Published + long-form-ready gated (audit M4) — same gates as the page,
// so an unpublished/pending video renders a generic fallback, never leaking its
// title. Cacheable (no cookies; revalidate) to blunt the ImageResponse DoS.

export const runtime = 'nodejs';
export const revalidate = 3600;
export const alt = 'OakLeague';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BG = '#0a0a0a';
const FG = '#ffffff';
const ACCENT = '#4ad07a';

const uuid = z.string().uuid();

function card(big: string, small: string) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: BG,
          color: FG,
          padding: 80,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 28, letterSpacing: 1, opacity: 0.7 }}>OAKLEAGUE</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.08 }}>{big}</div>
          {small ? <div style={{ fontSize: 38, marginTop: 16, color: ACCENT }}>{small}</div> : null}
        </div>
        <div style={{ fontSize: 26, opacity: 0.6 }}>Watch, then ask the creator’s AI avatar anything.</div>
      </div>
    ),
    { ...size },
  );
}

// Keep card text bounded so a long title can't blow out the layout.
function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) return card('OakLeague', '');

  const sb = supabaseAdmin();
  const { data: video } = await sb
    .from('videos')
    .select('title, creator_id')
    .eq('id', id)
    .not('published_at', 'is', null)
    .not('long_form_published_at', 'is', null)
    .eq('long_form_mux_status', 'ready')
    .maybeSingle<{ title: string; creator_id: string }>();

  if (!video) return card('OakLeague', '');

  const { data: creator } = await sb
    .from('creators')
    .select('display_name, handle')
    .eq('id', video.creator_id)
    .maybeSingle<{ display_name: string | null; handle: string }>();

  const who = clamp(creator ? creator.display_name || `@${creator.handle}` : 'OakLeague', 60);
  return card(clamp(video.title, 80), who);
}
