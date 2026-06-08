import { ImageResponse } from 'next/og';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { HANDLE_RE } from '@/lib/profile/handle';

// OG card for /@handle (WS7). TEXT-ONLY by design (audit M3): we never fetch a
// remote/creator-supplied image to composite, so there is no SSRF surface.
// Published-gated (audit M4): only a published creator yields a real card;
// anything else renders a generic OakLeague fallback so we never leak the
// existence of an unpublished/non-public handle. revalidate caches crawler hits
// (blunts the ImageResponse-CPU DoS vector) — no cookies, so it stays cacheable.

export const runtime = 'nodejs';
export const revalidate = 3600;
export const alt = 'OakLeague creator';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BG = '#0a0a0a';
const FG = '#ffffff';
const ACCENT = '#4ad07a';

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
          <div style={{ fontSize: 88, fontWeight: 700, lineHeight: 1.05 }}>{big}</div>
          <div style={{ fontSize: 38, marginTop: 16, color: ACCENT }}>{small}</div>
        </div>
        <div style={{ fontSize: 26, opacity: 0.6 }}>Talk to the people you’d pay to learn from.</div>
      </div>
    ),
    { ...size },
  );
}

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = (raw ?? '').replace(/^@/, '').toLowerCase();

  // Invalid handle or not a published creator → generic fallback (no leak).
  if (!HANDLE_RE.test(handle)) return card('OakLeague', '');

  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creators')
    .select('display_name, handle')
    .eq('handle', handle)
    .not('published_at', 'is', null)
    .maybeSingle<{ display_name: string | null; handle: string }>();

  if (!data) return card('OakLeague', '');
  const big = (data.display_name || `@${data.handle}`).slice(0, 60);
  return card(big, `@${data.handle}`.slice(0, 40));
}
