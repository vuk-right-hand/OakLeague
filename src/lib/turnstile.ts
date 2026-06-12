import 'server-only';

// Cloudflare Turnstile server-side verification. Shared by the consumer
// waitlist and the creator-request form. When TURNSTILE_SECRET_KEY is unset
// (local dev), verification is a no-op pass so the forms work without captcha.

let warnedNoSecretInProd = false;

export async function verifyTurnstile(token: string, remoteIp: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // TEMPORARY fail-OPEN (Vuk, 2026-06-12): no Turnstile account exists yet,
    // and the waitlist is live — failing closed would break a working public
    // form. Until the account exists this passes WITH a loud Sentry alarm on
    // every prod submission so the gap is impossible to forget. The rate
    // limits + dedupe in the callers remain the bot defense meanwhile.
    // The moment TURNSTILE_SECRET_KEY + NEXT_PUBLIC_TURNSTILE_SITE_KEY are set
    // in Vercel, real verification activates automatically (no code change).
    // Audit C1 (fail closed on missing key) should be restored once the env
    // vars have been live + verified — tracked in CLEANUP_BACKLOG.md.
    if (process.env.NODE_ENV === 'production') {
      if (!warnedNoSecretInProd) {
        warnedNoSecretInProd = true;
        console.error(
          '[turnstile] TURNSTILE_SECRET_KEY unset in production — captcha is ' +
            'OPEN on all public forms (waitlist, creator request). Set it ASAP.',
        );
      }
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureMessage('turnstile_missing_secret_prod_failopen', { level: 'warning' });
    }
    return true;
  }
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const json = (await res.json()) as { success?: boolean };
    return Boolean(json.success);
  } catch {
    return false;
  }
}
