import type { Metadata } from 'next';
import ProxyClient from './proxy-client';

export const metadata: Metadata = {
  title: 'Spike A — Proxy TTFA',
  robots: { index: false, follow: false },
};

export default function SpikeAProxyPage() {
  return <ProxyClient />;
}
