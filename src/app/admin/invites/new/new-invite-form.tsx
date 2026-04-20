'use client';

import { useState, useTransition } from 'react';
import { mintCreatorInvite } from '../actions';

export function NewInviteForm() {
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [result, setResult] = useState<{ url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        setResult(null);
        startTransition(async () => {
          const res = await mintCreatorInvite({ email, notes, expires_in_days: expiresInDays });
          if (!res.ok) setErr(res.error);
          else setResult({ url: res.url });
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
        Notes (optional)
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          rows={3}
          disabled={pending}
        />
      </label>
      <label>
        Expires in (days)
        <input
          type="number"
          min={1}
          max={7}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(Number(e.target.value))}
          disabled={pending}
        />
      </label>
      <button type="submit" disabled={pending || !email}>
        Mint & send
      </button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
      {result && (
        <div style={{ background: '#111', padding: 12, borderRadius: 6, wordBreak: 'break-all' }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Copy-fallback URL (shown once):</div>
          <code>{result.url}</code>
        </div>
      )}
    </form>
  );
}
