'use client';

import { useEffect, useRef, useState } from 'react';
import { assertNever, type BrainStatus } from '@/lib/creator/types';

const POLL_INITIAL_MS = 10_000;
const POLL_ACTIVE_MS = 2_000;
const POLL_MAX_MS = 60_000;
const POLL_HARD_STOP_MS = 10 * 60_000;

export function BrainStatusBadge({ initialStatus }: { initialStatus: BrainStatus }) {
  const [status, setStatus] = useState<BrainStatus>(initialStatus);
  const [stopped, setStopped] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  // Start with shorter interval when already in an active transition state.
  const delayRef = useRef<number>(
    initialStatus === 'training' || initialStatus === 'queued'
      ? POLL_ACTIVE_MS
      : POLL_INITIAL_MS,
  );

  useEffect(() => {
    if (stopped) return;
    if (status === 'ready' || status === 'errored') return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAtRef.current > POLL_HARD_STOP_MS) {
        setStopped(true);
        return;
      }
      try {
        const res = await fetch('/api/creator/brain-status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status_${res.status}`);
        const body = (await res.json()) as { brain_status: BrainStatus };
        if (!cancelled) {
          setStatus(body.brain_status);
          delayRef.current = POLL_INITIAL_MS;
        }
      } catch {
        delayRef.current = Math.min(delayRef.current * 2, POLL_MAX_MS);
      }
      if (!cancelled) {
        timerId = setTimeout(tick, delayRef.current);
      }
    };

    timerId = setTimeout(tick, delayRef.current);
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [status, stopped]);

  return <Pill status={status} stopped={stopped} />;
}

function Pill({ status, stopped }: { status: BrainStatus; stopped: boolean }) {
  const { label, bg, fg } = labelFor(status);
  const suffix = stopped && (status === 'pending' || status === 'queued' || status === 'training')
    ? ' — refresh to check'
    : '';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: bg,
        color: fg,
      }}
    >
      {label}
      {suffix}
    </span>
  );
}

function labelFor(status: BrainStatus): { label: string; bg: string; fg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Setting up', bg: '#2a2a2a', fg: '#ccc' };
    case 'queued':
      return { label: 'Training queued', bg: '#2a2a2a', fg: '#ccc' };
    case 'training':
      return { label: 'Training your brain…', bg: '#3a2e10', fg: '#f0b040' };
    case 'ready':
      return { label: 'Ready', bg: '#103a1e', fg: '#4ad07a' };
    case 'errored':
      return { label: 'Training failed — contact support', bg: '#3a1010', fg: '#f07070' };
    default:
      return assertNever(status);
  }
}
