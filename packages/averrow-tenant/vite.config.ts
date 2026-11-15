import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { appearanceHtml } from '../shared/scripts/appearance-html';
import { buildMeta } from '../shared/scripts/build-meta';
import path from 'path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Single platform version source (repo root). Git SHA + build time captured at
// build, so the version users see auto-updates every deploy. Mirrors ops.
const platformVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../platform-version.json'), 'utf8'),
).version as string;
const buildSha = (() => {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();
const builtAt = new Date().toISOString();

// averrow-tenant — customer-facing v3 app. Builds into the worker's
// /tenant assets path so Cloudflare can serve it from a single
// origin alongside averrow-ops (the staff back-office at /ops). The
// final routing decision (subdomain vs path) lands in Phase D.
export default defineConfig({
  // appearanceHtml(): fills index.html's appearance bootstrap / theme-color /
  // Geist preloads from the FACELIFT switch (packages/shared/scripts/appearance-html.ts).
  // buildMeta(): sha + build time go into index.html <meta> tags, NOT the JS
  // (a sha in the bundle changes the entry hash on every commit and would fire
  // the "new version" banner after backend-only deploys).
  plugins: [react(), appearanceHtml(), buildMeta({ sha: buildSha, builtAt })],
  base: '/tenant/',
  define: {
    __APP_VERSION__: JSON.stringify(platformVersion),
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
