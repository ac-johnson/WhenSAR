"""Phone gesture check: swipe between cards, scroll a card, swipe down to collapse.

Uses CDP touch events, which Chrome turns into real scrolling (synthetic DOM TouchEvents don't).
Usage: python tests/phone_gestures.py "http://localhost:8765/#34.05,-118.25"
"""

import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--enable-unsafe-swiftshader"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(url); pg.wait_for_selector(".card"); pg.wait_for_function("document.querySelectorAll('.card').length > 1", timeout=30000); pg.wait_for_timeout(1500)
    cdp = ctx.new_cdp_session(pg)
    def drag(x0, y0, x1, y1, steps=12):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / steps, "y": y0 + (y1 - y0) * i / steps}]})
            pg.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        pg.wait_for_timeout(900)
    drag(330, 650, 60, 655)
    print("swipe left  -> pager", pg.locator("#pos").inner_text(), "| scrollLeft", pg.evaluate("cards.scrollLeft"))
    drag(60, 650, 330, 655)
    print("swipe right -> pager", pg.locator("#pos").inner_text())
    drag(200, 750, 205, 450)
    print("scroll up in card -> scrollTop", pg.evaluate("document.querySelector('.card').scrollTop"))
    pg.evaluate("document.querySelectorAll('.card').forEach(c => c.scrollTop = 0)")
    drag(200, 450, 205, 700)
    print("swipe down at top -> collapsed:", pg.evaluate("panel.classList.contains('collapsed')"))
