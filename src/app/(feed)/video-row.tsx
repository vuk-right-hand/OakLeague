'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoGroup } from './feed-types';
import { HookPanel } from './hook-panel';
import { recordFeedEvent } from '@/lib/feed/client-events';
import { useFeedImpressionTracker } from './feed-impression-context';

type Props = {
  group: VideoGroup;
  index: number;
  isActive: boolean;
};

export function VideoRow({ group, index, isActive }: Props) {
  const [lessonIdx, setLessonIdx] = useState(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tracker = useFeedImpressionTracker();
  const lastLessonIdxRef = useRef<number>(0);

  // D5: emit hook_swipe for the OUTGOING lesson when horizontal nav happens.
  // Direction is from the user's swipe gesture, not the hook's identity:
  // tapping ArrowRight (or swiping right-to-left to reveal the next lesson)
  // is `direction='right'`, matching the swipe_direction enum (migration
  // 0503-01) and what compute_event_weight rewards as +0.5.
  const emitHorizontalSwipe = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (fromIdx === toIdx) return;
      const fromHook = group.items[fromIdx];
      if (!fromHook) return;
      const direction: 'left' | 'right' = toIdx > fromIdx ? 'right' : 'left';
      const ms = tracker.peekActivation(fromHook.hook_id);
      const completionPct = tracker.getCompletion(fromHook.hook_id);
      recordFeedEvent({
        event_name: 'hook_swipe',
        hook_id: fromHook.hook_id,
        video_id: fromHook.video_id,
        creator_id: fromHook.creator_id,
        payload: {
          direction,
          // ms === null means we never saw activation for this hook (e.g.,
          // user scrolled too fast for the impression effect to land).
          // Omit rather than emit -1 / 0 — the rollup's dead-zone branch
          // keys off `< 500` and would mis-classify.
          ...(ms !== null ? { seconds_to_decision_ms: ms } : {}),
          completion_pct: Number(completionPct.toFixed(3)),
          lesson_number: fromHook.lesson_number,
        },
      });
    },
    [group.items, tracker],
  );

  const setLessonIdxAndEmit = useCallback(
    (next: number) => {
      const prev = lastLessonIdxRef.current;
      if (next === prev) return;
      emitHorizontalSwipe(prev, next);
      lastLessonIdxRef.current = next;
      setLessonIdx(next);
      const nextHook = group.items[next];
      if (nextHook) {
        tracker.setActiveLesson(group.videoId, nextHook.hook_id);
      }
    },
    [emitHorizontalSwipe, group.items, group.videoId, tracker],
  );

  // Seed active-lesson on mount so a vertical swipe before the user touches
  // this row still has a hook_id to attribute (lesson 0).
  useEffect(() => {
    const first = group.items[0];
    if (first) tracker.setActiveLesson(group.videoId, first.hook_id);
  }, [group.items, group.videoId, tracker]);

  // Arrow-left / arrow-right between lessons within the active row (F5).
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = lastLessonIdxRef.current;
      const next = e.key === 'ArrowRight' ? i + 1 : i - 1;
      if (next < 0 || next >= group.items.length) return;
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
      // The IntersectionObserver below will eventually fire setLessonIdxAndEmit
      // once the snap settles, but we also call it directly so the swipe event
      // emits immediately on keypress (instant feedback for the rollup).
      setLessonIdxAndEmit(next);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, group.items.length, setLessonIdxAndEmit]);

  // Observe which lesson is centered in the horizontal strip (touch swipes
  // hit this path; keyboard nav hits the handler above and this confirms).
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.9) {
            const idx = Number((e.target as HTMLElement).dataset.lessonIndex);
            if (!Number.isNaN(idx)) setLessonIdxAndEmit(idx);
          }
        }
      },
      { root: strip, threshold: [0.9] },
    );
    for (const p of Array.from(strip.querySelectorAll('[data-lesson-panel]'))) obs.observe(p);
    return () => obs.disconnect();
  }, [group.items.length, setLessonIdxAndEmit]);

  return (
    <section
      data-video-row
      data-video-index={index}
      style={{
        scrollSnapAlign: 'start',
        scrollSnapStop: 'always',
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
                scrollSnapStop: 'always',
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

      {/* Horizontal lesson chevrons. Desktop affordance for what touch
          users get for free via swipe. Only render on multi-lesson rows
          and only when this row is the active one. zIndex: 3 puts them
          above the click-capture overlay (zIndex: 1) and the Ask button
          (zIndex: 2). e.stopPropagation prevents the click from also
          firing the unmute/play-pause handler underneath. */}
      {isActive && group.items.length > 1 && lessonIdx > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLessonIdxAndEmit(lessonIdx - 1);
            const strip = stripRef.current;
            const panel = strip?.children[lessonIdx - 1] as HTMLElement | undefined;
            const reduceMotion =
              typeof window !== 'undefined' &&
              window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            panel?.scrollIntoView({
              behavior: reduceMotion ? 'auto' : 'smooth',
              inline: 'start',
              block: 'nearest',
            });
          }}
          aria-label="Previous lesson"
          style={chevronStyle('left')}
        >
          ‹
        </button>
      )}
      {isActive && group.items.length > 1 && lessonIdx < group.items.length - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLessonIdxAndEmit(lessonIdx + 1);
            const strip = stripRef.current;
            const panel = strip?.children[lessonIdx + 1] as HTMLElement | undefined;
            const reduceMotion =
              typeof window !== 'undefined' &&
              window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            panel?.scrollIntoView({
              behavior: reduceMotion ? 'auto' : 'smooth',
              inline: 'start',
              block: 'nearest',
            });
          }}
          aria-label="Next lesson"
          style={chevronStyle('right')}
        >
          ›
        </button>
      )}
    </section>
  );
}

function chevronStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    [side]: 16,
    top: '50%',
    transform: 'translateY(-50%)',
    width: 44,
    height: 44,
    borderRadius: 22,
    background: 'rgba(0,0,0,0.45)',
    border: '1px solid rgba(255,255,255,0.25)',
    color: '#fff',
    fontSize: 28,
    lineHeight: '40px',
    fontWeight: 400,
    cursor: 'pointer',
    zIndex: 3,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
