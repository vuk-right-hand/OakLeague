import { describe, expect, it } from 'vitest';
import { UrlValidationError, assertSafePublicHttpsUrl } from './validate-url';

function expectRejected(url: string, code?: string) {
  try {
    assertSafePublicHttpsUrl(url);
    throw new Error(`expected rejection for ${url}`);
  } catch (e) {
    if (!(e instanceof UrlValidationError)) throw e;
    if (code) expect(e.code).toBe(code);
  }
}

describe('assertSafePublicHttpsUrl', () => {
  it('accepts ordinary https URLs', () => {
    expect(() => assertSafePublicHttpsUrl('https://example.com/')).not.toThrow();
    expect(() => assertSafePublicHttpsUrl('https://example.com/path?x=1')).not.toThrow();
    expect(() => assertSafePublicHttpsUrl('https://youtu.be/dQw4w9WgXcQ')).not.toThrow();
  });

  it('rejects non-https schemes', () => {
    expectRejected('http://example.com/', 'insecure_scheme');
    expectRejected('ftp://example.com/', 'insecure_scheme');
    expectRejected('javascript:alert(1)', 'insecure_scheme');
    expectRejected('file:///etc/passwd', 'insecure_scheme');
  });

  it('rejects invalid URL strings', () => {
    expectRejected('not a url', 'invalid_url');
    expectRejected('', 'invalid_url');
  });

  it('rejects userinfo (user:pass@host bypass)', () => {
    expectRejected('https://admin:pw@example.com/', 'userinfo_forbidden');
    expectRejected('https://example.com@127.0.0.1/', 'userinfo_forbidden');
  });

  it('blocks IPv4 link-local (IMDS)', () => {
    expectRejected('https://169.254.169.254/latest/meta-data', 'private_address');
  });

  it('blocks dotted-quad loopback', () => {
    expectRejected('https://127.0.0.1/', 'private_address');
    expectRejected('https://127.1.2.3/', 'private_address');
  });

  it('blocks RFC1918 space', () => {
    expectRejected('https://10.0.0.1/', 'private_address');
    expectRejected('https://172.16.0.1/', 'private_address');
    expectRejected('https://192.168.1.1/', 'private_address');
  });

  it('blocks decimal-encoded IPv4', () => {
    // 2130706433 === 127.0.0.1
    expectRejected('https://2130706433/', 'private_address');
  });

  it('blocks octal-encoded IPv4', () => {
    expectRejected('https://0177.0.0.1/', 'private_address');
  });

  it('blocks hex-encoded IPv4', () => {
    expectRejected('https://0x7f000001/', 'private_address');
  });

  it('blocks short-form IPv4', () => {
    // 127.1 → 127.0.0.1
    expectRejected('https://127.1/', 'private_address');
  });

  it('strips trailing hostname dot', () => {
    expectRejected('https://localhost./', 'blocked_hostname');
  });

  it('blocks IPv6 loopback', () => {
    expectRejected('https://[::1]/', 'private_address');
  });

  it('blocks IPv4-mapped IPv6', () => {
    expectRejected('https://[::ffff:7f00:1]/', 'private_address');
  });

  it('blocks IPv6 link-local', () => {
    expectRejected('https://[fe80::1]/', 'private_address');
  });

  it('blocks IPv6 ULA', () => {
    expectRejected('https://[fd00::1]/', 'private_address');
  });

  it('blocks metadata service hostnames', () => {
    expectRejected('https://metadata.google.internal/', 'blocked_hostname');
  });

  it('blocks .internal / .local / .home.arpa TLDs', () => {
    expectRejected('https://foo.internal/', 'blocked_hostname');
    expectRejected('https://router.home.arpa/', 'blocked_hostname');
    expectRejected('https://printer.local/', 'blocked_hostname');
  });

  it('blocks non-ASCII hostnames', () => {
    expectRejected('https://exämple.com/', 'non_ascii_hostname');
  });

  it('blocks explicit ports on internal addresses', () => {
    // Port check fires before address check — both are rejected.
    expectRejected('https://127.0.0.1:22/', 'blocked_port');
    expectRejected('https://localhost:8080/', 'blocked_port');
  });

  it('blocks non-standard HTTPS ports', () => {
    expectRejected('https://example.com:22/', 'blocked_port');
    expectRejected('https://example.com:8080/', 'blocked_port');
    expectRejected('https://example.com:6379/', 'blocked_port');
  });

  it('accepts explicit port 443', () => {
    expect(() => assertSafePublicHttpsUrl('https://example.com:443/')).not.toThrow();
  });
});
