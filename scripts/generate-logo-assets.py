#!/usr/bin/env python3
"""
generate-logo-assets.py — Averrow brand asset suite generator

Reads the master SVG (packages/averrow-worker/public/favicon.svg) and
emits the full set of derived logo assets used across the platform:

  • Favicons (16, 32, 48 PNG + multi-res .ico)
  • Apple touch icon (180 PNG)
  • PWA icons (192, 512 PNG — keeps the existing icon-192.svg /
    icon-512.svg as the manifest references but PNG fallbacks
    cover legacy clients)
  • Email logo (144 PNG — referenced by abuse-mailbox-responder.ts)
  • General-purpose PNG sizes (64, 128, 256, 1024)
  • Social-media squares (400, 800, 1500) on the brand dark
    background with margin matching app-icon guidelines
  • Open Graph / link preview (1200×630) — centred mark on dark
    background, "Averrow" wordmark below in platform red

Run:
  python3 scripts/generate-logo-assets.py

Output:
  packages/averrow-worker/public/brand/  (all generated PNGs + .ico)
  packages/averrow-worker/public/logo-email.png  (kept in root for the
    averrow.com URL referenced by Resend HTML)

Re-run anytime the master favicon.svg changes — the script is
idempotent, overwrites in place, and the operation is fast enough
to belong in a pre-deploy step.
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "packages/averrow-worker/public/favicon.svg"
# Mark-only variant (no rounded-square background) — used in the
# email template so Gmail Android dark mode has no dark pixels to
# trip its per-image color-inversion heuristic. See PR-BB.
SRC_MARK = ROOT / "packages/averrow-worker/public/favicon-mark.svg"
OUT = ROOT / "packages/averrow-worker/public/brand"
OUT_LEGACY_EMAIL = ROOT / "packages/averrow-worker/public/logo-email.png"
OUT_EMAIL_MARK = ROOT / "packages/averrow-worker/public/logo-email-mark.png"

# Brand colours — keep in sync with AVERROW_UI_STANDARD.md / favicon.svg
BG_DARK = (8, 14, 24)        # #080E18 — favicon background
BG_DARK_PAGE = (6, 10, 20)   # #060A14 — platform --bg-page
RED = (200, 60, 60)          # #C83C3C — Avro Arrow + brand red

# Square / general PNG sizes (rendered straight from the SVG, no compositing)
PLAIN_SIZES = [16, 32, 48, 64, 128, 144, 180, 192, 256, 512, 1024]

# Square social tiles — mark centred on dark background with breathing room
SOCIAL_SQUARE_SIZES = [400, 800, 1500]

# OG / link-preview wide format
OG_W, OG_H = 1200, 630


def render_svg_to_png(size: int, src: Path = SRC) -> Image.Image:
  """Render an SVG at NxN as an RGBA PIL image."""
  png_bytes = cairosvg.svg2png(
    url=str(src),
    output_width=size,
    output_height=size,
  )
  if not png_bytes:
    raise RuntimeError(f"cairosvg returned empty bytes at size={size}")
  return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def write_plain_sizes() -> None:
  for s in PLAIN_SIZES:
    path = OUT / f"averrow-{s}.png"
    img = render_svg_to_png(s)
    img.save(path, "PNG", optimize=True)
    print(f"  ok  {path.relative_to(ROOT)}  ({path.stat().st_size:,} B)")


def write_email_logo() -> None:
  """Email logo lives at /logo-email.png so the URL stays stable
  (referenced by abuse-mailbox-responder.ts via averrow.com/logo-email.png).
  Render at 144 for retina sharpness when displayed at 38px.

  Kept around for historical clients and any external integrations
  that hot-link the URL — the live email template (PR-BB and later)
  uses the mark-only variant below.
  """
  img = render_svg_to_png(144)
  img.save(OUT_LEGACY_EMAIL, "PNG", optimize=True)
  print(f"  ok  {OUT_LEGACY_EMAIL.relative_to(ROOT)}  ({OUT_LEGACY_EMAIL.stat().st_size:,} B)")


def write_email_logo_mark() -> None:
  """Mark-only email logo — no rounded-square tile, no dark pixels.
  Renders the red Avro Arrow on transparent so Gmail Android dark
  mode's per-image color-inversion heuristic finds nothing dark
  to flip. The parent TD's locked dark-navy background provides
  the visible tile. See abuse-mailbox-responder.ts comment on
  logoCell + the favicon-mark.svg source."""
  if not SRC_MARK.exists():
    print(f"  skip  {OUT_EMAIL_MARK.relative_to(ROOT)} (source missing: {SRC_MARK.relative_to(ROOT)})")
    return
  img = render_svg_to_png(144, src=SRC_MARK)
  img.save(OUT_EMAIL_MARK, "PNG", optimize=True)
  print(f"  ok  {OUT_EMAIL_MARK.relative_to(ROOT)}  ({OUT_EMAIL_MARK.stat().st_size:,} B)")


def write_favicon_ico() -> None:
  """Multi-res .ico bundles 16/32/48 — what browsers + Windows pick from."""
  ico_path = OUT / "favicon.ico"
  imgs = [render_svg_to_png(s) for s in (16, 32, 48)]
  imgs[0].save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
  print(f"  ok  {ico_path.relative_to(ROOT)}  ({ico_path.stat().st_size:,} B)")


def write_social_squares() -> None:
  """Centre the mark on a dark canvas with ~15% margin (Apple App Store /
  general social guideline). The favicon SVG already includes its own
  rounded-square dark background, so we render it large and let the
  full canvas show — equivalent of presenting it as an app icon."""
  for s in SOCIAL_SQUARE_SIZES:
    canvas = Image.new("RGBA", (s, s), BG_DARK_PAGE + (255,))
    inner = int(s * 0.78)  # ~11% margin each side
    mark = render_svg_to_png(inner)
    pos = ((s - inner) // 2, (s - inner) // 2)
    canvas.alpha_composite(mark, dest=pos)
    path = OUT / f"averrow-social-{s}.png"
    canvas.convert("RGB").save(path, "PNG", optimize=True)
    print(f"  ok  {path.relative_to(ROOT)}  ({path.stat().st_size:,} B)")


def write_og_image() -> None:
  """1200×630 link preview: mark on the left, wordmark + tagline on the right.
  Pure pixel composition — no font dep, just the mark + simple typography
  via the SVG. The wordmark text is baked in as a separate small SVG so
  we don't need a font installed."""
  canvas = Image.new("RGBA", (OG_W, OG_H), BG_DARK_PAGE + (255,))
  mark_size = 360
  mark = render_svg_to_png(mark_size)
  mark_x = 140
  mark_y = (OG_H - mark_size) // 2
  canvas.alpha_composite(mark, dest=(mark_x, mark_y))

  # Wordmark — render as SVG so we don't depend on a system font.
  wordmark_svg = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 200">
    <style>
      .word { font: 800 130px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #FFFFFF; letter-spacing: -3px; }
      .tag  { font: 700 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #E5A832; letter-spacing: 6px; }
    </style>
    <text x="0" y="120" class="word">Averrow</text>
    <text x="6" y="170" class="tag">THREAT INTELLIGENCE</text>
  </svg>"""
  word_png = cairosvg.svg2png(bytestring=wordmark_svg, output_width=700, output_height=200)
  if word_png:
    word_img = Image.open(io.BytesIO(word_png)).convert("RGBA")
    word_x = mark_x + mark_size + 60
    word_y = (OG_H - 200) // 2
    canvas.alpha_composite(word_img, dest=(word_x, word_y))

  # Subtle bottom-edge red rule for brand accent
  rule = Image.new("RGBA", (OG_W, 6), RED + (255,))
  canvas.alpha_composite(rule, dest=(0, OG_H - 6))

  path = OUT / "averrow-og.png"
  canvas.convert("RGB").save(path, "PNG", optimize=True, quality=92)
  print(f"  ok  {path.relative_to(ROOT)}  ({path.stat().st_size:,} B)")


def main() -> int:
  if not SRC.exists():
    print(f"ERROR: master SVG not found at {SRC}", file=sys.stderr)
    return 1
  OUT.mkdir(parents=True, exist_ok=True)

  print(f"src: {SRC.relative_to(ROOT)}")
  print(f"out: {OUT.relative_to(ROOT)}/")
  print()
  print("Plain PNG sizes:")
  write_plain_sizes()
  print()
  print("Email logo (legacy tile variant /logo-email.png):")
  write_email_logo()
  print()
  print("Email logo (mark-only variant /logo-email-mark.png):")
  write_email_logo_mark()
  print()
  print("Favicon .ico (multi-res 16/32/48):")
  write_favicon_ico()
  print()
  print("Social squares:")
  write_social_squares()
  print()
  print("Open Graph (1200×630):")
  write_og_image()
  print()
  print("Done. Master SVG remains the source of truth.")
  return 0


if __name__ == "__main__":
  sys.exit(main())
