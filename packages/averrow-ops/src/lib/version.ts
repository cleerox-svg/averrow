// Visible platform version (set from /platform-version.json + git SHA at
// build time). `typeof` guards keep this safe under vitest where the Vite
// define isn't applied.
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
export const BUILT_AT = typeof __BUILT_AT__ !== 'undefined' ? __BUILT_AT__ : '';

/** e.g. "v4.0.0" */
export const VERSION_LABEL = `v${APP_VERSION}`;
