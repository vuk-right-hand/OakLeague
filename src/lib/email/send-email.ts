import 'server-only';

import { Resend } from 'resend';
import * as Sentry from '@sentry/nextjs';

// 3-state email sender (CREATOR_JOURNEY_GO_LIVE_PLAN audit C2 / H2).
//
// The funnel-critical failure is NOT "keys absent" (that's a clean no-op) — it's
// "keys present but the send silently fails / lands in spam" (sandbox sender, or
// an unverified/un-warmed domain). So we distinguish THREE outcomes and never
// swallow a failure:
//
//   'skipped' — email disabled (no RESEND_API_KEY / RESEND_FROM_EMAIL). Caller
//               MUST surface the copy-link fallback (invite URL) to the admin.
//   'failed'  — keys present, send errored/threw. Logged to Sentry; caller shows
//               a "not delivered" signal and the copy-link fallback.
//   'sent'    — Resend accepted the message.
//
// Env (all optional — absence = 'skipped', never a crash):
//   RESEND_API_KEY      — Resend secret.
//   RESEND_FROM_EMAIL   — verified sender ("Name <team@domain>"). If it ends in
//                         @resend.dev it's the SANDBOX sender, which can only
//                         deliver to the Resend account owner — we warn loudly.
//   RESEND_REPLY_TO     — optional default reply-to.

//   'sent_sandbox' — Resend accepted it, BUT the sender is a @resend.dev
//                    sandbox address, so it ONLY reaches the Resend account
//                    owner. The recipient almost certainly got nothing. Callers
//                    MUST treat this like a non-delivery (show copy-link) so an
//                    admin doesn't believe a real creator was emailed.
export type EmailStatus = 'sent' | 'sent_sandbox' | 'skipped' | 'failed';
export type SendEmailResult = { status: EmailStatus; id?: string; error?: string };

let warnedSandbox = false;

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  // State 1: email disabled. Clean no-op so dev/CI never break and prod lights
  // up the instant both envs are set. Caller relies on this to show copy-link.
  if (!apiKey || !from) {
    return { status: 'skipped' };
  }

  // Loud warning (once per process) when sending from the Resend sandbox domain
  // — every email to a non-owner address will silently fail to deliver.
  const isSandbox = /@resend\.dev>?\s*$/i.test(from);
  if (!warnedSandbox && isSandbox) {
    warnedSandbox = true;
    console.warn(
      '[email] RESEND_FROM_EMAIL is a resend.dev sandbox sender — delivery is ' +
        'limited to the Resend account owner. Verify a custom domain before ' +
        'onboarding real creators.',
    );
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      replyTo: args.replyTo ?? process.env.RESEND_REPLY_TO,
    });

    if (error) {
      // State 2a: Resend returned an error. Never swallow — a funnel email that
      // silently fails looks like we ghosted the creator.
      Sentry.captureMessage('email_send_failed', {
        level: 'error',
        extra: { subject: args.subject, error: error.message, name: error.name },
      });
      console.error('[email] send failed', { subject: args.subject, error });
      return { status: 'failed', error: error.message ?? 'send_failed' };
    }

    // Accepted by Resend — but flag sandbox sends as non-delivery to the
    // recipient so callers surface the copy-link fallback (audit Small).
    return { status: isSandbox ? 'sent_sandbox' : 'sent', id: data?.id };
  } catch (e) {
    // State 2b: SDK/network threw.
    Sentry.captureException(e, { extra: { op: 'sendEmail', subject: args.subject } });
    console.error('[email] send threw', e);
    return { status: 'failed', error: e instanceof Error ? e.message : 'send_threw' };
  }
}
