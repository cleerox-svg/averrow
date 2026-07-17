import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Single platform version source (repo root). Git SHA + build time captured at
// build, so the version users see auto-updates every deploy. Mirrors ops.
const platformVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../platform-version.json'), 'utf8'),
).version as string;
const buildSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();

// averrow-tenant — customer-facing v3 app. Builds into the worker's
// /tenant assets path so Cloudflare can serve it from a single
// origin alongside averrow-ops (the staff back-office at /v2). The
// final routing decision (subdomain vs path) lands in Phase D.
export default defineConfig({
  plugins: [react()],
  base: '/tenant/',
  define: {
    __APP_VERSION__: JSON.stringify(platformVersion),
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../averrow-worker/public/tenant',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
