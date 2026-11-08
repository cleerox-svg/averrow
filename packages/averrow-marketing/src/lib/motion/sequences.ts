/*
 * Scroll sequences — GSAP core tweens, lazy chunk (see ./loader.ts).
 *
 * Triggered by IntersectionObserver, not ScrollTrigger: nothing here reads
 * or writes scroll position, refreshes layout or restores scroll, so hash
 * deep links (/#by-the-numbers) land exactly where the browser put them.
 *
 * M1 "Precision" budget (BRAND_BRIEF §10 G4, tokens.css --motion-*):
 * 200 ms entrances, ≤ 8 px travel, decelerating ease, never an overshoot.
 * Values are never animated (BRAND_BRIEF §4: numbers render immediately,
 * motion never gates reading). No pinning.
 *
 * Kinds (the section's data-motion value):
 *   reveal   — [data-motion-head], then direct children of [data-motion-items]
 *   stagger  — the section's own direct children
 *   numbers  — reveal + the ByTheNumbers bars grow from 0 (value text stays put)
 *
 * A section that is already (partly) in view when the chunk arrives is left
 * alone: no hide-then-show flash. Every tween clears its inline props when
 * it ends, so hover transforms and live re-renders never fight a style="".
 */
import { gsap } from "gsap";

const DUR = 0.2; // --motion-slow
const TRAVEL = 8; // --motion-travel-lg
const STAGGER = 0.06;
const EASE = "power3.out"; // ≈ ease-standard cubic-bezier(0.2, 0, 0, 1)
const BAR_DUR = 0.3;
// Play when the section's top crosses 85% of the viewport height.
const PLAY_MARGIN = "0px 0px -15% 0px";
const PLAY_LINE = 0.85;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Laid-out elements only (skips closed <details> content and display:none copies). */
function visible(els: Element[]): HTMLElement[] {
  return els.filter((el): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0);
}

export function enhance(section: HTMLElement): void {
  if (reduced()) return;
  // Already in (or above) the viewport: leave it exactly as rendered.
  if (section.getBoundingClientRect().top < window.innerHeight) return;

  const kind = section.dataset.motion;
  const head = visible(Array.from(section.querySelectorAll("[data-motion-head]")));
  const items = visible(
    kind === "stagger"
      ? Array.from(section.children)
      : Array.from(section.querySelectorAll("[data-motion-items] > *")),
  );
  const bars = kind === "numbers" ? visible(Array.from(section.querySelectorAll(".num-bar-f"))) : [];
  const reveal = [...head, ...items];
  if (reveal.length === 0 && bars.length === 0) return;

  // Start states — applied only now, on a section still below the fold.
  gsap.set(reveal, { opacity: 0, y: TRAVEL });
  gsap.set(bars, { scaleX: 0, transformOrigin: "left center" });

  let played = false;
  const play = () => {
    if (played) return;
    played = true;
    io.disconnect();
    window.removeEventListener("scroll", onScroll);
    gsap.to(head, { opacity: 1, y: 0, duration: DUR, ease: EASE, clearProps: "opacity,transform" });
    gsap.to(items, {
      opacity: 1,
      y: 0,
      duration: DUR,
      ease: EASE,
      stagger: STAGGER,
      delay: head.length ? 0.08 : 0,
      clearProps: "opacity,transform",
    });
    gsap.to(bars, { scaleX: 1, duration: BAR_DUR, ease: "power2.out", clearProps: "transform,transformOrigin" });
  };

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) play();
  }, { rootMargin: PLAY_MARGIN });
  io.observe(section);

  // A fast jump (End key, scrollbar drag) can carry the section from below
  // the fold to above the viewport between two observer checks, which never
  // reports an intersection. Catch that with a read-only position check.
  let queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (section.getBoundingClientRect().top < window.innerHeight * PLAY_LINE) play();
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
}
