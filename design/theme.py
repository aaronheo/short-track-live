"""Design-file theming helpers.

  python3 theme.py fonts <project-dir>          swap Inter for the Apple system font stack
  python3 theme.py dark <project-dir> A B ...   write <A>Dark.dc.html etc. from the light files

Dark colors are mapped per CSS property, not by blanket inversion: a white card
background becomes a dark surface, while white text on a red LIVE pill stays white.
"""
import re
import sys
from pathlib import Path

SYSTEM = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, sans-serif"
FONT_SWAPS = [
    ("font-family: Inter, system-ui, sans-serif", f"font-family: {SYSTEM}"),
    ("font-family: Inter, sans-serif", f"font-family: {SYSTEM}"),
    ('font-family="Inter, sans-serif"', 'font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif"'),
]

BG = {  # background
    "#F3F6F9": "#0B0E12", "#FFFFFF": "#161B22", "#EEF2F5": "#232A33", "#DDE4EA": "#2A333D",
    "#E3E9EF": "#1F262E", "#E9EEF2": "#11161C", "#FCE8EB": "#3A1419", "#24364A": "#2E4258",
    "#E3ECFB": "#1D2B45",
}
FG = {  # color
    "#0D1B2A": "#F1F4F8", "#3A4652": "#C5CED8", "#23303C": "#D5DCE4", "#576574": "#97A3B0",
    "#46525E": "#B3BDC8", "#A50D26": "#FF8A98", "#1E47B8": "#7AA7FF", "#8A97A4": "#7D8996",
}
BORDER = {"#DDE4EA": "#2A333D", "#EEF2F5": "#232A33", "#8A97A4": "#5E6A77"}
SVG_ATTR = {  # stroke= / fill= on inline SVG
    "#8A97A4": "#6B7785", "#576574": "#97A3B0", "#EEF2F5": "#232A33", "#B9C2CB": "#4A5562",
    "#0D1B2A": "#F1F4F8", "#FFFFFF": "#161B22", "#2a78d6": "#3987e5", "#eb6834": "#d95926",
    "#A9B6C3": "#A9B6C3",
}
INK_FILL_BG = "#E6EBF0"   # solid dark chips (Q badges, selected chip) flip to light
HERO_BG = "#1B2A3C"       # the dark hero card stays dark, a step above the ground


def dark_style(style):
    props = [p.strip() for p in style.split(";") if p.strip()]
    kv = [p.split(":", 1) for p in props]
    kv = [[k.strip(), v.strip()] for k, v in kv]
    get = {k: v for k, v in kv}
    hero = get.get("background") == "#0D1B2A" and get.get("border-radius") == "20px"
    chip = get.get("background") == "#0D1B2A" and not hero
    raised = get.get("background") == "#FFFFFF" and "box-shadow" in get and "0 1px" in get["box-shadow"]
    out = []
    for k, v in kv:
        if k == "background":
            if hero:
                v = HERO_BG
            elif chip:
                v = INK_FILL_BG
            elif raised:
                v = "#3A4552"
            else:
                v = BG.get(v, v)
        elif k == "color":
            v = "#0B0E12" if chip and v == "#FFFFFF" else FG.get(v, v)
        elif k.startswith("border"):
            for a, b in BORDER.items():
                v = v.replace(a, b)
        elif k == "box-shadow":
            v = v.replace("rgba(13, 27, 42, 0.12)", "rgba(255, 255, 255, 0.18)")
            if raised:
                v = "none"
            v = v.replace("0 0 0 2px #C8102E", "0 0 0 2px #E5293F")
        out.append(f"{k}: {v}")
    return "; ".join(out)


def to_dark(src, links):
    src = re.sub(r'style="([^"]*)"', lambda m: f'style="{dark_style(m.group(1))}"', src)
    src = re.sub(r'(stroke|fill)="(#[0-9A-Fa-f]{6})"', lambda m: f'{m.group(1)}="{SVG_ATTR.get(m.group(2), m.group(2))}"', src)
    src = src.replace("a{color:#1E47B8}a:hover{color:#163A99}", "a{color:#7AA7FF}a:hover{color:#A3C2FF}")
    src = re.sub(r"<title>(.*?)</title>", r"<title>\1 (dark)</title>", src, count=1)
    for light, dark in links.items():
        src = src.replace(f'href="{light}"', f'href="{dark}"')
    return src


def main():
    cmd, project, *names = sys.argv[1:]
    root = Path(project)
    if cmd == "fonts":
        for p in sorted(root.glob("*.dc.html")):
            s = p.read_text()
            new = s
            for a, b in FONT_SWAPS:
                new = new.replace(a, b)
            if new != s:
                p.write_text(new)
                print("fonts:", p.name)
    elif cmd == "dark":
        links = {f"{n}.dc.html": f"{n}Dark.dc.html" for n in names}
        for n in names:
            out = root / f"{n}Dark.dc.html"
            out.write_text(to_dark((root / f"{n}.dc.html").read_text(), links))
            print("dark:", out.name)


if __name__ == "__main__":
    main()
