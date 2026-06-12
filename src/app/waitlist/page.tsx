// /waitlist — public landing for YC S26 window.
//
// Sections: hero, demo loop (Mux), waitlist form, FAQ, creator CTA.
// Server component for the shell; form + Mux player are client islands.
//
// Demo asset: fetched from `welcome_hooks_public` — the first published
// welcome hook with a Mux playback id. Absent → demo-loop renders a static
// placeholder. Demo clip is capped at 720p (R4-S3) until Mux Data/COGS
// rollup lands (2026-05-10).

import 'server-only';
import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import { WaitlistForm } from './waitlist-form';
import { DemoLoop } from './demo-loop';
import { FAQ } from './faq';

export const dynamic = 'force-dynamic';

type WelcomeClip = {
  mux_playback_id: string;
  mux_aspect_ratio: string | null;
};

async function loadDemo(): Promise<WelcomeClip | null> {
  const sb = await supabaseServer();
  const { data } = await sb
    .from('welcome_hooks_public')
    .select('mux_playback_id, mux_aspect_ratio')
    .limit(1)
    .maybeSingle<WelcomeClip>();
  return data ?? null;
}

export default async function WaitlistPage() {
  const demo = await loadDemo();

  return (
    <main
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: '40px 20px 80px',
        color: '#fff',
        background: '#000',
        minHeight: '100vh',
      }}
    >
      {/* Top bar — creator link stays low-contrast */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 32,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>OakLeague</div>
        <Link
          href="/login?next=/creator"
          style={{ fontSize: 12, opacity: 0.55, color: '#fff', textDecoration: 'none' }}
        >
          Creator portal →
        </Link>
      </div>

      {/* Hero + demo side-by-side on desktop, stacked on mobile */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 40,
          alignItems: 'center',
          marginTop: 24,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 'clamp(32px, 6vw, 56px)',
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -0.5,
            }}
          >
            Talk to the people you&apos;d pay $10K/mo to sit across from.
          </h1>
          <p
            style={{
              fontSize: 'clamp(16px, 2vw, 19px)',
              opacity: 0.78,
              marginTop: 18,
              lineHeight: 1.45,
              maxWidth: 560,
            }}
          >
            Interactive video mentorship. Scroll short hooks, tap one, and have a real
            conversation with the creator&apos;s AI avatar — trained on their books,
            interviews, and frameworks.
          </p>
          <div style={{ marginTop: 28 }}>
            <WaitlistForm />
          </div>
          <p style={{ marginTop: 16, fontSize: 12, opacity: 0.55 }}>
            Private beta now. Public launch summer 2026.
          </p>
        </div>

        <div
          style={{
            justifySelf: 'center',
            width: '100%',
            maxWidth: 360,
          }}
        >
          <DemoLoop
            playbackId={demo?.mux_playback_id ?? null}
            aspectRatio={demo?.mux_aspect_ratio ?? null}
          />
        </div>
      </section>

      {/* How it works */}
      <section style={{ marginTop: 72 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 22 }}>How it works</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 18,
          }}
        >
          {[
            { n: '1', t: 'Scroll', d: 'Short hooks from operators, coaches, founders. 9:16, muted, instant.' },
            { n: '2', t: 'Tap Ask', d: 'Hit the mic on any hook that matters. The avatar loads in under five seconds.' },
            { n: '3', t: 'Speak', d: 'Ask anything. Interrupt. Push back. It answers like the person you’re watching.' },
          ].map((s) => (
            <div
              key={s.n}
              style={{
                padding: 20,
                borderRadius: 14,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 6 }}>0{s.n}</div>
              <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>{s.t}</div>
              <div style={{ fontSize: 14, opacity: 0.72, lineHeight: 1.5 }}>{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      <FAQ />

      {/* Creator CTA */}
      <section
        style={{
          marginTop: 64,
          padding: '28px 24px',
          borderRadius: 16,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
          Are you a creator?
        </div>
        <div style={{ fontSize: 14, opacity: 0.74, marginBottom: 16 }}>
          We&apos;re invite-only for v1. If you have published content and an audience,
          request a spot — we review every one by hand.
        </div>
        <Link
          href="/request"
          style={{
            display: 'inline-block',
            background: '#fff',
            color: '#000',
            padding: '10px 20px',
            borderRadius: 24,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Request to become a creator
        </Link>
      </section>

      <footer style={{ marginTop: 64, fontSize: 12, opacity: 0.5, textAlign: 'center' }}>
        &copy; {new Date().getFullYear()} OakLeague. YC S26 applicant.
      </footer>
    </main>
  );
}
