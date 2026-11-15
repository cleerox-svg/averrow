// Visible platform version. The version is a build-time `define` (it changes
// only on a real release); the commit sha and build time are read from <meta>
// tags in index.html (shared buildMeta Vite plugin), so they never alter the JS
// bundle hash and the "new version" banner stays quiet for backend-only
// deploys. Falls back to 'dev' / '' under vitest and the dev server.
function readMeta(name: string): string {
  try {
    return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? '';
  } catch {
    return '';
  }
}

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const BUILD_SHA = readMeta('averrow-build-sha') || 'dev';
export const BUILT_AT = readMeta('averrow-built-at');

/** e.g. "v4.0.0" */
export const VERSION_LABEL = `v${APP_VERSION}`;
