'use client';

import { useState, useTransition } from 'react';
import { approveCreatorRequest, declineCreatorRequest } from '../actions';

export function RequestReviewActions({ id }: { id: string }) {
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    url: string;
    emailStatus: 'sent' | 'sent_sandbox' | 'skipped' | 'failed';
  } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setErr(null);
          startTransition(async () => {
            const res = await approveCreatorRequest(id);
            if (!res.ok) setErr(res.error);
            else setResult({ url: res.url, emailStatus: res.emailStatus });
          });
        }}
      >
        Approve &amp; send invite
      </button>

      {result && (
        <div style={{ background: '#111', padding: 12, borderRadius: 6, wordBreak: 'break-all' }}>
          <div
            style={{
              fontSize: 13,
              marginBottom: 8,
              color: result.emailStatus === 'sent' ? '#4ad07a' : '#f0b13a',
            }}
          >
            {result.emailStatus === 'sent'
              ? '✓ Invite email sent.'
              : result.emailStatus === 'sent_sandbox'
                ? '⚠ Sent from the Resend SANDBOX — only the Resend account owner receives it, NOT the creator. Send this link manually:'
                : result.emailStatus === 'skipped'
                  ? '⚠ Email is disabled (no RESEND keys) — send this link manually:'
                  : '⚠ Email failed to send — send this link manually:'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Invite URL (shown once):</div>
          <code>{result.url}</code>
        </div>
      )}

      {!result && (
        <details>
          <summary>Decline</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            <label>
              Internal notes (admin-only, optional)
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
              disabled={pending}
              onClick={() => {
                setErr(null);
                startTransition(async () => {
                  const res = await declineCreatorRequest(id, notes);
                  if (!res.ok) setErr(res.error);
                  else window.location.href = '/admin/requests';
                });
              }}
            >
              Confirm decline
            </button>
          </div>
        </details>
      )}

      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </section>
  );
}
