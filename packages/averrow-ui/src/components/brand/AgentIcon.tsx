import type { JSX } from 'react';

const icons: Record<string, (size: number) => JSX.Element> = {
  sentinel: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
      <circle cx="18" cy="18" r="8" stroke="currentColor" strokeWidth="1.5" opacity="0.5"/>
      <circle cx="18" cy="18" r="2.5" fill="currentColor"/>
      <line x1="18" y1="4" x2="18" y2="10" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="18" y1="26" x2="18" y2="32" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="4" y1="18" x2="10" y2="18" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="26" y1="18" x2="32" y2="18" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  ),
  analyst: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <path d="M18 6L28 18L18 30L8 18Z" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="18" cy="18" r="4" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="14" y1="18" x2="8" y2="18" stroke="currentColor" strokeWidth="1"/>
      <line x1="22" y1="18" x2="28" y2="18" stroke="currentColor" strokeWidth="1"/>
      <line x1="18" y1="14" x2="18" y2="6" stroke="currentColor" strokeWidth="1"/>
      <line x1="18" y1="22" x2="18" y2="30" stroke="currentColor" strokeWidth="1"/>
    </svg>
  ),
  cartographer: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 2"/>
      <circle cx="18" cy="12" r="2" fill="currentColor"/>
      <circle cx="12" cy="22" r="2" fill="currentColor"/>
      <circle cx="24" cy="20" r="2" fill="currentColor"/>
      <line x1="18" y1="12" x2="12" y2="22" stroke="currentColor" strokeWidth="0.8" opacity="0.5"/>
      <line x1="18" y1="12" x2="24" y2="20" stroke="currentColor" strokeWidth="0.8" opacity="0.5"/>
      <line x1="12" y1="22" x2="24" y2="20" stroke="currentColor" strokeWidth="0.8" opacity="0.5"/>
    </svg>
  ),
  strategist: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <rect x="6" y="8" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="20" y="8" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="13" y="20" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="16" y1="13" x2="20" y2="13" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
      <line x1="18" y1="18" x2="18" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
    </svg>
  ),
  observer: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <path d="M4 18C4 18 10 8 18 8C26 8 32 18 32 18C32 18 26 28 18 28C10 28 4 18 4 18Z" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="18" cy="18" r="5" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="18" cy="18" r="2" fill="currentColor"/>
    </svg>
  ),
  pathfinder: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.4"/>
      <circle cx="26" cy="10" r="2" fill="currentColor" opacity="0.6"/>
      <circle cx="20" cy="24" r="3.5" fill="currentColor" opacity="0.3"/>
      <circle cx="8" cy="26" r="2" fill="currentColor" opacity="0.5"/>
      <path d="M12 12L26 10L20 24L8 26Z" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" opacity="0.4"/>
      <path d="M12 12L20 24" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  ),
  sparrow: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <path d="M18 4L26 18L18 32L10 18Z" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.15"/>
      <circle cx="18" cy="18" r="12" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.4"/>
      <line x1="14" y1="24" x2="22" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="14" cy="24" r="2" fill="currentColor" opacity="0.6"/>
      <path d="M20 10l4 4M24 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
    </svg>
  ),
  nexus: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="8" r="3" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="8" cy="26" r="3" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="28" cy="26" r="3" stroke="currentColor" strokeWidth="1.3"/>
      <line x1="18" y1="11" x2="10" y2="23.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6"/>
      <line x1="18" y1="11" x2="26" y2="23.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6"/>
      <line x1="11" y1="26" x2="25" y2="26" stroke="currentColor" strokeWidth="1.2" opacity="0.6"/>
      <circle cx="18" cy="8" r="1.2" fill="currentColor"/>
      <circle cx="8" cy="26" r="1.2" fill="currentColor"/>
      <circle cx="28" cy="26" r="1.2" fill="currentColor"/>
      <circle cx="18" cy="20" r="2" fill="currentColor" opacity="0.3"/>
    </svg>
  ),
  // Attributor — converging arcs on a fingerprint point.
  // Visualizes "many signals → one identity" — exactly what the agent
  // does when it classifies a NEXUS cluster as a named threat actor.
  attributor: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <path d="M 18 28 Q 6 22 6 12" stroke="currentColor" strokeWidth="1.3" opacity="0.85"/>
      <path d="M 18 28 Q 11 22 11 14" stroke="currentColor" strokeWidth="1.2" opacity="0.6"/>
      <path d="M 18 28 Q 16 22 16 16" stroke="currentColor" strokeWidth="1.1" opacity="0.45"/>
      <path d="M 18 28 Q 25 22 25 14" stroke="currentColor" strokeWidth="1.2" opacity="0.6"/>
      <path d="M 18 28 Q 30 22 30 12" stroke="currentColor" strokeWidth="1.3" opacity="0.85"/>
      <circle cx="18" cy="28" r="2.5" fill="currentColor"/>
      <circle cx="18" cy="28" r="4.5" stroke="currentColor" strokeWidth="0.8" opacity="0.4"/>
    </svg>
  ),
  flight_control: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
      <circle cx="18" cy="18" r="8" stroke="currentColor" strokeWidth="1.2" opacity="0.4"/>
      <path d="M18 4V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M18 26V32" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M4 18H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M26 18H32" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M14 14L18 18L22 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="18" cy="18" r="2.5" fill="currentColor"/>
      <path d="M7.5 7.5L12 12" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
      <path d="M24 12L28.5 7.5" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
    </svg>
  ),
  curator: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <path d="M10 8L26 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M12 8V26C12 27.1 12.9 28 14 28H22C23.1 28 24 27.1 24 26V8" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M15 14H21" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
      <path d="M15 18H21" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
      <path d="M15 22H19" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
      <circle cx="26" cy="26" r="5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M24.5 26L25.5 27L27.5 25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  architect: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="13" stroke="currentColor" strokeWidth="1.2" opacity="0.3"/>
      <path d="M18 5V31" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
      <path d="M5 18H31" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
      <path d="M18 8L24 14L18 20L12 14Z" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="18" cy="14" r="2" fill="currentColor" opacity="0.6"/>
      <path d="M14 22L18 26L22 22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="18" cy="26" r="1.5" fill="currentColor"/>
    </svg>
  ),
  watchdog: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      <path d="M18 6L6 14V24L18 32L30 24V14Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M18 6V32" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
      <circle cx="18" cy="17" r="4" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="18" cy="17" r="1.5" fill="currentColor"/>
      <path d="M14 23H22" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
    </svg>
  ),
  navigator: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* compass housing */}
      <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="18" cy="18" r="10" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
      {/* cardinal tick marks (N/E/S/W) */}
      <line x1="18" y1="4" x2="18" y2="7" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="18" y1="29" x2="18" y2="32" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="4" y1="18" x2="7" y2="18" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="29" y1="18" x2="32" y2="18" stroke="currentColor" strokeWidth="1.2"/>
      {/* compass needle — solid north, faded south */}
      <path d="M18 8L21 18L18 28L15 18Z" fill="currentColor" fillOpacity="0.85"/>
      <path d="M18 8L15 18L18 18Z" fill="currentColor" fillOpacity="0.35"/>
      {/* center pivot */}
      <circle cx="18" cy="18" r="1.6" fill="currentColor"/>
    </svg>
  ),
  // Marshal — App Store Monitor. Sheriff/marshal star badge: catches imposter apps.
  app_store_monitor: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* badge ring */}
      <circle cx="18" cy="18" r="13" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="18" cy="18" r="9.5" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
      {/* 5-point star */}
      <path d="M18 8.5L20.4 14.3L26.7 14.6L21.7 18.4L23.4 24.5L18 21L12.6 24.5L14.3 18.4L9.3 14.6L15.6 14.3Z"
            stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.18" strokeLinejoin="round"/>
      {/* center pip */}
      <circle cx="18" cy="18.4" r="1.2" fill="currentColor"/>
    </svg>
  ),
  // Sounder — Dark Web Monitor. Sonar pulse echolocating into the deep.
  dark_web_monitor: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* depth horizon line */}
      <line x1="4" y1="11" x2="32" y2="11" stroke="currentColor" strokeWidth="0.8" opacity="0.25"/>
      {/* sonar emitter */}
      <circle cx="18" cy="11" r="2" fill="currentColor"/>
      {/* downward concentric arcs (sonar pings going into the dark) */}
      <path d="M11 18C13 16 15.5 15 18 15C20.5 15 23 16 25 18"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M8 23C11 20 14.5 18.5 18 18.5C21.5 18.5 25 20 28 23"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.7"/>
      <path d="M5 28C9 24 13.5 22 18 22C22.5 22 27 24 31 28"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.4"/>
      {/* return blip — what the sonar found in the depth */}
      <circle cx="22" cy="26" r="1.5" fill="currentColor" opacity="0.7"/>
    </svg>
  ),
  // Mockingbird — Social Monitor. Songbird with sound waves; mimicry detector.
  social_monitor: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* bird body */}
      <path d="M9 22C9 17 13 14 18 14C21 14 23 15.5 24 17L28 14L26 19C26 23 23 26 18 26C13 26 9 24 9 22Z"
            stroke="currentColor" strokeWidth="1.4" fill="currentColor" fillOpacity="0.15" strokeLinejoin="round"/>
      {/* eye */}
      <circle cx="22" cy="18" r="0.9" fill="currentColor"/>
      {/* perch */}
      <line x1="11" y1="26" x2="11" y2="31" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="14" y1="26" x2="14" y2="31" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      {/* song / mimic waves */}
      <path d="M30 18C31 17 31 15 30 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.7"/>
      <path d="M32.5 19.5C34 18 34 13 32.5 11.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.4"/>
    </svg>
  ),
  // Cube Healer — OLAP cube maintenance. Stacked cube with a healing chevron sweep.
  cube_healer: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* isometric cube */}
      <path d="M18 6L29 12V24L18 30L7 24V12Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M18 6L18 18L7 12" stroke="currentColor" strokeWidth="1.1" opacity="0.6" strokeLinejoin="round"/>
      <path d="M18 18L29 12" stroke="currentColor" strokeWidth="1.1" opacity="0.6" strokeLinejoin="round"/>
      <path d="M18 18L18 30" stroke="currentColor" strokeWidth="1.1" opacity="0.4" strokeLinejoin="round"/>
      {/* healing pulse — diagonal sweep */}
      <path d="M11 19L14 22L21 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  // Narrator — AI-written threat briefings. Document with a voice/word-mark glyph.
  narrator: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* document outline */}
      <path d="M9 6H21L27 12V30H9V6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M21 6V12H27" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" opacity="0.6"/>
      {/* lines of narrative */}
      <line x1="13" y1="17" x2="23" y2="17" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55"/>
      <line x1="13" y1="21" x2="23" y2="21" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55"/>
      <line x1="13" y1="25" x2="20" y2="25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55"/>
      {/* voice / quote mark — AI flourish */}
      <path d="M28 20C30 20 30 23 28 23M30 20C32 20 32 23 30 23" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.7"/>
    </svg>
  ),
  // Notification Narrator — bell + document hybrid. AI-written
  // per-user daily digest envelope. The bell evokes notifications,
  // the lines evoke the narrative summary.
  notification_narrator: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* bell silhouette */}
      <path d="M18 6V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M11 22V16C11 12.6 14.1 10 18 10C21.9 10 25 12.6 25 16V22L27 24H9L11 22Z"
            stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M16 27C16.5 28 17.2 28.5 18 28.5C18.8 28.5 19.5 28 20 27"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      {/* digest summary lines inside the bell */}
      <line x1="14" y1="17" x2="22" y2="17" stroke="currentColor" strokeWidth="1.0" strokeLinecap="round" opacity="0.6"/>
      <line x1="14" y1="20" x2="20" y2="20" stroke="currentColor" strokeWidth="1.0" strokeLinecap="round" opacity="0.45"/>
    </svg>
  ),
  // Qualified Report — synchronous AI agent for admin-triggered
  // customer-facing brand risk reports. Document with a checkbox-list
  // body (the remediation plan) and a stylised foiled seal in the
  // upper-right corner (the executive sign-off vibe).
  qualified_report: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* document outline */}
      <path
        d="M9 5 L23 5 L29 11 L29 31 L9 31 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.75"
      />
      {/* dog-eared corner fold */}
      <path d="M23 5 L23 11 L29 11" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
      {/* numbered checklist rows — 4 visible, evoking the 5-action plan */}
      <rect x="13" y="16" width="2" height="2" stroke="currentColor" strokeWidth="0.8" opacity="0.65" />
      <line x1="17" y1="17" x2="25" y2="17" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      <rect x="13" y="20" width="2" height="2" stroke="currentColor" strokeWidth="0.8" opacity="0.65" />
      <line x1="17" y1="21" x2="25" y2="21" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      <rect x="13" y="24" width="2" height="2" stroke="currentColor" strokeWidth="0.8" opacity="0.65" />
      <line x1="17" y1="25" x2="23" y2="25" stroke="currentColor" strokeWidth="0.8" opacity="0.5" />
      {/* foiled seal — upper-right corner */}
      <circle cx="27" cy="9" r="2.6" fill="currentColor" fillOpacity="0.85" />
      <circle cx="27" cy="9" r="1.1" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.6" />
    </svg>
  ),

  // Lookalike Scanner — typosquat candidate scoring. Two domains
  // stacked: original (filled) + lookalike (outlined) with one
  // letter highlighted to evoke the typo / homoglyph.
  lookalike_scanner: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* original domain box (filled) */}
      <rect x="3" y="8" width="30" height="8" rx="1.5" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.2" />
      {/* original domain "letters" — 6 small filled cells */}
      <rect x="6" y="11" width="2" height="2" fill="currentColor" opacity="0.85" />
      <rect x="9" y="11" width="2" height="2" fill="currentColor" opacity="0.85" />
      <rect x="12" y="11" width="2" height="2" fill="currentColor" opacity="0.85" />
      <rect x="15" y="11" width="2" height="2" fill="currentColor" opacity="0.85" />
      <rect x="18" y="11" width="2" height="2" fill="currentColor" opacity="0.85" />
      <rect x="21" y="11" width="2" height="2" fill="currentColor" opacity="0.85" />
      {/* lookalike domain box (outline) */}
      <rect x="3" y="20" width="30" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      {/* lookalike domain — same first 5 letters, 4th letter is a different (homoglyph-ish) variant highlighted */}
      <rect x="6" y="23" width="2" height="2" fill="currentColor" opacity="0.65" />
      <rect x="9" y="23" width="2" height="2" fill="currentColor" opacity="0.65" />
      <rect x="12" y="23" width="2" height="2" fill="currentColor" opacity="0.65" />
      <rect x="15" y="22" width="2" height="4" stroke="currentColor" strokeWidth="0.9" opacity="0.95" />
      <rect x="18" y="23" width="2" height="2" fill="currentColor" opacity="0.65" />
      <rect x="21" y="23" width="2" height="2" fill="currentColor" opacity="0.65" />
      {/* warning marker on the homoglyph letter */}
      <circle cx="16" cy="20" r="1" fill="currentColor" />
    </svg>
  ),

  // Brand Enricher — sector classification. A central node with three
  // labelled tags branching out (finance / tech / other) — visual
  // metaphor for picking one bucket from a fixed taxonomy.
  brand_enricher: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* central node — the brand */}
      <circle cx="6" cy="18" r="2.5" fill="currentColor" opacity="0.85" />
      {/* connecting lines branching out */}
      <line x1="8" y1="17" x2="14" y2="9" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <line x1="8" y1="18" x2="14" y2="18" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <line x1="8" y1="19" x2="14" y2="27" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      {/* three sector tag pills — middle one filled (the chosen sector) */}
      <rect x="14" y="6" width="18" height="6" rx="2" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <rect x="14" y="15" width="18" height="6" rx="2" fill="currentColor" fillOpacity="0.85" stroke="currentColor" strokeWidth="1" />
      <rect x="14" y="24" width="18" height="6" rx="2" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      {/* tiny inner marks in each tag */}
      <line x1="17" y1="9" x2="29" y2="9" stroke="currentColor" strokeWidth="0.7" opacity="0.4" />
      <line x1="17" y1="18" x2="26" y2="18" stroke="white" strokeWidth="0.9" />
      <line x1="17" y1="27" x2="29" y2="27" stroke="currentColor" strokeWidth="0.7" opacity="0.4" />
    </svg>
  ),

  // Honeypot Generator — renders fake business websites with hidden
  // trap mailtos. Visual: a stylised building façade with windows,
  // and a tiny @ symbol in one window evoking the embedded trap.
  honeypot_generator: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* building outline */}
      <path
        d="M6 12 L18 4 L30 12 L30 31 L6 31 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.65"
      />
      {/* windows — 2 rows × 3 cols */}
      <rect x="9" y="15" width="3" height="3" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      <rect x="14.5" y="15" width="3" height="3" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      <rect x="20" y="15" width="3" height="3" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      <rect x="9" y="20" width="3" height="3" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      <rect x="14.5" y="20" width="3" height="3" fill="currentColor" opacity="0.85" />
      <rect x="20" y="20" width="3" height="3" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
      {/* tiny @ symbol in the highlighted (filled) window */}
      <text x="14.7" y="22.7" fontSize="3" fill="white" fontWeight="700" style={{ fontFamily: 'monospace' }}>@</text>
      {/* door */}
      <rect x="15.5" y="25" width="5" height="6" stroke="currentColor" strokeWidth="0.8" opacity="0.5" />
    </svg>
  ),

  // Brand Deep Scan — synchronous batch AI agent for Y/N
  // classification of unlinked threats against a brand. Visual:
  // a row of dots (the threat batch) crossed by a bracket-scanner
  // sweeping over them — half marked green ✓, half X.
  brand_deep_scan: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* batch row of items (dots representing threats) */}
      <circle cx="6"  cy="18" r="1.6" fill="currentColor" opacity="0.55" />
      <circle cx="11" cy="18" r="1.6" fill="currentColor" opacity="0.85" />
      <circle cx="16" cy="18" r="1.6" fill="currentColor" opacity="0.55" />
      <circle cx="21" cy="18" r="1.6" fill="currentColor" opacity="0.85" />
      <circle cx="26" cy="18" r="1.6" fill="currentColor" opacity="0.45" />
      <circle cx="31" cy="18" r="1.6" fill="currentColor" opacity="0.65" />
      {/* match check above the matched dots */}
      <path d="M9 11 L11 13 L14 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 11 L21 13 L24 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      {/* scanner brackets sweeping the row */}
      <path d="M3 24 L3 28 L7 28" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M33 24 L33 28 L29 28" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="9" y1="28" x2="27" y2="28" stroke="currentColor" strokeWidth="0.8" opacity="0.45" strokeDasharray="1.5 1.5" />
    </svg>
  ),

  // Brand Report — synchronous AI agent for the per-brand exposure
  // report. Document with three rising bars on it (executive summary
  // + numbered recommendations evoke a printable report).
  brand_report: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* document */}
      <path
        d="M9 5 L23 5 L29 11 L29 31 L9 31 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.65"
      />
      <path d="M23 5 L23 11 L29 11" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
      {/* a couple of summary lines on top */}
      <line x1="13" y1="14" x2="25" y2="14" stroke="currentColor" strokeWidth="0.9" opacity="0.55" />
      <line x1="13" y1="17" x2="22" y2="17" stroke="currentColor" strokeWidth="0.9" opacity="0.45" />
      {/* rising bar chart — three bars of increasing height */}
      <rect x="13" y="24" width="3" height="4" fill="currentColor" opacity="0.55" />
      <rect x="17.5" y="22" width="3" height="6" fill="currentColor" opacity="0.7" />
      <rect x="22" y="20" width="3" height="8" fill="currentColor" opacity="0.85" />
    </svg>
  ),

  // Brand Analysis — synchronous AI agent for the brand detail page.
  // Magnifying glass over a stylised shield (brand mark) — visual
  // metaphor for "examining a brand's threat surface."
  brand_analysis: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* shield (brand mark) */}
      <path
        d="M11 7 L18 5 L25 7 L25 17 C25 22 22 25 18 28 C14 25 11 22 11 17 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.5"
      />
      {/* shield-internal score line */}
      <line x1="14" y1="13" x2="22" y2="13" stroke="currentColor" strokeWidth="0.9" opacity="0.5" />
      <line x1="14" y1="16" x2="22" y2="16" stroke="currentColor" strokeWidth="0.9" opacity="0.35" />
      {/* magnifying glass — body */}
      <circle cx="22" cy="22" r="6" stroke="currentColor" strokeWidth="1.6" />
      {/* magnifying glass — handle */}
      <line x1="26.5" y1="26.5" x2="32" y2="32" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),

  // Public Trust Check — synchronous AI agent for the homepage
  // /api/v1/public/assess endpoint. Lightning bolt (sync / instant)
  // crossing a stylised waveform / response pulse (AI text response).
  // Visually distinct from cron agents to signal the on-demand class.
  public_trust_check: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* horizontal pulse / response waveform */}
      <path
        d="M3 22 L9 22 L11 16 L13 28 L15 14 L17 22 L23 22"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M23 22 L33 22"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.35"
      />
      {/* lightning bolt — sync / on-demand */}
      <path
        d="M22 5 L14 20 L20 20 L17 31 L26 16 L20 16 Z"
        fill="currentColor"
        fillOpacity="0.8"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  ),

  // Enricher — domain geo, brand logo/HQ, sector/RDAP enrichment.
  // A row of three records with progressively more "fill" — left is
  // blank, middle has one row, right is fully filled. Evokes "takes
  // sparse records and fills in the blanks."
  // GeoIP Refresh — globe + grid overlay. The "we ship our own
  // map" agent: Cartographer's third-tier provider that doesn't
  // depend on ip-api.com or ipinfo.io. The pin marks "load
  // complete," the grid lines hint at the IP-range table that
  // backs every lookup.
  geoip_refresh: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* outer globe */}
      <circle cx="18" cy="18" r="11" stroke="currentColor" strokeWidth="1.4" fill="none" />
      {/* longitude lines */}
      <ellipse cx="18" cy="18" rx="5.5" ry="11" stroke="currentColor" strokeWidth="0.8" opacity="0.55" fill="none" />
      <ellipse cx="18" cy="18" rx="11" ry="5.5" stroke="currentColor" strokeWidth="0.8" opacity="0.55" fill="none" />
      {/* equator */}
      <line x1="7" y1="18" x2="29" y2="18" stroke="currentColor" strokeWidth="0.8" opacity="0.7" />
      {/* prime meridian */}
      <line x1="18" y1="7" x2="18" y2="29" stroke="currentColor" strokeWidth="0.8" opacity="0.7" />
      {/* drop pin marking the loaded location */}
      <path d="M24.5 11 L24.5 16 L26.5 14 Z"
            stroke="currentColor" strokeWidth="1" strokeLinejoin="round"
            fill="currentColor" fillOpacity="0.6" />
      <circle cx="24.5" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.18" />
    </svg>
  ),

  enricher: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* three record cards left-to-right with progressive fill */}
      {/* card 1 — empty */}
      <rect x="3" y="9" width="9" height="18" rx="1.5"
            stroke="currentColor" strokeWidth="1.2" opacity="0.5" fill="none" />
      <line x1="5" y1="13" x2="10" y2="13" stroke="currentColor" strokeWidth="0.8" opacity="0.25" />
      <line x1="5" y1="16" x2="10" y2="16" stroke="currentColor" strokeWidth="0.8" opacity="0.25" />
      <line x1="5" y1="19" x2="10" y2="19" stroke="currentColor" strokeWidth="0.8" opacity="0.25" />
      {/* card 2 — partial fill */}
      <rect x="13.5" y="9" width="9" height="18" rx="1.5"
            stroke="currentColor" strokeWidth="1.2" opacity="0.7" fill="none" />
      <line x1="15.5" y1="13" x2="20.5" y2="13" stroke="currentColor" strokeWidth="0.8" />
      <line x1="15.5" y1="16" x2="20.5" y2="16" stroke="currentColor" strokeWidth="0.8" opacity="0.4" />
      <line x1="15.5" y1="19" x2="20.5" y2="19" stroke="currentColor" strokeWidth="0.8" opacity="0.25" />
      {/* card 3 — fully filled */}
      <rect x="24" y="9" width="9" height="18" rx="1.5"
            stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.18" />
      <line x1="26" y1="13" x2="31" y2="13" stroke="currentColor" strokeWidth="0.8" />
      <line x1="26" y1="16" x2="31" y2="16" stroke="currentColor" strokeWidth="0.8" />
      <line x1="26" y1="19" x2="31" y2="19" stroke="currentColor" strokeWidth="0.8" />
      {/* arrow flow under the cards */}
      <path d="M3 31 L33 31" stroke="currentColor" strokeWidth="0.7" opacity="0.45" strokeDasharray="1.2 1.6" />
    </svg>
  ),

  // Seed Strategist — AI planner for spam-trap seeding. A grid of
  // coverage cells (some filled, some empty representing gaps) with
  // a strategic crosshair on an empty cell — "AI identifies the
  // unseeded territory and recommends where to plant next." Pairs
  // visually with Recon (auto_seeder) which executes the plan.
  seed_strategist: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* coverage grid — 4×4 cells */}
      {[6, 13, 20, 27].flatMap((cx, i) => [6, 13, 20, 27].map((cy, j) => {
        // pseudo-random fill pattern: filled if (i*4+j) is in this set
        const filledIndexes = new Set([0, 2, 5, 6, 8, 11, 13]);
        const idx = i * 4 + j;
        const filled = filledIndexes.has(idx);
        return (
          <rect
            key={`${cx}-${cy}`}
            x={cx - 1.5}
            y={cy - 1.5}
            width="3"
            height="3"
            fill={filled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="0.7"
            opacity={filled ? 0.8 : 0.35}
          />
        );
      }))}
      {/* strategic crosshair on an empty cell — the next plant */}
      <circle cx="20" cy="20" r="4" stroke="currentColor" strokeWidth="1.3" opacity="1" />
      <line x1="20" y1="14" x2="20" y2="17" stroke="currentColor" strokeWidth="1.3" />
      <line x1="20" y1="23" x2="20" y2="26" stroke="currentColor" strokeWidth="1.3" />
      <line x1="14" y1="20" x2="17" y2="20" stroke="currentColor" strokeWidth="1.3" />
      <line x1="23" y1="20" x2="26" y2="20" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),

  // Recon — Auto-Seeder. Spam-trap seeding agent: a central planting
  // point with seed addresses scattered out across harvester territory.
  // Connecting lines from origin to each seed evoke "we know exactly
  // where each trap was deployed."
  auto_seeder: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* central origin / "planting" point */}
      <circle cx="18" cy="18" r="2.6" fill="currentColor" />
      <circle cx="18" cy="18" r="5" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      {/* connecting lines to scattered seeds */}
      <line x1="18" y1="18" x2="6" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="18" y1="18" x2="29" y2="6" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="18" y1="18" x2="31" y2="22" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="18" y1="18" x2="22" y2="32" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="18" y1="18" x2="6" y2="28" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      {/* scattered trap seeds */}
      <circle cx="6" cy="8" r="1.8" fill="currentColor" />
      <circle cx="29" cy="6" r="1.8" fill="currentColor" />
      <circle cx="31" cy="22" r="1.8" fill="currentColor" />
      <circle cx="22" cy="32" r="1.8" fill="currentColor" />
      <circle cx="6" cy="28" r="1.8" fill="currentColor" />
    </svg>
  ),

  // Outrider — Social Discovery. Scout arrow pushing forward, breadcrumb dots behind.
  social_discovery: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* breadcrumbs trailing behind */}
      <circle cx="6" cy="22" r="1.4" fill="currentColor" opacity="0.35"/>
      <circle cx="11" cy="20" r="1.6" fill="currentColor" opacity="0.55"/>
      <circle cx="16" cy="18" r="1.8" fill="currentColor" opacity="0.75"/>
      {/* leading arrow / scout */}
      <path d="M20 16L29 12L26 21L23 19L20 22Z"
            stroke="currentColor" strokeWidth="1.4" fill="currentColor" fillOpacity="0.2" strokeLinejoin="round"/>
      {/* horizon line / direction */}
      <line x1="29" y1="12" x2="33" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.6"/>
      <line x1="26" y1="21" x2="30" y2="25" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.4"/>
    </svg>
  ),

  // Admin Classify — backfill that tags unclassified threats with a
  // confidence + severity. Visual: a stack of unlabelled rows on the
  // left feeding into a tag/label icon on the right.
  admin_classify: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* unclassified rows (left, blank) */}
      <rect x="3" y="7" width="14" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <rect x="3" y="12" width="14" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <rect x="3" y="17" width="14" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <rect x="3" y="22" width="14" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <rect x="3" y="27" width="14" height="3" rx="0.6" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      {/* arrow into the tag */}
      <path d="M18 18 L22 18" stroke="currentColor" strokeWidth="1.2" />
      <path d="M22 16 L24 18 L22 20 Z" fill="currentColor" />
      {/* tag/label outline */}
      <path
        d="M25 12 L31 12 L34 18 L31 24 L25 24 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        fillOpacity="0.18"
        fill="currentColor"
      />
      {/* tag eyelet */}
      <circle cx="27" cy="18" r="1" fill="white" />
    </svg>
  ),

  // URL Scan — public URL inspection. Visual: a globe with a
  // magnifying glass overlay; classic inspection metaphor.
  url_scan: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* globe */}
      <circle cx="14" cy="16" r="9" stroke="currentColor" strokeWidth="1.3" opacity="0.65" />
      <ellipse cx="14" cy="16" rx="4" ry="9" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="5" y1="16" x2="23" y2="16" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      {/* magnifying glass — lens */}
      <circle cx="22" cy="22" r="5" stroke="currentColor" strokeWidth="1.6" fill="#0B1120" />
      <circle cx="22" cy="22" r="2.5" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      {/* magnifier handle */}
      <line
        x1="26"
        y1="26"
        x2="32"
        y2="32"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),

  // Scan Report — executive narrative for the public Brand Exposure
  // Report. Visual: a document with a prose paragraph + a small
  // exposure gauge in the corner.
  scan_report: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* document */}
      <path
        d="M7 4 L23 4 L29 10 L29 32 L7 32 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.7"
      />
      {/* dog-ear */}
      <path d="M23 4 L23 10 L29 10" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      {/* prose lines */}
      <line x1="11" y1="15" x2="25" y2="15" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <line x1="11" y1="18" x2="25" y2="18" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <line x1="11" y1="21" x2="22" y2="21" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      {/* small exposure gauge — semicircle in the bottom corner */}
      <path
        d="M13 28 A4 4 0 0 1 21 28"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.55"
      />
      <line x1="17" y1="28" x2="20" y2="25.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="17" cy="28" r="0.9" fill="currentColor" />
    </svg>
  ),

  // Social AI Assessor — classifies social profiles for brand
  // impersonation. Visual: a stylised user avatar with a small
  // verification-style badge whose tick is replaced by a question
  // mark, evoking "is this account legit?"
  social_ai_assessor: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* avatar head */}
      <circle cx="14" cy="13" r="4" stroke="currentColor" strokeWidth="1.4" opacity="0.75" />
      {/* avatar shoulders */}
      <path
        d="M5 28 C5 22 9 19 14 19 C19 19 23 22 23 28"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.75"
      />
      {/* badge — verified-style burst with a question mark inside */}
      <path
        d="M27 8 L29.5 10.5 L33 11 L31 14 L31 17.5 L27.5 16.5 L24 17.5 L24 14 L22 11 L25.5 10.5 Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <text
        x="27.5"
        y="15"
        fontSize="6.5"
        fontWeight="700"
        fill="currentColor"
        textAnchor="middle"
        style={{ fontFamily: 'monospace' }}
      >
        ?
      </text>
      {/* Connecting line — AI assessment links the badge to the avatar */}
      <line
        x1="22"
        y1="17"
        x2="18"
        y2="17"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="1.5 1.5"
        opacity="0.55"
      />
    </svg>
  ),

  // Geo Campaign Assessment — geopolitical campaign intel narrative.
  // Visual: a globe with a pin / target and a small briefing document
  // overlay in the corner.
  geo_campaign_assessment: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* globe */}
      <circle cx="14" cy="18" r="10" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
      <ellipse cx="14" cy="18" rx="5" ry="10" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="4" y1="18" x2="24" y2="18" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <path
        d="M14 8 C10 12 10 24 14 28"
        stroke="currentColor"
        strokeWidth="0.8"
        opacity="0.4"
      />
      {/* targeting pin on the globe */}
      <path
        d="M11 14 C11 12 12.3 10.5 14 10.5 C15.7 10.5 17 12 17 14 C17 16 14 19 14 19 C14 19 11 16 11 14 Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <circle cx="14" cy="14" r="1" fill="white" />
      {/* briefing document, top-right */}
      <rect
        x="22"
        y="6"
        width="10"
        height="12"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="#0B1120"
        strokeLinejoin="round"
      />
      <line x1="24" y1="9" x2="30" y2="9" stroke="currentColor" strokeWidth="0.9" opacity="0.65" />
      <line x1="24" y1="12" x2="30" y2="12" stroke="currentColor" strokeWidth="0.9" opacity="0.65" />
      <line x1="24" y1="15" x2="28" y2="15" stroke="currentColor" strokeWidth="0.9" opacity="0.65" />
    </svg>
  ),

  // Evidence Assembler — assembles takedown evidence packages.
  // Visual: an evidence folder / dossier with a paperclip + pages
  // and a small AI sparkle marker indicating the AI-generated draft.
  evidence_assembler: (s) => (
    <svg width={s} height={s} viewBox="0 0 36 36" fill="none">
      {/* folder body */}
      <path
        d="M5 10 L13 10 L16 13 L31 13 L31 30 L5 30 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.75"
      />
      {/* page peeking out the top of the folder */}
      <rect
        x="9"
        y="6"
        width="14"
        height="10"
        stroke="currentColor"
        strokeWidth="1"
        fill="#0B1120"
        strokeLinejoin="round"
      />
      <line x1="11" y1="9" x2="20" y2="9" stroke="currentColor" strokeWidth="0.9" opacity="0.7" />
      <line x1="11" y1="11" x2="21" y2="11" stroke="currentColor" strokeWidth="0.9" opacity="0.7" />
      <line x1="11" y1="13" x2="18" y2="13" stroke="currentColor" strokeWidth="0.9" opacity="0.7" />
      {/* paperclip */}
      <path
        d="M22 17 C22 16 23 15 24 15 C25 15 26 16 26 17 L26 24 C26 25.5 24.5 27 23 27 C21.5 27 20 25.5 20 24"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      {/* AI sparkle in the corner */}
      <path
        d="M27 22 L27.6 23.4 L29 24 L27.6 24.6 L27 26 L26.4 24.6 L25 24 L26.4 23.4 Z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  ),
};

export function AgentIcon({ agent, size = 24, className }: { agent: string; size?: number; className?: string }) {
  const renderIcon = icons[agent];
  if (!renderIcon) return null;
  return <span className={className} style={{ display: 'inline-flex' }}>{renderIcon(size)}</span>;
}
