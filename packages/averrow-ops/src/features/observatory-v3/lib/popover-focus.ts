/** Move focus into a popover that just opened: its first enabled control, else the container itself (tabIndex -1). */
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

export function focusInto(container: HTMLElement | null): void {
  if (!container) return;
  const target = container.querySelector<HTMLElement>(FOCUSABLE) ?? container;
  target.focus({ preventScroll: true });
}
