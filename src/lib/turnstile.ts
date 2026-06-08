import 'server-only';

// Cloudflare Turnstile server-side verification. Shared by the consumer
// waitlist and the creator-request form. When TURNSTILE_SECRET_KEY is unset
// (local dev), verification is a no-op pass so the forms work without captcha.

let warnedNoSecretInProd = false;

export async function verifyTurnstile(token: string, remoteIp: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Captcha disabled. In production this silently removes the bot defense on
    // every public form — warn once so a missing env is noticed (audit Small).
    if (process.env.NODE_ENV === 'production' && !warnedNoSecretInProd) {
      warnedNoSecretInProd = true;
      console.warn(
        '[turnstile] TURNSTILE_SECRET_KEY is unset in production — captcha is ' +
          'DISABLED on all public forms (waitlist, creator request). Set it.',
      );
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
