/*
 * Scroll-motion loader (marketing only). This is the ONLY motion code in a
 * page's initial bundle: it watches the sections marked `data-motion` and,
 * once one comes within LOAD_MARGIN of the viewport, dynamic-imports the
 * GSAP + ScrollTrigger chunk (./sequences) and hands it the section.
 *
 * Progressive enhancement:
 *   - The HTML is the end state. Nothing is hidden by CSS; start states are
 *     applied by GSAP only after the chunk has loaded, on a section that is
 *     still below the fold.
 *   - Reduced motion, no IntersectionObserver, or a failed import → the
 *     chunk is never loaded / nothing is touched, so the page stays static.
 */

const LOAD_MARGIN = "0px 0px 320px 0px";

type Sequences = typeof import("./sequences");

let started = false;

export function initScrollMotion(): void {
  if (started) return;
  started = true;
  if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-motion]"));
  if (sections.length === 0) return;

  let chunk: Promise<Sequences> | null = null;
  const io = new IntersectionObserver(
    (entries) => {
      const near = entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement);
      if (near.length === 0) return;
      near.forEach((el) => io.unobserve(el));
      chunk ??= import("./sequences");
      chunk.then((m) => near.forEach((el) => m.enhance(el))).catch(() => {
        // Chunk failed to load: the static page is already complete.
      });
    },
    { rootMargin: LOAD_MARGIN },
  );
  sections.forEach((el) => io.observe(el));
}
