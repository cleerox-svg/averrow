import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Single platform version source (repo root). The git SHA + build time are
// captured at build, so the version users see auto-updates every deploy.
const platformVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../platform-version.json'), 'utf8'),
).version as string;
const buildSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();

export default defineConfig({
  plugins: [react()],
  base: '/v2/',
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
    outDir: '../averrow-worker/public/v2',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
