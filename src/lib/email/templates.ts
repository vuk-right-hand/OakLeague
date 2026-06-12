import 'server-only';

// Email templates. CRITICAL (audit H3): these are HTML strings built by
// interpolation — they do NOT auto-escape like JSX. EVERY piece of
// user/admin/anon-supplied text MUST go through escapeHtml() (body text) or
// escapeAttr() (inside an attribute like href), or anon free-text becomes
// stored XSS in the recipient's inbox / forwarded screenshots.

export type RenderedEmail = { subject: string; html: string };

/** Escape text destined for HTML body content. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape text destined for an HTML attribute value. Assumes the attribute is
 * DOUBLE-quoted (e.g. href="...") — escapeHtml covers `"` and the angle
 * brackets, which is sufficient for double-quoted attrs. Do NOT use inside a
 * single-quoted attribute (audit Small).
 */
export function escapeAttr(input: string): string {
  return escapeHtml(input);
}

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

// Shared shell. `bodyHtml` is assembled by callers from already-escaped pieces.
function shell(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px;color:#0a0a0a;line-height:1.5;">${bodyHtml}</div>`;
}

function button(url: string, label: string): string {
  // Enforce http(s) here rather than trusting callers (audit Small): a future
  // caller passing `javascript:`/`data:` would otherwise render a clickable
  // XSS link in email clients that honor the scheme. Non-http(s) → inert '#'.
  const safe = /^https?:\/\//i.test(url) ? url : '#';
  return `<p><a href="${escapeAttr(safe)}" style="background:#0a0a0a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">${escapeHtml(label)}</a></p>`;
}

// ── Invite (WS0/WS1) ─────────────────────────────────────────────────────
export function renderInviteEmail(args: { url: string; expiresAt: string }): RenderedEmail {
  // Guard against a non-ISO date string slipping in from a future caller
  // (audit M-5): show the raw value rather than rendering "Invalid Date".
  const parsed = new Date(args.expiresAt);
  const human = Number.isNaN(parsed.getTime()) ? args.expiresAt : parsed.toUTCString();
  return {
    subject: 'You’re invited to OakLeague as a creator',
    html: shell(
      `<h2>You’re invited to OakLeague as a creator</h2>` +
        `<p>This invite is single-use and expires ${escapeHtml(human)}.</p>` +
        button(args.url, 'Claim your spot') +
        `<p style="color:#666;font-size:12px;word-break:break-all;">Or paste this link: ${escapeHtml(args.url)}</p>`,
    ),
  };
}

// ── Creator request received — ack to the requester (WS1) ────────────────
export function renderRequestReceivedEmail(): RenderedEmail {
  return {
    subject: 'We got your request to join OakLeague',
    html: shell(
      `<h2>Thanks — we’ve got your request</h2>` +
        `<p>Our team reviews every creator request by hand. If it’s a fit, we’ll email you an invite to set up your profile.</p>` +
        `<p style="color:#666;font-size:13px;">No action needed right now.</p>`,
    ),
  };
}

// ── Application received — ack to the applicant (WS2) ─────────────────────
export function renderApplicationReceivedEmail(): RenderedEmail {
  return {
    subject: 'Your OakLeague creator application is in review',
    html: shell(
      `<h2>Application received</h2>` +
        `<p>Thanks for applying. A reviewer will take a look — usually within 48 hours — and we’ll email you the decision.</p>`,
    ),
  };
}

// ── Application approved (WS2) ───────────────────────────────────────────
export function renderApplicationApprovedEmail(args: { displayName: string }): RenderedEmail {
  const studio = `${siteUrl()}/creator`;
  return {
    subject: 'You’re in — set up your OakLeague studio',
    html: shell(
      `<h2>Welcome aboard${args.displayName ? `, ${escapeHtml(args.displayName)}` : ''}</h2>` +
        `<p>Your creator application was approved. Next, open your studio to:</p>` +
        `<ul>` +
        `<li>Add your knowledge topics</li>` +
        `<li>Record a short voice sample so we can build your voice</li>` +
        `<li>Upload your photo and your first videos</li>` +
        `</ul>` +
        button(studio, 'Open your studio') +
        `<p style="color:#666;font-size:12px;word-break:break-all;">Or paste this link: ${escapeHtml(studio)}</p>`,
    ),
  };
}

// ── Application rejected (WS2) — carries the admin-written reason ─────────
export function renderApplicationRejectedEmail(args: { reason: string }): RenderedEmail {
  return {
    subject: 'Update on your OakLeague creator application',
    html: shell(
      `<h2>Thanks for applying</h2>` +
        `<p>After review, we’re not moving forward with your creator application right now.</p>` +
        (args.reason
          ? `<p style="background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;">${escapeHtml(args.reason)}</p>`
          : '') +
        `<p style="color:#666;font-size:13px;">You’re welcome to reapply in the future.</p>`,
    ),
  };
}

// ── Creator published — "you're live" (WS2) ──────────────────────────────
export function renderCreatorLiveEmail(args: { handle: string; displayName: string }): RenderedEmail {
  const profile = `${siteUrl()}/@${args.handle}`;
  return {
    subject: 'You’re live on OakLeague 🎉',
    html: shell(
      `<h2>You’re live${args.displayName ? `, ${escapeHtml(args.displayName)}` : ''}</h2>` +
        `<p>Your OakLeague profile is published. Share it anywhere:</p>` +
        button(profile, 'View your profile') +
        `<p style="color:#666;font-size:12px;word-break:break-all;">${escapeHtml(profile)}</p>`,
    ),
  };
}
