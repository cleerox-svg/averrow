// Signed-in visitors on the exact home page ("/") go straight into their app.
//
// The session cookie is path-scoped to /api/auth, so the server cannot see it
// at "/". Instead the apps (packages/shared/src/auth/appHint.ts) leave a
// non-sensitive hint in localStorage while a session is valid and remove it
// whenever one is lost. This script reads it before first paint and replaces
// the URL. It is only a convenience: the app's own auth check is the real gate,
// and an app that finds no session clears the hint BEFORE sending the visitor
// back to "/?home=1" (which this script never redirects), so there is no loop.
//
// Inlined into the home page's <head> by layouts/Layout.astro (`homeRedirect`
// prop, set only by pages/index.astro; the CSP allows inline scripts). Keep it
// plain ES5 with no imports. The key and values mirror appHint.ts and are
// pinned by packages/averrow-ops/src/test/shared-ui/homeRedirect.test.ts.
(function () {
  try {
    var loc = location;
    // Exact home page only; "?home" (any form) opts out: the "Averrow home"
    // links in the apps and the logged-out bounce use /?home=1.
    if (loc.pathname !== "/") return;
    if (/[?&]home(=|&|$)/.test(loc.search)) return;
    var app = localStorage.getItem("averrow.app");
    var dest = app === "ops" ? "/ops/" : app === "tenant" ? "/tenant/" : "";
    if (dest) loc.replace(dest);
  } catch (e) {
    /* storage blocked: stay on the home page */
  }
})();
