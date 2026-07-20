import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Mirrors averrow-ops's vitest.config.ts — same jsdom + RTL harness,
// added here in EXEC_IMPERSONATION_2026-07 Stage 5 (the first tenant
// feature test). `vitest` itself and the `"test": "vitest run"` script
// already existed in package.json with nothing to run; this file (plus
// the jsdom/@testing-library/* devDependencies and src/test/setup.ts)
// is what actually wires up a runnable jsdom + React Testing Library
// harness for component tests — it did not exist before this stage.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
