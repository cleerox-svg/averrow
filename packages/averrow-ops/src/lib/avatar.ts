// Avatar helpers — initials parsing + deterministic color picker.
//
// Two rules from the platform-wide standardization:
//
//   1. Initials come from the user's display_name parsed as "First Last":
//      "Claude Leroux"        → "CL"
//      "Claude Marc Leroux"   → "CL"   (first + last word, drops middle)
//      "Claude"               → "C"
//      null + email           → first char of email local-part
//      all-null               → "?"
//
//   2. Top-bar SELF-avatar is always static --amber (you know it's you).
//      Every OTHER avatar (admin lists, attribution rows, comment
//      authors) is colored deterministically from the user id so the
//      same person gets the same color across the app.
//
// We deliberately do NOT render the Google profile picture anywhere.
// Initials-only is the platform standard; the source of truth for the
// initials is users.display_name (editable in Profile, falls back to
// Google's name on signup).

const COLOR_PALETTE = [
  'var(--amber)',
  'var(--red)',
  'var(--green)',
  'var(--blue)',
  '#A78BFA', // violet
  '#22D3EE', // cyan
  '#EC4899', // pink
  '#FBBF24', // yellow
] as const;

export function parseInitials(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string {
  if (displayName && displayName.trim()) {
    const parts = displayName.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0]!;
      const last = parts[parts.length - 1]!;
      return (first[0]! + last[0]!).toUpperCase();
    }
    if (parts.length === 1) {
      return parts[0]![0]!.toUpperCase();
    }
  }
  if (email) {
    const local = email.split('@')[0];
    if (local && local.length > 0) return local[0]!.toUpperCase();
  }
  return '?';
}

/**
 * Deterministic color for non-self avatars (admin user lists,
 * attribution rows). Same user id → same color across every page.
 *
 * Hash is intentionally simple — we just need a stable spread across
 * the palette, not cryptographic uniformity.
 */
export function colorForUserId(userId: string | null | undefined): string {
  if (!userId) return COLOR_PALETTE[0]!;
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[hash % COLOR_PALETTE.length]!;
}

/** Static self-avatar color — top-bar pill, current-user indicators. */
export const SELF_AVATAR_COLOR = 'var(--amber)';
