"""Render small monochrome contact icons (email / phone / LinkedIn / GitHub) to PNG.

The resume builder embeds these inline before each contact line in the generated
.docx header so the output matches the live preview. Icons are described as SVG
path data on a 24x24 grid and rasterised with Pillow:

* ``fill`` icons (LinkedIn, GitHub) use the even-odd rule via XOR of per-subpath
  masks, so interior cut-outs (the LinkedIn "in", the GitHub octocat eyes) render
  correctly.
* ``stroke`` icons (email envelope, phone handset) trace each subpath as a thick
  rounded polyline.

Everything is supersampled and downscaled with LANCZOS for crisp antialiased edges,
then tinted to the requested color. Results are cached per (kind, color, size).
"""

from __future__ import annotations

import math
import re
from functools import lru_cache
from io import BytesIO

try:  # Pillow is optional - contact icons degrade to text-only if it is absent.
    from PIL import Image, ImageChops, ImageDraw

    _PIL_AVAILABLE = True
except Exception:  # pragma: no cover - import guard
    Image = ImageChops = ImageDraw = None  # type: ignore[assignment]
    _PIL_AVAILABLE = False

# 24x24 viewBox path data.
_ICONS: dict[str, dict[str, object]] = {
    "email": {
        "mode": "stroke",
        "paths": [
            "M2.5 4.5h17a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 0 17V7a2.5 2.5 0 0 1 2.5-2.5z",
            "M1.5 6 12 13.2 22.5 6",
        ],
    },
    "phone": {
        "mode": "stroke",
        "paths": [
            "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
        ],
    },
    "linkedin": {
        "mode": "fill",
        "paths": [
            "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z",
        ],
    },
    "github": {
        "mode": "fill",
        "paths": [
            "M12 .3a12 12 0 0 0-3.8 23.4c.6.1.82-.26.82-.58l-.01-2.04c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.22.69.82.57A12 12 0 0 0 12 .3z",
        ],
    },
}

_NUM_RE = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


class _Scanner:
    """Minimal SVG path-data scanner that understands the arc-flag glue quirk."""

    def __init__(self, data: str) -> None:
        self.s = data
        self.i = 0
        self.n = len(data)

    def _skip_sep(self) -> None:
        while self.i < self.n and self.s[self.i] in " ,\t\n\r":
            self.i += 1

    def at_end(self) -> bool:
        self._skip_sep()
        return self.i >= self.n

    def read_command(self) -> str | None:
        self._skip_sep()
        if self.i < self.n and self.s[self.i] in "MmLlHhVvCcSsQqTtAaZz":
            cmd = self.s[self.i]
            self.i += 1
            return cmd
        return None

    def read_number(self) -> float | None:
        self._skip_sep()
        m = _NUM_RE.match(self.s, self.i)
        if not m or m.group() in ("", "+", "-", "."):
            return None
        self.i = m.end()
        return float(m.group())

    def read_flag(self) -> int:
        self._skip_sep()
        if self.i < self.n and self.s[self.i] in "01":
            f = int(self.s[self.i])
            self.i += 1
            return f
        v = self.read_number()
        return int(v) if v is not None else 0


def _arc_to_points(
    x1: float, y1: float, rx: float, ry: float, phi_deg: float,
    large_arc: int, sweep: int, x2: float, y2: float,
) -> list[tuple[float, float]]:
    """Flatten an elliptical arc (SVG endpoint parametrisation) into line points."""
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return [(x2, y2)]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi_deg % 360)
    cos_p, sin_p = math.cos(phi), math.sin(phi)
    dx2 = (x1 - x2) / 2.0
    dy2 = (y1 - y2) / 2.0
    x1p = cos_p * dx2 + sin_p * dy2
    y1p = -sin_p * dx2 + cos_p * dy2
    # Correct out-of-range radii.
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1:
        s = math.sqrt(lam)
        rx *= s
        ry *= s
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = math.sqrt(max(num / den, 0.0)) if den else 0.0
    if large_arc == sweep:
        coef = -coef
    cxp = coef * (rx * y1p) / ry
    cyp = -coef * (ry * x1p) / rx
    cx = cos_p * cxp - sin_p * cyp + (x1 + x2) / 2.0
    cy = sin_p * cxp + cos_p * cyp + (y1 + y2) / 2.0

    def angle(ux: float, uy: float, vx: float, vy: float) -> float:
        dot = ux * vx + uy * vy
        mag = math.hypot(ux, uy) * math.hypot(vx, vy)
        a = math.acos(max(-1.0, min(1.0, dot / mag))) if mag else 0.0
        if ux * vy - uy * vx < 0:
            a = -a
        return a

    theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dtheta > 0:
        dtheta -= 2 * math.pi
    elif sweep and dtheta < 0:
        dtheta += 2 * math.pi

    steps = max(2, int(abs(dtheta) / (math.pi / 24)) + 1)
    pts: list[tuple[float, float]] = []
    for k in range(1, steps + 1):
        t = theta1 + dtheta * (k / steps)
        px = cos_p * rx * math.cos(t) - sin_p * ry * math.sin(t) + cx
        py = sin_p * rx * math.cos(t) + cos_p * ry * math.sin(t) + cy
        pts.append((px, py))
    return pts


