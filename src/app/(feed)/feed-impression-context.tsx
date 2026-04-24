'use client';

import { createContext, useCallback, useContext, useMemo, useRef } from 'react';

// N1 defense-in-depth: per-container Set of hook_ids that have already fired
// a hook_impression during this FeedContainer mount. Guards against React
// reconciliation unmounting + remounting a HookPanel (e.g., groupByVideo
// rebuild changing object identity) and re-firing the impression with a
// fresh idempotency_key — which the ingest RPC's UNIQUE constraint would
// happily accept, polluting hook_global_stats.impressions.
//
// On mount of a new FeedContainer (fresh page navigation), the Set resets
// so a genuine return visit still counts as an impression.

type ImpressionTracker = {
  markIfNew: (hookId: string) => boolean;
};

const noopTracker: ImpressionTracker = {
  markIfNew: () => true,
};

const FeedImpressionContext = createContext<ImpressionTracker>(noopTracker);

export function FeedImpressionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const setRef = useRef<Set<string>>(new Set());

  const markIfNew = useCallback((hookId: string) => {
    if (setRef.current.has(hookId)) return false;
    setRef.current.add(hookId);
    return true;
  }, []);

  const value = useMemo<ImpressionTracker>(() => ({ markIfNew }), [markIfNew]);
  return (
    <FeedImpressionContext.Provider value={value}>
      {children}
    </FeedImpressionContext.Provider>
  );
}

export function useFeedImpressionTracker(): ImpressionTracker {
  return useContext(FeedImpressionContext);
}
