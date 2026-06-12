'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { submitCreatorRequest } from './actions';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void }) => string;
      reset: (id?: string) => void;
    };
  }
}

export function RequestForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pitch, setPitch] = useState('');
  const [youtube, setYoutube] = useState('');
  const [twitter, setTwitter] = useState('');
  const [instagram, setInstagram] = useState('');
  const [tiktok, setTiktok] = useState('');
  const [website, setWebsite] = useState('');
  const [otherLinks, setOtherLinks] = useState<string[]>(['']);

  const [token, setToken] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey || !widgetRef.current || widgetId.current) return;
    const mount = () => {
      if (!window.turnstile || !widgetRef.current) return;
      widgetId.current = window.turnstile.render(widgetRef.current, {
        sitekey: siteKey,
        callback: (t) => setToken(t),
      });
    };
    if (window.turnstile) mount();
    else {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      s.onload = mount;
      document.head.appendChild(s);
    }
  }, [siteKey]);

  if (done) {
    return (
      <div role="status" style={{ marginTop: 24, lineHeight: 1.5 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>Request received</h2>
        <p style={{ opacity: 0.7, marginTop: 8 }}>
          Thanks — we’ll review it and email you if it’s a fit. No action needed right now.
        </p>
      </div>
    );
  }

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        if (siteKey && !token) {
          setErr('Please complete the captcha.');
          return;
        }
        const other_links = otherLinks.map((l) => l.trim()).filter(Boolean);
        const proof = {
          youtube_url: youtube.trim() || undefined,
          twitter_url: twitter.trim() || undefined,
          instagram_url: instagram.trim() || undefined,
          tiktok_url: tiktok.trim() || undefined,
          website: website.trim() || undefined,
          other_links: other_links.length > 0 ? other_links : undefined,
        };
        startTransition(async () => {
          const res = await submitCreatorRequest({
            email,
            name,
            pitch,
            proof,
            turnstile_token: token,
          });
          if (!res.ok) {
            setErr(humanize(res.error));
            window.turnstile?.reset(widgetId.current ?? undefined);
            setToken('');
          } else setDone(true);
        });
      }}
    >
      <label>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
        />
      </label>

      <label>
        Your name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={pending} />
      </label>

      <label>
        What do you teach / who are you? (optional)
        <textarea
          value={pitch}
          onChange={(e) => setPitch(e.target.value)}
          maxLength={2000}
          rows={4}
          disabled={pending}
        />
      </label>

      <fieldset style={{ border: '1px solid #333', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <legend>Proof (optional — paste any that apply)</legend>
        <label>
          YouTube
          <input type="url" value={youtube} onChange={(e) => setYoutube(e.target.value)} disabled={pending} />
        </label>
        <label>
          Twitter / X
          <input type="url" value={twitter} onChange={(e) => setTwitter(e.target.value)} disabled={pending} />
        </label>
        <label>
          Instagram
          <input type="url" value={instagram} onChange={(e) => setInstagram(e.target.value)} disabled={pending} />
        </label>
        <label>
          TikTok
          <input type="url" value={tiktok} onChange={(e) => setTiktok(e.target.value)} disabled={pending} />
        </label>
        <label>
          Website
          <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} disabled={pending} />
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, opacity: 0.7 }}>Other links — sessions, books, docs, podcasts…</span>
          {otherLinks.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <input
                type="url"
                placeholder="https://…"
                value={l}
                onChange={(e) => setOtherLinks(otherLinks.map((x, j) => (i === j ? e.target.value : x)))}
                disabled={pending}
                style={{ flex: 1 }}
              />
              {otherLinks.length > 1 && (
                <button type="button" onClick={() => setOtherLinks(otherLinks.filter((_, j) => j !== i))} disabled={pending}>
                  ×
                </button>
              )}
            </div>
          ))}
          {otherLinks.length < 10 && (
            <button type="button" onClick={() => setOtherLinks([...otherLinks, ''])} disabled={pending} style={{ alignSelf: 'flex-start' }}>
              + Add link
            </button>
          )}
        </div>
      </fieldset>

      <div ref={widgetRef} />
      <button type="submit" disabled={pending || !email}>
        {pending ? 'Submitting…' : 'Submit request'}
      </button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </form>
  );
}

function humanize(code: string): string {
  switch (code) {
    case 'rate_limited':
      return 'Too many requests. Try again in a bit.';
    case 'captcha_failed':
      return 'Captcha failed. Try again.';
    case 'invalid_input':
      return 'Please check your email and links (links must start with http:// or https://).';
    default:
      return 'Something went wrong. Try again.';
  }
}
