'use client';

import { assertNever, type BrainStatus } from '@/lib/creator/types';

export function SampleFetchBadge({ status }: { status: BrainStatus }) {
  const { label, bg, fg } = labelFor(status);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        background: bg,
        color: fg,
      }}
    >
      {label}
    </span>
  );
}

function labelFor(status: BrainStatus): { label: string; bg: string; fg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Pending', bg: '#222', fg: '#aaa' };
    case 'queued':
      return { label: 'Fetch queued', bg: '#222', fg: '#aaa' };
    case 'training':
      // Defensive — not set on sample_content in v1. Map to "Pending".
      return { label: 'Pending', bg: '#222', fg: '#aaa' };
    case 'ready':
      return { label: 'Fetched', bg: '#103a1e', fg: '#4ad07a' };
    case 'errored':
      return { label: 'Error', bg: '#3a1010', fg: '#f07070' };
    default:
      return assertNever(status);
  }
}