def _cubic(p0, p1, p2, p3, steps=18) -> list[tuple[float, float]]:
    out = []
    for k in range(1, steps + 1):
        t = k / steps
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        out.append((x, y))
    return out


def _quad(p0, p1, p2, steps=16) -> list[tuple[float, float]]:
    out = []
    for k in range(1, steps + 1):
        t = k / steps
        mt = 1 - t
        x = mt**2 * p0[0] + 2 * mt * t * p1[0] + t**2 * p2[0]
        y = mt**2 * p0[1] + 2 * mt * t * p1[1] + t**2 * p2[1]
        out.append((x, y))
    return out


def _parse_path(data: str) -> list[list[tuple[float, float]]]:
    """Return a list of subpaths, each a list of (x, y) points in viewBox units."""
    sc = _Scanner(data)
    subpaths: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    cx = cy = sx = sy = 0.0
    cmd: str | None = None
    prev_cubic: tuple[float, float] | None = None
    prev_quad: tuple[float, float] | None = None

    def start_subpath() -> None:
        nonlocal cur
        if len(cur) > 1:
            subpaths.append(cur)
        cur = []

    while not sc.at_end():
        c = sc.read_command()
        if c is not None:
            cmd = c
        elif cmd is None:
            break
        else:
            # Implicit repeat: after M/m subsequent pairs are L/l.
            if cmd == "M":
                cmd = "L"
            elif cmd == "m":
                cmd = "l"

        if cmd in ("M", "m"):
            x = sc.read_number()
            y = sc.read_number()
            if x is None or y is None:
                break
            if cmd == "m":
                x += cx
                y += cy
            start_subpath()
            cx, cy = x, y
            sx, sy = x, y
            cur = [(cx, cy)]
            prev_cubic = prev_quad = None
        elif cmd in ("L", "l"):
            x = sc.read_number()
            y = sc.read_number()
            if x is None or y is None:
                break
            if cmd == "l":
                x += cx
                y += cy
            cx, cy = x, y
            cur.append((cx, cy))
            prev_cubic = prev_quad = None
        elif cmd in ("H", "h"):
            x = sc.read_number()
            if x is None:
                break
            cx = x + cx if cmd == "h" else x
            cur.append((cx, cy))
            prev_cubic = prev_quad = None
        elif cmd in ("V", "v"):
            y = sc.read_number()
            if y is None:
                break
            cy = y + cy if cmd == "v" else y
            cur.append((cx, cy))
            prev_cubic = prev_quad = None
        elif cmd in ("C", "c", "S", "s"):
            if cmd in ("C", "c"):
                x1 = sc.read_number(); y1 = sc.read_number()
                x2 = sc.read_number(); y2 = sc.read_number()
                x = sc.read_number(); y = sc.read_number()
                if None in (x1, y1, x2, y2, x, y):
                    break
                if cmd == "c":
                    x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy
            else:
                x2 = sc.read_number(); y2 = sc.read_number()
                x = sc.read_number(); y = sc.read_number()
                if None in (x2, y2, x, y):
                    break
                if cmd == "s":
                    x2 += cx; y2 += cy; x += cx; y += cy
                if prev_cubic is not None:
                    x1 = 2 * cx - prev_cubic[0]
                    y1 = 2 * cy - prev_cubic[1]
                else:
                    x1, y1 = cx, cy
            cur.extend(_cubic((cx, cy), (x1, y1), (x2, y2), (x, y)))
            prev_cubic = (x2, y2)
            prev_quad = None
            cx, cy = x, y
        elif cmd in ("Q", "q", "T", "t"):
            if cmd in ("Q", "q"):
                x1 = sc.read_number(); y1 = sc.read_number()
                x = sc.read_number(); y = sc.read_number()
                if None in (x1, y1, x, y):
                    break
                if cmd == "q":
                    x1 += cx; y1 += cy; x += cx; y += cy
            else:
                x = sc.read_number(); y = sc.read_number()
                if None in (x, y):
                    break
                if cmd == "t":
                    x += cx; y += cy
                if prev_quad is not None:
                    x1 = 2 * cx - prev_quad[0]
                    y1 = 2 * cy - prev_quad[1]
                else:
                    x1, y1 = cx, cy
            cur.extend(_quad((cx, cy), (x1, y1), (x, y)))
            prev_quad = (x1, y1)
            prev_cubic = None
            cx, cy = x, y
        elif cmd in ("A", "a"):
            rx = sc.read_number(); ry = sc.read_number(); rot = sc.read_number()
            large = sc.read_flag(); sweep = sc.read_flag()
            x = sc.read_number(); y = sc.read_number()
            if None in (rx, ry, rot, x, y):
                break
            if cmd == "a":
                x += cx; y += cy
            cur.extend(_arc_to_points(cx, cy, rx, ry, rot, large, sweep, x, y))
            cx, cy = x, y
            prev_cubic = prev_quad = None
        elif cmd in ("Z", "z"):
            if cur:
                cur.append((sx, sy))
            cx, cy = sx, sy
            start_subpath()
            prev_cubic = prev_quad = None

    if len(cur) > 1:
        subpaths.append(cur)
    return subpaths


