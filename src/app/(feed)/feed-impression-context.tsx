'use client';

import { createContext, useCallback, useContext, useMemo, useRef } from 'react';

// Per-FeedContainer behavioral tracker.
//
// Two responsibilities:
//   1. (N1) hook_impression dedupe — guard against React reconciliation
//      remounting a HookPanel mid-scroll and re-firing the impression with
//      a fresh idempotency_key (which the ingest RPC's UNIQUE constraint
//      would happily accept, polluting hook_global_stats.impressions).
//
//   2. (D5) Activation-time tracking — `markActivated` on shouldPlay=true,
//      `peekActivation` on swipe-away. The elapsed ms feeds the
//      hook_swipe payload's `seconds_to_decision_ms`, which the rollup
//      trigger (compute_event_weight) reads to flag dead-zone swipes
//      (<500ms) as -0.3 instead of the default -0.05.
//
// Both maps reset on FeedContainer unmount so a genuine return visit still
// counts as a new impression / new activation.

type ImpressionTracker = {
  markIfNew: (hookId: string) => boolean;
  markActivated: (hookId: string) => void;
  // Returns elapsed ms since markActivated, or null if never activated.
  // M3: peek semantics — does NOT delete the entry. Multiple swipe events
  // (e.g., a horizontal then a vertical away from the same lesson) can
  // safely both consult the same activation timestamp.
  peekActivation: (hookId: string) => number | null;
  // D5: per-video-group active-lesson tracking. VideoRow updates as the
  // user swipes between lessons; FeedContainer reads this when a vertical
  // swipe deactivates a row, so the hook_swipe payload can target the
  // lesson the user was actually watching (its topics/creator) rather
  // than always blaming items[0].
  setActiveLesson: (videoId: string, hookId: string) => void;
  getActiveLesson: (videoId: string) => string | null;
  // D5 M1: most recent completion_pct per hook, written by HookPanel's
  // onTimeUpdate. VideoRow + FeedContainer read this when emitting
  // hook_swipe so the dead-zone classifier in compute_event_weight has the
  // signal it needs (without it, every fast swipe is mis-classified as
  // dead-zone -0.3 even when the user watched 90% of the lesson).
  recordCompletion: (hookId: string, pct: number) => void;
  getCompletion: (hookId: string) => number;
};

const noopTracker: ImpressionTracker = {
  markIfNew: () => true,
  markActivated: () => {},
  peekActivation: () => null,
  setActiveLesson: () => {},
  getActiveLesson: () => null,
  recordCompletion: () => {},
  getCompletion: () => 0,
};

const FeedImpressionContext = createContext<ImpressionTracker>(noopTracker);

export function FeedImpressionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Audit P2-A: cap each tracker at MAX_ENTRIES with FIFO eviction.
  // Without this, an infinite-scroll session accumulates one entry per
  // hook ever seen; the maps grow unbounded. Insertion order preserves
  // recency naturally (Map/Set both maintain insertion order in JS).
  const MAX_ENTRIES = 500;
  const impressionsRef = useRef<Set<string>>(new Set());
  const activationsRef = useRef<Map<string, number>>(new Map());
  const activeLessonRef = useRef<Map<string, string>>(new Map());
  const completionRef = useRef<Map<string, number>>(new Map());

  const evictIfFull = <T,>(coll: Set<T> | Map<T, unknown>) => {
    if (coll.size <= MAX_ENTRIES) return;
    // Oldest entry first via the iterator (insertion order).
    const oldest = coll.keys().next().value as T | undefined;
    if (oldest !== undefined) coll.delete(oldest);
  };

  const markIfNew = useCallback((hookId: string) => {
    if (impressionsRef.current.has(hookId)) return false;
    impressionsRef.current.add(hookId);
    evictIfFull(impressionsRef.current);
    return true;
  }, []);

  const markActivated = useCallback((hookId: string) => {
    activationsRef.current.set(hookId, Date.now());
    evictIfFull(activationsRef.current);
  }, []);

  const peekActivation = useCallback((hookId: string) => {
    const start = activationsRef.current.get(hookId);
    if (start === undefined) return null;
    return Date.now() - start;
  }, []);

  const setActiveLesson = useCallback((videoId: string, hookId: string) => {
    activeLessonRef.current.set(videoId, hookId);
    evictIfFull(activeLessonRef.current);
  }, []);

  const getActiveLesson = useCallback((videoId: string) => {
    return activeLessonRef.current.get(videoId) ?? null;
  }, []);

  const recordCompletion = useCallback((hookId: string, pct: number) => {
    // Store the RAW value, not clamped. Loop replays produce >1.0 which is
    // a strong satisfaction signal (audit P1-A). The DB-side
    // compute_event_weight clamps once at the rollup boundary; clamping
    // here too drops the signal from hook_swipe payloads (which read this
    // value and pipe it to the rollup) without any benefit.
    if (Number.isFinite(pct) && pct >= 0) {
      completionRef.current.set(hookId, pct);
      evictIfFull(completionRef.current);
    }
  }, []);

  const getCompletion = useCallback((hookId: string) => {
    return completionRef.current.get(hookId) ?? 0;
  }, []);

  const value = useMemo<ImpressionTracker>(
    () => ({
      markIfNew,
      markActivated,
      peekActivation,
      setActiveLesson,
      getActiveLesson,
      recordCompletion,
      getCompletion,
    }),
    [
      markIfNew,
      markActivated,
      peekActivation,
      setActiveLesson,
      getActiveLesson,
      recordCompletion,
      getCompletion,
    ],
  );
  return (
    <FeedImpressionContext.Provider value={value}>
      {children}
    </FeedImpressionContext.Provider>
  );
}

export function useFeedImpressionTracker(): ImpressionTracker {
  return useContext(FeedImpressionContext);
}
