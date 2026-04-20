'use client';

import { useState, useTransition } from 'react';
import { requestMagicLink, startGoogleOAuth } from './actions';

export function LoginForm({ next, error, sent }: { next: string; error?: string; sent: boolean }) {
  const [email, setEmail] = useState('');
  const [pending, startTransition] = useTransition();
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}>
      {sent && <div role="status">Check your email for a magic link.</div>}
      {(error || localError) && (
        <div role="alert" style={{ color: 'salmon' }}>
          {localError ?? humanizeError(error)}
        </div>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setLocalError(null);
          startTransition(async () => {
            const res = await startGoogleOAuth({ next });
            if (res.ok) window.location.href = res.url;
            else setLocalError(res.error);
          });
        }}
      >
        Continue with Google
      </button>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setLocalError(null);
          startTransition(async () => {
            const res = await requestMagicLink({ email, next });
            if (!res.ok) setLocalError(res.error);
            else window.location.href = `/login?sent=1&next=${encodeURIComponent(next)}`;
          });
        }}
      >
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
        />
        <button type="submit" disabled={pending || !email}>
          Send magic link
        </button>
      </form>
    </div>
  );
}

function humanizeError(code: string | undefined): string {
  if (!code) return 'Something went wrong. Try again.';
  if (code === 'exchange_failed') return 'Your link expired. Request a new one.';
  if (code === 'no_code') return 'Link was missing its code. Try again.';
  return 'Sign-in failed. Try again.';
}
