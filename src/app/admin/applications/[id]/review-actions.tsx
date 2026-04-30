'use client';

import { useState, useTransition } from 'react';
import { approveApplication, rejectApplication } from '../actions';

type Props = {
  id: string;
  /** Null means consent missing — Approve is disabled. The DB CHECK
   * + RPC guard would reject anyway; this is the audit R2 M4
   * client-side guard that prevents the user from seeing the error. */
  duetConsentAt: string | null;
};

export function ReviewActions({ id, duetConsentAt }: Props) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const consentMissing = duetConsentAt === null;

  return (
    <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        type="button"
        disabled={pending || consentMissing}
        title={consentMissing ? 'Cannot approve: duet consent not recorded.' : undefined}
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
      {consentMissing && (
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Consent missing — approval blocked at DB layer. Contact engineering
          to backfill the consent timestamp, or reject this application.
        </div>
      )}

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
