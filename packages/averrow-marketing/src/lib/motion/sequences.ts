/*
 * Scroll sequences — GSAP + ScrollTrigger, lazy chunk (see ./loader.ts).
 *
 * M1 "Precision" budget (BRAND_BRIEF §10 G4, tokens.css --motion-*):
 * 200 ms entrances, ≤ 8 px travel, decelerating ease, never an overshoot.
 * Counters run longer (they carry information) but are monotonic and end on
 * the exact server-rendered string. No pinning.
 *
 * Kinds (the section's data-motion value):
 *   reveal   — head, then direct children of [data-motion-items] stagger in
 *   stagger  — the section's own direct children stagger in
 *   numbers  — reveal + count-up on [data-motion-count] + bars grow from 0
 *
 * Every tween clears its inline props on completion, so hover transforms
 * and live re-renders (ByTheNumbers refresh) are never fighting a style="".
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const DUR = 0.2; // --motion-slow
const TRAVEL = 8; // --motion-travel-lg
const STAGGER = 0.06;
const EASE = "power3.out"; // ≈ ease-standard cubic-bezier(0.2, 0, 0, 1)
const COUNT_DUR = 0.9;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let refreshWired = false;
function wireRefresh(): void {
  if (refreshWired) return;
  refreshWired = true;
  // Content above a trigger can change height after load (live stats,
  // <details> folds). Keep trigger positions honest so none is stranded
  // below the reachable scroll range with its content still hidden.
  let t = 0;
  const refresh = () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => ScrollTrigger.refresh(), 120);
  };
  if ("ResizeObserver" in window) new ResizeObserver(refresh).observe(document.body);
  document.addEventListener("toggle", refresh, true);
}

/** Visible, laid-out elements only (skips closed <details> content, display:none). */
function visible(els: Element[]): HTMLElement[] {
  return els.filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.getClientRects().length > 0 && !el.closest("details:not([open]) > :not(summary)"),
  );
}

function trigger(section: HTMLElement): ScrollTrigger.Vars {
  // clamp(): a trigger near the page end still fires within the scroll range.
  return { trigger: section, start: "clamp(top 85%)", once: true };
}

function revealIn(section: HTMLElement, targets: HTMLElement[], delay = 0): void {
  if (targets.length === 0) return;
  gsap.from(targets, {
    opacity: 0,
    y: TRAVEL,
    duration: DUR,
    ease: EASE,
    stagger: STAGGER,
    delay,
    clearProps: "opacity,transform",
    scrollTrigger: trigger(section),
  });
}

const NUM_RE = /^(\D*?)(\d{1,3}(?:,\d{3})*|\d+)(\D*)$/;

/** Count an integer label ("12,000+", "1,234,567", "40+") up from 0. */
function countUp(section: HTMLElement, el: HTMLElement): void {
  const finalText = el.textContent ?? "";
  const m = NUM_RE.exec(finalText.trim());
  if (!m) return;
  const [, pre, digits, post] = m;
  const target = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(target) || target < 10) return;
  const grouped = digits.includes(",");
  const fmt = (n: number) => pre + (grouped ? Math.round(n).toLocaleString("en-US") : String(Math.round(n))) + post;

  const state = { n: 0 };
  let written = "";
  let tween: gsap.core.Tween | null = null;
  ScrollTrigger.create({
    ...trigger(section),
    onEnter: () => {
      // Hold the final width so the tile never reflows while counting.
      el.style.display = "inline-block";
      el.style.minWidth = `${el.getBoundingClientRect().width}px`;
      const done = () => {
        if (el.textContent === written) el.textContent = finalText;
        el.style.removeProperty("min-width");
        el.style.removeProperty("display");
      };
      tween = gsap.to(state, {
        n: target,
        duration: COUNT_DUR,
        ease: "power2.out", // monotonic: never passes the real number
        onUpdate: () => {
          // A live refresh rewrote the value mid-count: stop and keep it.
          if (written && el.textContent !== written) {
            tween?.kill();
            el.style.removeProperty("min-width");
            el.style.removeProperty("display");
            return;
          }
          written = fmt(Math.min(state.n, target));
          el.textContent = written;
        },
        onComplete: done,
      });
    },
  });
}

function growBars(section: HTMLElement, bars: HTMLElement[]): void {
  if (bars.length === 0) return;
  gsap.from(bars, {
    scaleX: 0,
    transformOrigin: "left center",
    duration: 0.5,
    ease: "power2.out",
    stagger: 0.04,
    clearProps: "transform,transformOrigin",
    scrollTrigger: trigger(section),
  });
}

export function enhance(section: HTMLElement): void {
  if (reduced()) return;
  // Already scrolled past (e.g. reload mid-page): leave it as rendered.
  if (section.getBoundingClientRect().bottom < 0) return;
  wireRefresh();

  const kind = section.dataset.motion;
  const head = visible(Array.from(section.querySelectorAll("[data-motion-head]")));
  const items = visible(
    kind === "stagger"
      ? Array.from(section.children)
      : Array.from(section.querySelectorAll("[data-motion-items] > *")),
  );

  revealIn(section, head);
  revealIn(section, items, head.length ? 0.08 : 0);

  if (kind === "numbers") {
    visible(Array.from(section.querySelectorAll("[data-motion-count]"))).forEach((el) => countUp(section, el));
    growBars(section, visible(Array.from(section.querySelectorAll(".num-bar-f"))));
  }
}
