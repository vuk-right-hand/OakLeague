import type { Metadata } from 'next';
import SpikeClient from './spike-client';

export const metadata: Metadata = {
  title: 'Spike A — Gemini Latency Gate',
  robots: { index: false, follow: false },
};

export default function SpikeAPage() {
  return <SpikeClient />;
}
