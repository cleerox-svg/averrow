import * as React from 'react';

// Keyframes, scrim, footer layout and toast viewport placement for the overlay
// primitives. Lives in a <style> element (not Tailwind) so the kit needs no
// Tailwind config changes in either app: Radix `data-state` hooks, `@keyframes`
// and media queries are awkward as arbitrary values.
//
// Motion (ACCOUNT_DESIGN_SPEC §7): dialog 180ms scale .98->1 + fade, sheet 300ms
// translateY(100%->0), menu 140ms scale .96->1 from the trigger corner, exits
// ~70% of enter. Reduced motion: opacity-only, 100ms, no slide/scale.
export const OVERLAY_CSS = `
@keyframes av-ov-fade-in{from{opacity:0}to{opacity:1}}
@keyframes av-ov-fade-out{from{opacity:1}to{opacity:0}}
@keyframes av-ov-pop-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}
@keyframes av-ov-pop-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.98)}}
@keyframes av-ov-sheet-in{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes av-ov-sheet-out{from{transform:translateY(0)}to{transform:translateY(100%)}}
@keyframes av-ov-menu-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@keyframes av-ov-menu-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.96)}}
@keyframes av-ov-toast-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes av-ov-spin{to{transform:rotate(360deg)}}

.av-ov-scrim{position:fixed;inset:0;z-index:var(--z-modal,400);background:var(--scrim,rgba(4,7,14,.62));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.av-ov-scrim[data-state=open]{animation:av-ov-fade-in var(--dur-base,180ms) var(--ease-out,ease-out)}
.av-ov-scrim[data-state=closed]{animation:av-ov-fade-out var(--dur-fast,120ms) var(--ease-out,ease-out) forwards}

.av-ov-dialog[data-state=open]{animation:av-ov-pop-in var(--dur-base,180ms) var(--ease-emphasized,ease-out)}
.av-ov-dialog[data-state=closed]{animation:av-ov-pop-out var(--dur-fast,120ms) var(--ease-out,ease-out) forwards}
.av-ov-sheet[data-state=open]{animation:av-ov-sheet-in var(--dur-slow,300ms) var(--ease-emphasized,ease-out)}
.av-ov-sheet[data-state=closed]{animation:av-ov-sheet-out 210ms var(--ease-out,ease-out) forwards}
.av-ov-sheet[data-dragging=true]{animation:none}
.av-ov-menu{transform-origin:var(--radix-dropdown-menu-content-transform-origin,top right)}
.av-ov-menu[data-state=open]{animation:av-ov-menu-in 140ms var(--ease-emphasized,ease-out)}
.av-ov-menu[data-state=closed]{animation:av-ov-menu-out 100ms var(--ease-out,ease-out) forwards}
.av-ov-toast{animation:av-ov-toast-in var(--dur-base,180ms) var(--ease-emphasized,ease-out)}
.av-ov-spinner{animation:av-ov-spin .8s linear infinite}

.av-ov-footer{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.av-ov-footer[data-presentation=sheet]{flex-direction:column-reverse;flex-wrap:nowrap;align-items:stretch}
.av-ov-footer[data-presentation=sheet]>*{width:100%;min-height:44px}

.av-toast-viewport{position:fixed;z-index:var(--z-toast,500);left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom,0px));width:min(420px,calc(100vw - 32px));pointer-events:auto}
@media (min-width:768px){.av-toast-viewport{left:auto;right:24px;transform:none;bottom:24px}}

@media (prefers-reduced-motion:reduce){
  .av-ov-dialog[data-state=open],.av-ov-sheet[data-state=open],.av-ov-menu[data-state=open],.av-ov-toast{animation:av-ov-fade-in 100ms linear !important}
  .av-ov-dialog[data-state=closed],.av-ov-sheet[data-state=closed],.av-ov-menu[data-state=closed]{animation:av-ov-fade-out 100ms linear forwards !important}
  .av-ov-scrim[data-state]{animation-duration:100ms !important}
  .av-ov-spinner{animation-duration:1.6s}
}
`;

/** Emits the overlay CSS. Cheap + idempotent: duplicates are identical rules. */
export function OverlayStyles(): React.ReactElement {
  return <style data-averrow-overlay-styles="">{OVERLAY_CSS}</style>;
}
