"""Generate the PWA icons in web/icons (blue disc with a white chevron, like the favicon).

Usage: python tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
BLUE = (37, 99, 235, 255)


def icon(size, maskable=False):
    s = 4  # supersample for smooth edges
    n = size * s
    img = Image.new("RGBA", (n, n), BLUE if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not maskable:
        d.ellipse([n * 0.03, n * 0.03, n * 0.97, n * 0.97], fill=BLUE)
    # Maskable icons keep content inside the central 80% safe zone
    k = 0.8 if maskable else 1.0
    pts = [(0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k) for x, y in [(0.28, 0.64), (0.5, 0.27), (0.72, 0.64)]]
    d.line([(x * n, y * n) for x, y in pts], fill="white", width=int(n * 0.09 * k), joint="curve")
    for x, y in (pts[0], pts[2]):  # round line caps
        r = n * 0.045 * k
        d.ellipse([x * n - r, y * n - r, x * n + r, y * n + r], fill="white")
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192).save(OUT / "icon-192.png")
    icon(512).save(OUT / "icon-512.png")
    icon(512, maskable=True).save(OUT / "maskable-512.png")
    icon(180, maskable=True).convert("RGB").save(OUT / "apple-touch-icon.png")
    print(sorted(p.name for p in OUT.iterdir()))
