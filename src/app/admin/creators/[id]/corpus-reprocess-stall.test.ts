import { describe, it, expect } from 'vitest';
import { isWorkerLikelyStalled, STALL_THRESHOLD_SECONDS } from './corpus-reprocess-stall';

describe('isWorkerLikelyStalled', () => {
  it('not stalled when nothing is pending', () => {
    expect(isWorkerLikelyStalled({ pending: 0, processing: 0 }, 9999)).toBe(false);
    expect(isWorkerLikelyStalled({ pending: 0, processing: 0 }, 0)).toBe(false);
  });

  it('not stalled when a job is processing (worker is alive)', () => {
    expect(isWorkerLikelyStalled({ pending: 5, processing: 1 }, 9999)).toBe(false);
  });

  it('not stalled when pending just appeared (within threshold grace)', () => {
    expect(isWorkerLikelyStalled({ pending: 3, processing: 0 }, 5)).toBe(false);
    expect(isWorkerLikelyStalled({ pending: 3, processing: 0 }, STALL_THRESHOLD_SECONDS - 1)).toBe(false);
  });

  it('stalled when pending persists with no processing past the threshold', () => {
    expect(isWorkerLikelyStalled({ pending: 3, processing: 0 }, STALL_THRESHOLD_SECONDS)).toBe(true);
    expect(isWorkerLikelyStalled({ pending: 1, processing: 0 }, 120)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isWorkerLikelyStalled({ pending: 1, processing: 0 }, 10, 60)).toBe(false);
    expect(isWorkerLikelyStalled({ pending: 1, processing: 0 }, 61, 60)).toBe(true);
  });
});
