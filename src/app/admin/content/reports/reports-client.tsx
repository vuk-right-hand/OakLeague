'use client';

import { useState, useTransition } from 'react';
import { resolveContentReport } from '../actions';

export function ResolveButton({ reportId }: { reportId: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        type="button"
        onClick={() => {
          setErr(null);
          start(async () => {
            const res = await resolveContentReport({ reportId });
            if (!res.ok) setErr(res.error);
          });
        }}
        disabled={pending}
        style={{ fontSize: 12 }}
      >
        {pending ? 'Resolving…' : 'Resolve'}
      </button>
      {err && <span style={{ color: 'salmon', fontSize: 11 }}>{err}</span>}
    </span>
  );
}
