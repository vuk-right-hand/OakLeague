'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { joinWaitlist } from './waitlist-actions';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void }) => string;
      reset: (id?: string) => void;
    };
  }
}

export function WaitlistForm() {
  const [email, setEmail] = useState('');
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
    return <div role="status">You&apos;re on the list. We&apos;ll be in touch.</div>;
  }

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        if (siteKey && !token) {
          setErr('Please complete the captcha.');
          return;
        }
        startTransition(async () => {
          const res = await joinWaitlist({ email, turnstile_token: token });
          if (!res.ok) {
            setErr(humanize(res.error));
            window.turnstile?.reset(widgetId.current ?? undefined);
            setToken('');
          } else setDone(true);
        });
      }}
    >
      <input
        type="email"
        required
        placeholder="you@domain.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={pending}
      />
      <div ref={widgetRef} />
      <button type="submit" disabled={pending || !email}>Join waitlist</button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </form>
  );
}

function humanize(code: string): string {
  if (code === 'rate_limited') return 'Too many requests. Try again in an hour.';
  if (code === 'captcha_failed') return 'Captcha failed. Try again.';
  if (code === 'invalid_input') return 'Please enter a valid email.';
  return 'Something went wrong.';
}