def _rgb(color_hex: str) -> tuple[int, int, int]:
    v = (color_hex or "#000000").lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    try:
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except Exception:
        return 0x33, 0x41, 0x55


@lru_cache(maxsize=128)
def contact_icon_png(kind: str, color_hex: str, variant: str = "brand", px: int = 96) -> bytes | None:
    """Return PNG bytes for *kind* tinted to *color_hex*, or ``None`` if unknown.

    ``variant`` is ``"brand"`` (filled LinkedIn / GitHub marks) or ``"outline"``
    (line versions). Email / phone are always line icons.
    """
    if not _PIL_AVAILABLE:
        return None
    spec = _ICONS.get(kind)
    if spec is None:
        return None
    ss = 4
    size = px * ss
    scale = size / 24.0
    color = _rgb(color_hex)

    mode = spec["mode"]
    if variant == "outline" and kind in ("linkedin", "github"):
        mode = "stroke"

    paths: list[list[tuple[float, float]]] = []
    for d in spec["paths"]:  # type: ignore[index]
        for sub in _parse_path(d):  # type: ignore[arg-type]
            paths.append([(x * scale, y * scale) for (x, y) in sub])

    if mode == "fill":
        # Even-odd fill = XOR of each subpath's solid mask.
        acc = Image.new("1", (size, size), 0)
        for sub in paths:
            if len(sub) < 3:
                continue
            m = Image.new("1", (size, size), 0)
            ImageDraw.Draw(m).polygon(sub, fill=1)
            acc = ImageChops.logical_xor(acc, m)
        mask = acc.convert("L")
    else:
        mask = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(mask)
        # Thinner stroke for the detailed brand outlines than for the simple glyphs.
        rel = 0.058 if (variant == "outline" and kind in ("linkedin", "github")) else 0.085
        w = max(2, int(round(size * rel)))
        r = w / 2.0
        for sub in paths:
            if len(sub) >= 2:
                draw.line(sub, fill=255, width=w, joint="curve")
                for (px_, py_) in (sub[0], sub[-1]):
                    draw.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill=255)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    solid = Image.new("RGBA", (size, size), (*color, 255))
    out.paste(solid, mask=mask)
    out = out.resize((px, px), Image.LANCZOS)

    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()
