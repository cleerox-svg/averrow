// Vite plugin shared by averrow-ops and averrow-tenant: injects the per-deploy
// build identity into index.html as <meta> tags instead of `define`-ing it into
// the JS.
//
//   plugins: [react(), appearanceHtml(), buildMeta({ sha, builtAt })]
//
// Why: the "new version available" banner (packages/shared/src/ui/update)
// decides a deploy is relevant by comparing the hashed /assets/*.js|css names
// in the shell. A commit sha baked into the bundle changes the entry hash on
// EVERY commit, so backend-only deploys would nag every open tab. With the sha
// in index.html (never part of an asset name), the asset set changes only when
// the app's own code or styles change. src/lib/version.ts reads the metas at
// runtime. The platform version (rarely changing, always a real release) stays
// a `define`.

export const BUILD_SHA_META = 'averrow-build-sha';
export const BUILT_AT_META = 'averrow-built-at';

export interface BuildMetaInfo {
  sha: string;
  builtAt: string;
}

export interface MetaTag {
  tag: 'meta';
  attrs: { name: string; content: string };
  injectTo: 'head';
}

export function buildMetaTags(info: BuildMetaInfo): MetaTag[] {
  return [
    { tag: 'meta', attrs: { name: BUILD_SHA_META, content: info.sha }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: BUILT_AT_META, content: info.builtAt }, injectTo: 'head' },
  ];
}

interface BuildMetaPlugin {
  name: string;
  transformIndexHtml: { order: 'post'; handler: (html: string) => { html: string; tags: MetaTag[] } };
}

export function buildMeta(info: BuildMetaInfo): BuildMetaPlugin {
  return {
    name: 'averrow-build-meta',
    transformIndexHtml: { order: 'post', handler: (html) => ({ html, tags: buildMetaTags(info) }) },
  };
}
