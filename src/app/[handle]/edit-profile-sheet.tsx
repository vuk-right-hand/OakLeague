'use client';

import { useState, useTransition } from 'react';
import { saveProfile } from '@/lib/profile/profile-actions';

// Self-edit for NON-creator profiles (audit M2: creators edit in Studio).
// Handle change re-mirrors the registry via DB triggers; on success we do a
// full-document navigation (window.location) per CLAUDE.md, never router.push.

const ERR_MESSAGES: Record<string, string> = {
  link_not_allowed: "For your safety, links aren't allowed in your bio.",
  handle_taken: 'That handle is taken — try another.',
  bad_handle: 'Handles are 3–30 chars: letters, numbers, underscore.',
  nothing_to_update: 'Nothing changed.',
  save_failed: 'Could not save — try again.',
};
const friendlyErr = (code: string) => ERR_MESSAGES[code] ?? 'Could not save — try again.';

export function EditProfileSheet({
  handle,
  displayName,
  bio,
}: {
  handle: string;
  displayName: string;
  bio: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(displayName);
  const [b, setB] = useState(bio);
  const [h, setH] = useState(handle);
  const [err, setErr] = useState<string | null>(null);
  const [avatarErr, setAvatarErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarErr(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('/api/me/avatar', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAvatarErr(body.error ?? 'upload_failed');
      } else {
        window.location.reload();
      }
    } finally {
      setUploading(false);
    }
  }

  // MEMORY_BREADTH_PLAN U1b privacy surface — "Forget our conversations".
  // Deletes ALL of the caller's user_creator_memory rows via their own
  // RLS-scoped session (the delete-own policy is the boundary). Memory is
  // an avatar-conversation feature; surfacing the wipe here keeps it one
  // tap from the profile without a new settings page.
  const [forgetState, setForgetState] = useState<'idle' | 'confirm' | 'working' | 'done' | 'error'>('idle');
  async function onForget() {
    if (forgetState === 'idle') { setForgetState('confirm'); return; }
    if (forgetState !== 'confirm') return;
    setForgetState('working');
    try {
      const res = await fetch('/api/me/creator-memory', { method: 'DELETE' });
      setForgetState(res.ok ? 'done' : 'error');
    } catch {
      setForgetState('error');
    }
  }

  function onSave() {
    setErr(null);
    startTransition(async () => {
      const res = await saveProfile({
        display_name: name.trim() || undefined,
        bio: b.trim(),
        handle: h.trim().toLowerCase() === handle.toLowerCase() ? undefined : h.trim().toLowerCase(),
      });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      // Handle may have changed → navigate to the (possibly new) profile URL.
      const dest = h.trim().toLowerCase();
      window.location.href = `/@${dest || handle}`;
    });
  }

  if (!open) {
    return (
      <button className="oak-btn-secondary" onClick={() => setOpen(true)}>
        Edit profile
      </button>
    );
  }

  return (
    <div className="oak-sheet" role="dialog" aria-label="Edit profile">
      <label>
        Display name
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Handle
        <input
          value={h}
          maxLength={30}
          onChange={(e) => setH(e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase())}
        />
      </label>
      <label>
        Bio
        <textarea value={b} maxLength={2000} onChange={(e) => setB(e.target.value)} />
      </label>
      <label>
        Photo
        <input type="file" accept="image/jpeg,image/png" onChange={onAvatar} disabled={uploading} />
        {avatarErr ? <span className="oak-err">{avatarErr}</span> : null}
      </label>
      {err ? <div className="oak-err" role="alert">{friendlyErr(err)}</div> : null}
      <div style={{ marginTop: 8 }}>
        <button
          className="oak-btn-secondary"
          onClick={onForget}
          disabled={forgetState === 'working' || forgetState === 'done'}
        >
          {forgetState === 'idle' && 'Forget our conversations'}
          {forgetState === 'confirm' && 'Tap again to confirm — mentors will no longer remember you'}
          {forgetState === 'working' && 'Forgetting…'}
          {forgetState === 'done' && 'Forgotten ✓'}
          {forgetState === 'error' && 'Could not forget — try again'}
        </button>
      </div>
      <div className="oak-sheet-actions">
        <button className="oak-btn-secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
        <button className="oak-btn-primary" onClick={onSave} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
