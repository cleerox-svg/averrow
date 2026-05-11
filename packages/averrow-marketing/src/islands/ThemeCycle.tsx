import { useEffect, useState } from "react";

/*
 * Theme cycle island — auto → dark → light → auto. Mirror of the
 * back-end (averrow-ops) Sidebar.tsx ThemeCycleButton. Stored
 * preference can be 'auto' | 'dark' | 'light' | null (treated as auto).
 *
 * The pre-paint script in Layout.astro already sets data-theme before
 * first paint so there's no flash. This island just owns the button
 * state + click handling + OS-theme listening.
 */

type Mode = "auto" | "dark" | "light";

const STORAGE_KEY = "averrow-theme";

const IconLaptop = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
  </svg>
);

const IconMoon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const IconSun = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="M4.93 4.93l1.41 1.41" />
    <path d="M17.66 17.66l1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="M4.93 19.07l1.41-1.41" />
    <path d="M17.66 6.34l1.41-1.41" />
  </svg>
);

function readSavedMode(): Mode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "auto" || saved === "dark" || saved === "light") return saved;
  } catch {
    // localStorage unavailable
  }
  return "auto";
}

function resolveTheme(mode: Mode): "dark" | "light" {
  if (mode === "dark" || mode === "light") return mode;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function labelFor(mode: Mode): string {
  return mode === "auto"
    ? "Theme: auto (follows OS) — click for dark"
    : mode === "dark"
      ? "Theme: dark — click for light"
      : "Theme: light — click for auto";
}

export default function ThemeCycle() {
  // SSG renders this island with mode='auto' so the button has *some*
  // markup. The effect below corrects it to the saved preference once
  // the component hydrates client-side.
  const [mode, setMode] = useState<Mode>("auto");

  useEffect(() => {
    setMode(readSavedMode());

    // While in auto, follow OS theme changes without writing localStorage.
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const listener = () => {
      if (readSavedMode() === "auto") {
        document.documentElement.setAttribute("data-theme", resolveTheme("auto"));
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", listener);
    else if ((mq as MediaQueryList).addListener)
      (mq as MediaQueryList).addListener(listener);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", listener);
      else if ((mq as MediaQueryList).removeListener)
        (mq as MediaQueryList).removeListener(listener);
    };
  }, []);

  function cycle() {
    const next: Mode = mode === "auto" ? "dark" : mode === "dark" ? "light" : "auto";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable
    }
    document.documentElement.setAttribute("data-theme", resolveTheme(next));
    setMode(next);
  }

  const icon = mode === "auto" ? IconLaptop : mode === "dark" ? IconMoon : IconSun;
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={labelFor(mode)}
      title="Cycle theme (auto / dark / light)"
    >
      <span className="theme-icon-wrap" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}
