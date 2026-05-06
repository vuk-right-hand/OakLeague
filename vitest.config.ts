import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` is a Next.js compile-time barrier; in vitest we
      // resolve it to a no-op so route handlers can be unit-tested
      // without a Next runtime.
      'server-only': path.resolve(__dirname, './src/test-utils/server-only-shim.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
