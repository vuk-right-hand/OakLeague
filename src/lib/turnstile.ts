import 'server-only';

// Cloudflare Turnstile server-side verification. Shared by the consumer
// waitlist and the creator-request form. When TURNSTILE_SECRET_KEY is unset
// (local dev), verification is a no-op pass so the forms work without captcha.

let warnedNoSecretInProd = false;

export async function verifyTurnstile(token: string, remoteIp: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // In PRODUCTION, fail CLOSED (audit C1). A captcha that passes when the
    // secret is misconfigured is not a captcha — it silently removes the only
    // bot defense on every public form (waitlist, creator request) and lets an
    // attacker flood the funnel. A loud outage forces the env to be set; a
    // silent open hole gets exploited. In dev/CI we no-op (return true) so the
    // forms work without a Cloudflare key.
    if (process.env.NODE_ENV === 'production') {
      if (!warnedNoSecretInProd) {
        warnedNoSecretInProd = true;
        console.error(
          '[turnstile] TURNSTILE_SECRET_KEY is unset in production — failing ' +
            'CLOSED on all public forms (waitlist, creator request). Set it.',
        );
      }
      return false;
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
