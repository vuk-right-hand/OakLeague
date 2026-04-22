'use client';

import { useEffect, useRef, useState } from 'react';
import type { VideoGroup } from './feed-types';
import { HookPanel } from './hook-panel';

type Props = {
  group: VideoGroup;
  index: number;
  isActive: boolean;
};

export function VideoRow({ group, index, isActive }: Props) {
  const [lessonIdx, setLessonIdx] = useState(0);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Arrow-left / arrow-right between lessons within the active row (F5).
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      setLessonIdx((i) => {
        const next = e.key === 'ArrowRight' ? i + 1 : i - 1;
        if (next < 0 || next >= group.items.length) return i;
        const strip = stripRef.current;
        if (strip) {
          const panel = strip.children[next] as HTMLElement | undefined;
          // Audit M4: honor prefers-reduced-motion.
          const reduceMotion =
            typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          panel?.scrollIntoView({
            behavior: reduceMotion ? 'auto' : 'smooth',
            inline: 'start',
            block: 'nearest',
          });
        }
        return next;
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, group.items.length]);

  // Observe which lesson is centered in the horizontal strip.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.9) {
            const idx = Number((e.target as HTMLElement).dataset.lessonIndex);
            if (!Number.isNaN(idx)) setLessonIdx(idx);
          }
        }
      },
      { root: strip, threshold: [0.9] },
    );
    for (const p of Array.from(strip.querySelectorAll('[data-lesson-panel]'))) obs.observe(p);
    return () => obs.disconnect();
  }, [group.items.length]);

  return (
    <section
      data-video-row
      data-video-index={index}
      style={{
        scrollSnapAlign: 'start',
        scrollSnapStop: 'normal',
        height: '100vh',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ height: '100svh' } as any),
        width: '100vw',
        position: 'relative',
      }}
    >
      <div
        ref={stripRef}
        style={{
          display: 'flex',
          flexDirection: 'row',
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollSnapType: 'x mandatory',
          height: '100%',
          width: '100%',
        }}
      >
        {group.items.map((hook, i) => {
          // Mount MuxPlayer only for the active +/- 1 window to save memory.
          const distance = Math.abs(i - lessonIdx);
          const shouldMount = isActive && distance <= 1;
          const shouldPlay = isActive && i === lessonIdx;
          return (
            <div
              key={hook.hook_id}
              data-lesson-panel
              data-lesson-index={i}
              style={{
                flex: '0 0 100vw',
                width: '100vw',
                height: '100%',
                scrollSnapAlign: 'start',
                scrollSnapStop: 'normal',
              }}
            >
              <HookPanel
                hook={hook}
                group={group}
                shouldMount={shouldMount}
                shouldPlay={shouldPlay}
                lessonIndex={i}
                totalLessons={group.items.length}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
