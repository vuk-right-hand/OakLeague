'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedCursor, FeedItem, VideoGroup, WelcomeHook } from './feed-types';
import { groupByVideo } from './feed-types';
import { VideoRow } from './video-row';
import { WelcomeOverlay } from './welcome-overlay';

type Props = {
  initialItems: FeedItem[];
  initialCursor: FeedCursor | null;
  initialHasMore: boolean;
  welcome: WelcomeHook | null;
};

export function FeedContainer({ initialItems, initialCursor, initialHasMore, welcome }: Props) {
  const [items, setItems] = useState<FeedItem[]>(initialItems);
  const [cursor, setCursor] = useState<FeedCursor | null>(initialCursor);
  const [hasMore, setHasMore] = useState<boolean>(initialHasMore);
  const [activeIdx, setActiveIdx] = useState(0);
  // Welcome open: lifted into FeedContainer so arrow-key nav can ignore
  // input while the overlay is showing (audit M3).
  const [welcomeOpen, setWelcomeOpen] = useState<boolean>(!!welcome);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const groups = useMemo<VideoGroup[]>(() => groupByVideo(items), [items]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore || !cursor) return;
    loadingRef.current = true;
    try {
      const res = await fetch(
        `/api/feed?cursor_created_at=${encodeURIComponent(cursor.cursor_created_at)}&cursor_id=${encodeURIComponent(cursor.cursor_id)}&limit=10`,
        { cache: 'no-store' },
      );
      // Audit M2: a transient 429 or 5xx must NOT permanently disable
      // load-more. We keep cursor + hasMore intact so the next scroll
      // re-attempts; hasMore only flips to false on a clean 2xx with
      // nextCursor === null.
      if (!res.ok) return;
      const json = (await res.json()) as {
        items: FeedItem[];
        nextCursor: FeedCursor | null;
      };
      setItems((prev) => [...prev, ...json.items]);
      if (json.nextCursor) {
        setCursor(json.nextCursor);
      } else {
        setHasMore(false);
      }
    } finally {
      loadingRef.current = false;
    }
  }, [cursor, hasMore]);

  // IntersectionObserver on each video row to track the active panel.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('[data-video-row]'));
    if (rows.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.9) {
            const idx = Number((entry.target as HTMLElement).dataset.videoIndex);
            if (!Number.isNaN(idx)) setActiveIdx(idx);
          }
        }
      },
      { root: container, threshold: [0.9] },
    );

    for (const row of rows) observer.observe(row);
    return () => observer.disconnect();
  }, [groups.length]);

  // Load-more when we're within 2 rows of the end.
  useEffect(() => {
    if (groups.length === 0) return;
    if (activeIdx >= groups.length - 2) loadMore();
  }, [activeIdx, groups.length, loadMore]);

  // Arrow-up / arrow-down between vertical panels (desktop keyboard nav, F5).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Audit M3: welcome overlay sits on z-50, full-screen; arrow keys
      // shouldn't scroll the feed underneath while it's visible.
      if (welcomeOpen) return;
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? activeIdx + 1 : activeIdx - 1;
      const target = container.querySelector<HTMLElement>(
        `[data-video-row][data-video-index="${next}"]`,
      );
      if (target) {
        // Audit M4: honor prefers-reduced-motion.
        const reduceMotion =
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({
          behavior: reduceMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeIdx, welcomeOpen]);

  if (groups.length === 0) {
    return (
      <main style={{ height: '100svh', display: 'grid', placeItems: 'center', color: '#eee', background: '#000' }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>No hooks yet.</h1>
          <p style={{ opacity: 0.7 }}>Content is uploading. Check back soon.</p>
        </div>
      </main>
    );
  }

  return (
    <>
      {welcome && (
        <WelcomeOverlay
          welcome={welcome}
          onVisibilityChange={setWelcomeOpen}
        />
      )}
      <div
        ref={scrollRef}
        style={{
          height: '100vh',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...({ height: '100svh' } as any),
          width: '100vw',
          overflowY: 'auto',
          overflowX: 'hidden',
          scrollSnapType: 'y mandatory',
          background: '#000',
          color: '#fff',
        }}
      >
        {groups.map((g, i) => (
          <VideoRow
            key={g.videoId}
            group={g}
            index={i}
            isActive={i === activeIdx}
          />
        ))}
      </div>
    </>
  );
}
