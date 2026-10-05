import { useEffect, useState } from "react";

/*
 * Theme toggle (footer). Dark is the site default; the visitor can switch
 * to light and the choice is remembered. The OS colour scheme is
 * deliberately NOT consulted: with nothing saved, the site is dark.
 *
 * The pre-paint script in Layout.astro sets data-theme before first paint
 * so there's no flash. This island owns the button state + click handling.
 * A legacy stored value of "auto" (from the old three-way cycle) is read as
 * dark.
 */

type Theme = "dark" | "light";

const STORAGE_KEY = "averrow-theme";

const IconMoon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const IconSun = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

function readSavedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }
}

export default function ThemeCycle() {
  // SSG renders "dark" (the default); the effect syncs to the saved choice.
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(readSavedTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — the toggle still works for this page view
    }
    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === "dark" ? "Theme: dark. Switch to light" : "Theme: light. Switch to dark"}
    >
      <span className="theme-icon-wrap" aria-hidden="true">
        {theme === "dark" ? IconMoon : IconSun}
      </span>
      <span aria-hidden="true">{theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
