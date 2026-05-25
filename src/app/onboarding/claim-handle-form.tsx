'use client';

import { useState, useTransition } from 'react';
import { saveProfile } from '@/lib/profile/profile-actions';

// Lazy handle claim (PROFILE_SYSTEM_PLAN U3 / audit C3). Reached from the "You"
// tab when a user has no handle yet. On success we full-navigate to the new
// public profile (window.location, never router.push — CLAUDE.md).

export function ClaimHandleForm() {
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const h = handle.trim().toLowerCase();
    startTransition(async () => {
      const res = await saveProfile({ handle: h, display_name: name.trim() || undefined });
      if (!res.ok) {
        if (res.error === 'edit_in_studio') {
          // Shouldn't reach here (the page redirects creators to Studio), but
          // never leave a raw code on screen — send them where they belong.
          window.location.href = '/creator';
          return;
        }
        setErr(res.error === 'handle_taken' ? 'That handle is taken.' : 'Could not claim that handle.');
        return;
      }
      window.location.href = `/@${h}`;
    });
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Display name (optional)
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={pending} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Handle
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ opacity: 0.6 }}>@</span>
          <input
            value={handle}
            maxLength={30}
            placeholder="yourname"
            onChange={(e) => setHandle(e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase())}
            disabled={pending}
            style={{ flex: 1 }}
          />
        </div>
      </label>
      {err ? <div className="oak-err" role="alert">{err}</div> : null}
      <button className="oak-btn-primary" type="submit" disabled={pending || handle.trim().length < 3}>
        {pending ? 'Claiming…' : 'Claim handle'}
      </button>
    </form>
  );
}
