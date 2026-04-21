'use client';

import { useEffect } from 'react';

export default function CreatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[creator]', error);
  }, [error]);

  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <p style={{ color: '#f07070', marginBottom: 16 }}>
        Something went wrong loading your dashboard.
      </p>
      <button
        onClick={reset}
        style={{
          padding: '8px 16px',
          background: '#2a5bff',
          color: 'white',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        Try again
      </button>
    </div>
  );
}
