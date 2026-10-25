#!/usr/bin/env python3
"""Generate the extension icons with only the Python standard library.

Design: teal rounded square with a white ring and a diagonal bar ("blocked").
Run from the repository root:  python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor for smooth edges

TEAL = (15, 118, 110)
WHITE = (255, 255, 255)


def coverage(x, y, size):
    """Return (r, g, b, a) for the normalised point (x, y) in [0, 1]."""
    # Rounded-square background.
    r = 0.22
    dx = max(abs(x - 0.5) - (0.5 - r), 0)
    dy = max(abs(y - 0.5) - (0.5 - r), 0)
    if math.hypot(dx, dy) > r:
        return (0, 0, 0, 0)

    cx, cy = 0.5, 0.5
    dist = math.hypot(x - cx, y - cy)
    ring_outer, ring_inner = 0.33, 0.24
    in_ring = ring_inner <= dist <= ring_outer

    # Diagonal bar from top-left to bottom-right, clipped to the ring's disc.
    along = ((x - cx) + (y - cy)) / math.sqrt(2)
    across = ((x - cx) - (y - cy)) / math.sqrt(2)
    in_bar = abs(across) <= 0.045 and abs(along) <= ring_outer

    if in_ring or in_bar:
        return WHITE + (255,)
    return TEAL + (255,)


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter type 0
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    r, g, b, a = coverage(x, y, size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = SS * SS
            alpha = acc[3] / n
            if acc[3] == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(
                    (
                        round(acc[0] / acc[3]),
                        round(acc[1] / acc[3]),
                        round(acc[2] / acc[3]),
                        round(alpha),
                    )
                )
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, size):
    raw = render(size)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        target = os.path.join(OUT, f"icon{s}.png")
        write_png(target, s)
        print("wrote", os.path.normpath(target))
