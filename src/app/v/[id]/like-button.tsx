'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { likeAction, unlikeAction } from '@/lib/video/like-actions';

// Like button (COMMENTS_LIKES_PLAN L2). Same intent-safe pattern as the
// handshake button: logged-out → /login?next=/v/[id]?action=like; the page
// passes autoFire and we fire the CSRF-protected action once, strip the param
// only on success. No GET-mutation.

export function LikeButton({
  videoId,
  initialLiked,
  initialCount,
  isAuthenticated,
  autoFire = false,
}: {
  videoId: string;
  initialLiked: boolean;
  initialCount: number;
  isAuthenticated: boolean;
  autoFire?: boolean;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [pending, startTransition] = useTransition();
  const fired = useRef(false);

  const run = (next: boolean) => {
    setLiked(next);
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    startTransition(async () => {
      const res = next ? await likeAction({ video_id: videoId }) : await unlikeAction({ video_id: videoId });
      if (!res.ok) {
        setLiked(!next);
        setCount((c) => Math.max(0, c + (next ? -1 : 1)));
      }
    });
  };

  // Consume the login-hop intent exactly once: a single optimistic like, then
  // strip ?action ONLY on success (audit M-D2 from the profile build).
  useEffect(() => {
    if (!autoFire || fired.current || liked) return;
    fired.current = true;
    setLiked(true);
    setCount((c) => c + 1);
    startTransition(async () => {
      const res = await likeAction({ video_id: videoId });
      if (res.ok) {
        if (typeof window !== 'undefined') {
          // Strip only ?action, preserve ?from (hook attribution) etc. (audit M6).
          const url = new URL(window.location.href);
          url.searchParams.delete('action');
          window.history.replaceState(null, '', url.pathname + url.search);
        }
      } else {
        setLiked(false);
        setCount((c) => Math.max(0, c - 1));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFire]);

  if (!isAuthenticated) {
    const next = encodeURIComponent(`/v/${videoId}?action=like`);
    return (
      <a className="oak-like-btn" href={`/login?next=${next}`} data-on="false">
        ♥ {count}
      </a>
    );
  }

  return (
    <button className="oak-like-btn" onClick={() => run(!liked)} disabled={pending} data-on={liked} aria-pressed={liked}>
      ♥ {count}
    </button>
  );
}
