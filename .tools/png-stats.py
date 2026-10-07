#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
png-stats.py —— 纯标准库的 PNG 像素统计，专门用来**客观判定"是不是白屏"**。

为什么不用 PIL：本机隔离环境里没装 Pillow，而这条判据是每次改布局后都要跑的回归项，
不值得为它引入依赖。Chrome 截图固定是 8bit、非隔行、RGB 或 RGBA，未滤波五种模式全实现即可。

用法:
  python .tools/png-stats.py <png> [--region x,y,w,h]

输出 JSON：
  near_white_ratio     接近纯白的像素占比（>=250 三通道）—— 白屏时接近 1.0
  distinct_colors      采样到的不同颜色数（纯色块时只有 1~2 个）
  ink_ratio            非背景像素占比（背景取四角众数色）
"""
import json
import struct
import sys
import zlib
from collections import Counter


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    pos = 8
    idat = b""
    w = h = bitdepth = colortype = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            w, h, bitdepth, colortype, comp, filt, interlace = struct.unpack(">IIBBBBB", chunk)
            assert bitdepth == 8, f"仅支持 8bit，实际 {bitdepth}"
            assert interlace == 0, "不支持隔行扫描"
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(idat)
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colortype]
    stride = w * channels
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p : p + stride])
        p += stride
        if f == 0:
            pass
        elif f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return w, h, channels, out


def stats(path, region=None):
    w, h, ch, px = read_png(path)
    x0, y0, rw, rh = region if region else (0, 0, w, h)
    x1, y1 = min(x0 + rw, w), min(y0 + rh, h)
    total = 0
    near_white = 0
    colors = Counter()
    for y in range(y0, y1):
        row = y * w * ch
        for x in range(x0, x1):
            i = row + x * ch
            r, g, b = px[i], px[i + 1], px[i + 2]
            total += 1
            if r >= 250 and g >= 250 and b >= 250:
                near_white += 1
            colors[(r >> 4, g >> 4, b >> 4)] += 1
    # 背景色 = 四角 3x3 的众数
    corners = []
    for cx, cy in ((x0, y0), (x1 - 1, y0), (x0, y1 - 1), (x1 - 1, y1 - 1)):
        for dx in range(-1, 2):
            for dy in range(-1, 2):
                xx, yy = min(max(cx + dx, 0), w - 1), min(max(cy + dy, 0), h - 1)
                i = yy * w * ch + xx * ch
                corners.append((px[i] >> 4, px[i + 1] >> 4, px[i + 2] >> 4))
    bg = Counter(corners).most_common(1)[0][0] if corners else (15, 15, 15)
    ink = sum(c for k, c in colors.items() if max(abs(k[0] - bg[0]), abs(k[1] - bg[1]), abs(k[2] - bg[2])) > 1)
    return {
        "file": path,
        "size": f"{w}x{h}",
        "region": f"{x0},{y0},{x1 - x0},{y1 - y0}",
        "near_white_ratio": round(near_white / total, 4),
        "distinct_colors": len(colors),
        "ink_ratio": round(ink / total, 4),
        "verdict": "WHITE-SCREEN" if near_white / total > 0.985 and len(colors) <= 3 else "has-content",
    }


if __name__ == "__main__":
    path = sys.argv[1]
    region = None
    if "--region" in sys.argv:
        region = tuple(int(v) for v in sys.argv[sys.argv.index("--region") + 1].split(","))
    print(json.dumps(stats(path, region), ensure_ascii=False, indent=2))
