/**
 * Extracts a client IP for rate-limit bucketing.
 *
 * On Vercel Edge, x-real-ip is authoritative (set by the platform after
 * the TLS terminator). Off-Vercel, fall back to the first entry of
 * x-forwarded-for. Never trust XFF at face value on other hosts.
 *
 * Trim to 45 chars to cover IPv6 max length and prevent log bloat.
 */
export function getClientIp(req: Request): string {
  const headers = req.headers;
  const real = headers.get('x-real-ip');
  if (real) return real.slice(0, 45);

  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  return '0.0.0.0';
}
