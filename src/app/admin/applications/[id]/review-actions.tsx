'use client';

import { useState, useTransition } from 'react';
import { approveApplication, rejectApplication } from '../actions';

export function ReviewActions({ id }: { id: string }) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setErr(null);
          startTransition(async () => {
            const res = await approveApplication(id);
            if (!res.ok) setErr(res.error);
            else window.location.href = '/admin/applications';
          });
        }}
      >
        Approve
      </button>

      <details>
        <summary>Reject</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <label>
            Rejection reason (shown to applicant)
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
            />
          </label>
          <label>
            Internal notes (admin-only)
            <textarea
              rows={2}
              maxLength={4000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={pending}
            />
          </label>
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => {
              setErr(null);
              startTransition(async () => {
                const res = await rejectApplication(id, reason, notes);
                if (!res.ok) setErr(res.error);
                else window.location.href = '/admin/applications';
              });
            }}
          >
            Confirm reject
          </button>
        </div>
      </details>

      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </section>
  );
}
