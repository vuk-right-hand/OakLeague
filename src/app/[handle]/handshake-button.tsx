'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { handshakeAction, unhandshakeAction } from '@/lib/profile/handshake-actions';

// Audit M6/C1: a logged-out tap sends the user to /login?next=/@handle?action=handshake.
// The intent is NOT executed on the GET render (CSRF surface) — instead the page
// passes autoFire and we fire the CSRF-protected server action once here, then
// strip the param from the URL so a reload/prefetch can't replay it.

export function HandshakeButton({
  handle,
  initialHandshaked,
  isAuthenticated,
  autoFire = false,
}: {
  handle: string;
  initialHandshaked: boolean;
  isAuthenticated: boolean;
  autoFire?: boolean;
}) {
  const [on, setOn] = useState(initialHandshaked);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const firedAuto = useRef(false);

  const run = (next: boolean) => {
    setErr(null);
    setOn(next); // optimistic; never router.push (CLAUDE.md)
    startTransition(async () => {
      const res = next ? await handshakeAction({ handle }) : await unhandshakeAction({ handle });
      if (!res.ok) {
        setOn(!next); // revert
        setErr(res.error === 'rate_limited' ? 'Slow down a moment.' : 'Something went wrong.');
      }
    });
  };

  // Consume a deferred login-hop intent exactly once. Strip ?action ONLY after
  // the write lands (audit M-D2) — stripping early would lose the intent if the
  // action fails, silently dropping the follow the user logged in to make.
  // Deps are [autoFire] only: the firedAuto ref + the `on` guard are the real
  // once-guard (survives React strict-mode double-invoke); do not "fix" the lint.
  useEffect(() => {
    if (!autoFire || firedAuto.current || on) return;
    firedAuto.current = true;
    setOn(true); // optimistic
    startTransition(async () => {
      const res = await handshakeAction({ handle });
      if (res.ok) {
        if (typeof window !== 'undefined') window.history.replaceState(null, '', `/@${handle}`);
      } else {
        setOn(false);
        setErr(res.error === 'rate_limited' ? 'Slow down a moment.' : 'Could not complete that — tap to retry.');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFire]);

  if (!isAuthenticated) {
    const next = encodeURIComponent(`/@${handle}?action=handshake`);
    return (
      <a className="oak-handshake-btn" href={`/login?next=${next}`} data-on="false">
        🤝 Handshake
      </a>
    );
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <button className="oak-handshake-btn" onClick={() => run(!on)} disabled={pending} data-on={on}>
        {on ? '🤝 Handshaked' : '🤝 Handshake'}
      </button>
      {err ? <span className="oak-err" role="alert">{err}</span> : null}
    </span>
  );
}
