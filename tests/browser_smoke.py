"""Load the app at a few points in the system Chrome, print console output, and save screenshots.

Requires `python serve.py 8765` running and `pip install playwright` (uses installed Chrome).
Usage: python tests/browser_smoke.py [outdir]
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/"
POINTS = {
    "los_angeles": (34.05, -118.25),
    "pacific": (0.0, -150.0),
    "antarctica": (-77.85, 166.67),
}


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", args=["--enable-unsafe-swiftshader"])
        for name, (lat, lon) in POINTS.items():
            for label, viewport in [("desktop", {"width": 1280, "height": 860}), ("phone", {"width": 390, "height": 844})]:
                page = browser.new_page(viewport=viewport)
                page.on("console", lambda m, n=name: print(f"[{n}] console.{m.type}: {m.text}"))
                page.on("pageerror", lambda e, n=name: print(f"[{n}] PAGE ERROR: {e}"))
                page.goto(f"{BASE}#{lat},{lon}")
                page.wait_for_selector(".card", timeout=15000)
                page.wait_for_timeout(4000)  # history requests + map tiles
                path = out / f"{name}_{label}.png"
                page.screenshot(path=path)
                print(f"[{name}] {label}: {page.locator('.card').count()} cards -> {path}")
                page.close()
        browser.close()


if __name__ == "__main__":
    main()
