#!/usr/bin/env python3
"""GREYS Studio "Board Size Comparison" (boxes & boards size guide): layer graphics + layout.

Writes the separate pictures the design's layers use, in studio/graphics/size-guide/:
  six boxes/boards without cheese, four standing wedges (wedge-1..4) and the Mini's rind-end piece,
and out/spec.json, the element list build.js turns into a studio_designs row.

Everything is drawn to one scale (14 design px per inch). A wedge is the same amount of cheese
everywhere: Custom Board = one group of 4, Large = two groups, Extra Large = three groups,
Gathering = 3, Demi = 15/16 of a wedge, Mini = the rind end of a wedge holding 3/8 of one.
    python3 make_graphics.py
"""
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
GFX_DIR = os.path.join(REPO, "studio", "graphics", "size-guide")
GFX_URL = "/studio/graphics/size-guide/"
OUT = os.path.join(HERE, "out")

S = 14.0          # design px per inch
SF = 28.0         # px per inch for the files' own size (2x, so bigger downloads stay sharp)
M = 0.45          # margin around each box/board picture for its shadow, inches
R = 4.6           # wedge length, point to rind, inches
RIND = 0.38       # rind band along the bottom of each wedge
UNIT = 30.0       # wedge angle, degrees
GAP = 0.12        # between wedges in a group, inches
ROW_GAP = 1.2     # between groups, inches
UP0, UP1 = 90 - UNIT / 2, 90 + UNIT / 2   # standing: point up, rind down
HALF = math.radians(UNIT / 2)
PAD = 0.05        # around a wedge picture (its outline); the shadow offset is added right/bottom
SHX, SHY = 0.06, 0.12

COL = {
    "paste": "#EDBE4C", "rind": "#C48E2B", "hole": "#D4A136", "outline": "#8F6417",
    "wood_edge": "#8B5730", "wood_face": "#B57B4B", "grain_dark": "#93603A",
    "grain_light": "#CF9963", "wood_hi": "#D9A570", "wood_outline": "#6E4322",
    "kraft_rim": "#D3AB78", "kraft_outline": "#8C6338", "wall_top": "#A07443",
    "wall_left": "#AA7E4C", "wall_right": "#C49862", "wall_bottom": "#CBA06B",
    "liner": "#F3EBDD",
}
HOLES = [
    [(0.42, 0.52, 0.17), (0.64, 0.30, 0.27), (0.80, 0.70, 0.22)],
    [(0.48, 0.35, 0.20), (0.70, 0.68, 0.26), (0.84, 0.28, 0.16)],
    [(0.38, 0.60, 0.15), (0.58, 0.40, 0.24), (0.78, 0.62, 0.28)],
]

# page
PAGE_W, PAGE_H = 1220, 728
EDGE = 48                       # page margin
INNER = PAGE_W - 2 * EDGE       # 1124
NAVY, GOLD, WHITE = "#06273A", "#E6B33C", "#FFFFFF"
DIM_LINE = "#7D8E99"            # about 50% white on navy, solid so it can't double up at the ticks
RULE = "#375261"                # about 20% white on navy
DIM_TEXT = "#D7E1E9"
FONT = "Barlow Condensed"
HEAD_H, HEAD_GAP, SECTION_GAP = 18.0, 14.0, 36.0
DIM_BAND, DIM_GAP, CAP_GAP, CAP_H = 15.0, 6.0, 10.0, 26.4   # top dimension band, gaps, caption height
SIDE_GAP, SIDE_W = 6.0, 34.0                                 # side dimension column

rnd_ids = random.Random(20261115)


def uid(prefix):
    return prefix + "".join(rnd_ids.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(10))


def num(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "", "-") else s


def px(v):
    return round(v, 2)


def pol(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def hole_pattern(j):
    pat = HOLES[j % 3]
    if (j // 3) % 2:  # mirror every other run so neighbours differ
        pat = [(rf, 1 - tf, hr) for rf, tf, hr in pat]
    return pat


# ---------- cheese pieces (apex at ax, ay; inches) ----------
def wedge(ax, ay, r, holes, hs, file):
    return dict(kind="wedge", ax=ax, ay=ay, r=r, a0=UP0, a1=UP1, holes=holes, hs=hs, file=file, k=r / R)


def group_row(count, y=0.0, group=None):
    step = 2 * R * math.sin(HALF) + GAP
    return [dict(wedge(j * step, y, R, hole_pattern(j), 1.0, f"wedge-{j + 1}.svg"), group=group) for j in range(count)]


def groups_of_four(n):
    out = []
    for i in range(n):
        out += group_row(4, y=i * (R + ROW_GAP), group=i)
    return out


def part_wedge(fraction):
    r = R * math.sqrt(fraction)
    return [dict(wedge(0.0, 0.0, r, HOLES[1], r / R, "wedge-2.svg"), group=None)]


def rind_chunk(fraction):
    whole = math.pi * R * R * UNIT / 360
    cut = math.sqrt((1 - fraction) * whole / math.tan(HALF))
    return [dict(kind="chunk", ax=0.0, ay=0.0, r=R, a0=UP0, a1=UP1, cut=cut,
                 holes=[(0.85, 0.30, 0.12), (0.84, 0.70, 0.10)], hs=1.0, file="mini-piece.svg", k=1.0, group=None)]


def edge_pt(p, a, dist):
    return pol(p["ax"], p["ay"], dist, a)


def outline_pts(p):
    if p["kind"] == "chunk":
        d = p["cut"] / math.cos(HALF)
        pts = [edge_pt(p, p["a0"], d), edge_pt(p, p["a1"], d)]
    else:
        pts = [(p["ax"], p["ay"])]
    steps = int(round(p["a1"] - p["a0"]))
    for k in range(steps + 1):
        pts.append(pol(p["ax"], p["ay"], p["r"], p["a0"] + k))
    return pts


def piece_path(p, r):
    x0, y0 = pol(p["ax"], p["ay"], r, p["a0"])
    x1, y1 = pol(p["ax"], p["ay"], r, p["a1"])
    arc = f"A{num(r)} {num(r)} 0 0 1 {num(x1)} {num(y1)}"
    if p["kind"] == "chunk":
        d = p["cut"] / math.cos(HALF)
        c0x, c0y = edge_pt(p, p["a0"], d)
        c1x, c1y = edge_pt(p, p["a1"], d)
        return f"M{num(c0x)} {num(c0y)}L{num(x0)} {num(y0)}{arc}L{num(c1x)} {num(c1y)}Z"
    return f"M{num(p['ax'])} {num(p['ay'])}L{num(x0)} {num(y0)}{arc}Z"


def bbox(pieces):
    pts = [q for p in pieces for q in outline_pts(p)]
    xs = [q[0] for q in pts]
    ys = [q[1] for q in pts]
    return min(xs), min(ys), max(xs), max(ys)


def place(pieces, cx, cy, region, name):
    x0, y0, x1, y1 = bbox(pieces)
    dx = cx - (x0 + x1) / 2
    dy = cy - (y0 + y1) / 2
    rx0, ry0, rx1, ry1 = region
    gap = 0.12
    if not (x0 + dx >= rx0 + gap and x1 + dx <= rx1 - gap and y0 + dy >= ry0 + gap and y1 + dy <= ry1 - gap):
        raise SystemExit(f"{name}: cheese does not fit its surface")
    return [dict(p, ax=p["ax"] + dx, ay=p["ay"] + dy) for p in pieces]


def cheese_svg(pieces):
    out = []
    for p in pieces:
        sp = dict(p, ax=p["ax"] + SHX, ay=p["ay"] + SHY)
        out.append(f'<path d="{piece_path(sp, p["r"])}" fill="#000000" fill-opacity="0.24"/>')
    for p in pieces:
        full = piece_path(p, p["r"])
        out.append(f'<path d="{full}" fill="{COL["rind"]}"/>')
        out.append(f'<path d="{piece_path(p, p["r"] - RIND)}" fill="{COL["paste"]}"/>')
        for rf, tf, hr in p["holes"]:
            hx, hy = pol(p["ax"], p["ay"], rf * p["r"], p["a0"] + tf * (p["a1"] - p["a0"]))
            out.append(f'<circle cx="{num(hx)}" cy="{num(hy)}" r="{num(hr * p["hs"])}" fill="{COL["hole"]}"/>')
        out.append(f'<path d="{full}" fill="none" stroke="{COL["outline"]}" stroke-width="0.05" stroke-linejoin="round"/>')
    return out


def svg_open(vx, vy, vw, vh, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{num(vw * SF)}" height="{num(vh * SF)}" '
            f'viewBox="{num(vx)} {num(vy)} {num(vw)} {num(vh)}" role="img" aria-label="{label}"><title>{label}</title>')


# ---------- boxes and boards (no cheese) ----------
def grain(rnd, fx, fy, fw, fh):
    out = []
    count = max(6, round(fh / 0.62))
    flow_amp = rnd.uniform(0.18, 0.3)
    flow_lam = rnd.uniform(16, 26)
    flow_ph = rnd.uniform(0, 2 * math.pi)
    for i in range(count):
        base = fy + (i + 0.5) * fh / count + rnd.uniform(-0.08, 0.08)
        edge = min(base - fy, fy + fh - base)
        bend = math.sin(math.pi * (i + 0.5) / count)
        amp = rnd.uniform(0.03, 0.10)
        amp2 = rnd.uniform(0.01, 0.035)
        fa = flow_amp * bend
        room = edge - 0.16
        total = amp + amp2 + fa
        if total > room:
            k = max(room, 0.0) / total
            amp, amp2, fa = amp * k, amp2 * k, fa * k
        inset = 0.4 if edge > 0.9 else 0.95
        xa = fx + inset + rnd.uniform(0, 0.8)
        xb = fx + fw - inset - rnd.uniform(0, 0.8)
        pick = rnd.random()
        if pick < 0.22:
            length = rnd.uniform(3, min(9, xb - xa))
            s0 = rnd.uniform(xa, xb - length)
            segs = [(s0, s0 + length)]
        elif pick < 0.55 and xb - xa > 8:
            cut = rnd.uniform(xa + 3, xb - 3)
            g = rnd.uniform(0.6, 1.5)
            segs = [(xa, cut - g / 2), (cut + g / 2, xb)]
        else:
            segs = [(xa, xb)]
        lam = rnd.uniform(5, 11)
        ph = rnd.uniform(0, 2 * math.pi)
        lam2 = rnd.uniform(2.2, 4)
        ph2 = rnd.uniform(0, 2 * math.pi)
        light = rnd.random() < 0.3
        color = COL["grain_light"] if light else COL["grain_dark"]
        op = rnd.uniform(0.32, 0.45) if light else rnd.uniform(0.42, 0.62)
        sw = rnd.uniform(0.05, 0.08) if light else rnd.uniform(0.06, 0.11)
        for a, b in segs:
            steps = max(2, int((b - a) / 0.45))
            pts = []
            for k in range(steps + 1):
                x = a + (b - a) * k / steps
                y = (base + fa * math.sin(2 * math.pi * x / flow_lam + flow_ph)
                     + amp * math.sin(2 * math.pi * x / lam + ph)
                     + amp2 * math.sin(2 * math.pi * x / lam2 + ph2))
                pts.append(f"{num(x)} {num(y)}")
            d = "M" + pts[0] + "".join("L" + q for q in pts[1:])
            out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-opacity="{num(op)}" '
                       f'stroke-width="{num(sw)}" stroke-linecap="round" stroke-linejoin="round"/>')
    return out


def box_svg(w, h, d, label):
    parts = [svg_open(-M, -M, w + 2 * M, h + 2 * M, label)]
    parts.append(f'<rect x="0.12" y="0.24" width="{num(w)}" height="{num(h)}" rx="0.14" fill="#000000" fill-opacity="0.35"/>')
    parts.append(f'<rect x="0" y="0" width="{num(w)}" height="{num(h)}" rx="0.14" fill="{COL["kraft_rim"]}"/>')
    t = 0.1
    x0, y0, x1, y1 = t, t, w - t, h - t
    f0x, f0y, f1x, f1y = d, d, w - d, h - d

    def poly(pts, fill):
        return f'<polygon points="{" ".join(f"{num(x)},{num(y)}" for x, y in pts)}" fill="{fill}"/>'

    parts.append(poly([(x0, y0), (x1, y0), (f1x, f0y), (f0x, f0y)], COL["wall_top"]))
    parts.append(poly([(x0, y0), (f0x, f0y), (f0x, f1y), (x0, y1)], COL["wall_left"]))
    parts.append(poly([(x1, y0), (x1, y1), (f1x, f1y), (f1x, f0y)], COL["wall_right"]))
    parts.append(poly([(x0, y1), (f0x, f1y), (f1x, f1y), (x1, y1)], COL["wall_bottom"]))
    fw, fh = f1x - f0x, f1y - f0y
    parts.append(f'<rect x="{num(f0x)}" y="{num(f0y)}" width="{num(fw)}" height="{num(fh)}" fill="{COL["liner"]}"/>')
    parts.append(f'<rect x="{num(f0x)}" y="{num(f0y)}" width="{num(fw)}" height="0.16" fill="#000000" fill-opacity="0.08"/>')
    parts.append(f'<rect x="{num(f0x)}" y="{num(f0y + 0.16)}" width="0.12" height="{num(fh - 0.16)}" fill="#000000" fill-opacity="0.06"/>')
    parts.append(f'<rect x="{num(f0x)}" y="{num(f0y)}" width="{num(fw)}" height="{num(fh)}" fill="none" '
                 f'stroke="{COL["kraft_outline"]}" stroke-opacity="0.45" stroke-width="0.03"/>')
    parts.append(f'<rect x="0" y="0" width="{num(w)}" height="{num(h)}" rx="0.14" fill="none" stroke="{COL["kraft_outline"]}" stroke-width="0.04"/>')
    parts.append("</svg>")
    return "".join(parts), (f0x, f0y, f1x, f1y)


def board_svg(w, h, label, seed):
    rnd = random.Random(seed)
    rx = 0.75
    parts = [svg_open(-M, -M, w + 2 * M, h + 2 * M, label)]
    parts.append(f'<rect x="0.12" y="0.24" width="{num(w)}" height="{num(h)}" rx="{num(rx)}" fill="#000000" fill-opacity="0.35"/>')
    parts.append(f'<rect x="0" y="0" width="{num(w)}" height="{num(h)}" rx="{num(rx)}" fill="{COL["wood_edge"]}"/>')
    fi = 0.22
    fx, fy, fw, fh = fi, fi, w - 2 * fi, h - 2 * fi
    parts.append(f'<rect x="{num(fx)}" y="{num(fy)}" width="{num(fw)}" height="{num(fh)}" rx="0.56" fill="{COL["wood_face"]}"/>')
    parts += grain(rnd, fx, fy, fw, fh)
    parts.append(f'<path d="M{num(fx + 0.7)} {num(fy + 0.07)}H{num(fx + fw - 0.7)}" fill="none" stroke="{COL["wood_hi"]}" '
                 f'stroke-opacity="0.55" stroke-width="0.08" stroke-linecap="round"/>')
    parts.append(f'<rect x="0" y="0" width="{num(w)}" height="{num(h)}" rx="{num(rx)}" fill="none" stroke="{COL["wood_outline"]}" stroke-width="0.05"/>')
    parts.append("</svg>")
    return "".join(parts), (fx, fy, fx + fw, fy + fh)


def piece_file(p, label):
    x0, y0, x1, y1 = bbox([p])
    vb = (x0 - PAD, y0 - PAD, (x1 - x0) + 2 * PAD + SHX, (y1 - y0) + 2 * PAD + SHY)
    return svg_open(*vb, label) + "".join(cheese_svg([p])) + "</svg>", vb


# ---------- layout ----------
ITEMS = [
    dict(key="mini", name="Mini Box", kind="box", w=7, h=3, d=0.35, row=0, col=0, cheese=rind_chunk(3 / 8),
         alt="Mini box, 7 by 3 inches"),
    dict(key="demi", name="Demi Box", kind="box", w=9, h=7, d=0.5, row=0, col=1, cheese=part_wedge(7.5 / 8),
         alt="Demi box, 9 by 7 inches"),
    dict(key="gathering", name="Gathering Box", kind="box", w=14, h=10, d=0.6, row=0, col=2,
         cheese=[dict(p, group=0) for p in group_row(3)], alt="Gathering box, 14 by 10 inches"),
    dict(key="custom", name="Custom Board", kind="board", w=18, h=12, seed=11, row=1, col=0, cheese=groups_of_four(1),
         alt="Custom board, 18 by 12 inches"),
    dict(key="large", name="Large Board", kind="board", w=21, h=14, seed=23, row=1, col=1, cheese=groups_of_four(2),
         alt="Large board, 21 by 14 inches"),
    dict(key="xl", name="Extra Large Board", kind="board", w=26, h=18, seed=37, row=1, col=2, cheese=groups_of_four(3),
         alt="Extra Large board, 26 by 18 inches"),
]


def main():
    os.makedirs(GFX_DIR, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    # standing wedges + the Mini's piece, each its own picture (apex at 0,0)
    vbs = {}
    for j in range(4):
        svg, vb = piece_file(wedge(0, 0, R, hole_pattern(j), 1.0, ""), "Cheese wedge")
        name = f"wedge-{j + 1}.svg"
        open(os.path.join(GFX_DIR, name), "w").write(svg)
        vbs[name] = vb
    svg, vb = piece_file(rind_chunk(3 / 8)[0], "Piece of a cheese wedge")
    open(os.path.join(GFX_DIR, "mini-piece.svg"), "w").write(svg)
    vbs["mini-piece.svg"] = vb

    img = {}
    for it in ITEMS:
        it["img_w"] = (it["w"] + 2 * M) * S
        it["img_h"] = (it["h"] + 2 * M) * S
    slot_w = [ITEMS[3 + c]["img_w"] + SIDE_GAP + SIDE_W for c in range(3)]   # columns follow the boards
    gap = (INNER - sum(slot_w)) / 2
    slot_x = [EDGE, EDGE + slot_w[0] + gap, EDGE + slot_w[0] + slot_w[1] + 2 * gap]
    fig_h = lambda it: DIM_BAND + DIM_GAP + it["img_h"] + CAP_GAP + CAP_H
    head_y, img_bottom = [], []
    y = EDGE
    for row in (0, 1):
        head_y.append(y)
        top = y + HEAD_H + HEAD_GAP
        bottom = top + max(fig_h(it) for it in ITEMS if it["row"] == row)
        img_bottom.append(bottom - CAP_H - CAP_GAP)
        y = bottom + SECTION_GAP
    assert abs((y - SECTION_GAP + EDGE) - PAGE_H) < 0.5, ("page height", y - SECTION_GAP + EDGE)

    els = []

    def text(t, x, y, w, size, weight, color, **o):
        e = dict(type="text", id=uid("e"), text=t, x=px(x), y=px(y), w=px(w), size=size, font=FONT, weight=weight,
                 ital=False, color=color, align="left", lh=1.2, ls=0, upper=False, under=False, h=10, rot=0, op=1)
        e.update(o)
        els.append(e)
        return e

    def line(x, y, w, color, sw, **o):
        e = dict(type="line", id=uid("e"), x=px(x), y=px(y), w=px(w), h=16, rot=0, op=1, sw=sw, color=color,
                 dash="solid", capS="none", capE="none")
        e.update(o)
        els.append(e)
        return e

    def image(src, x, y, w, h, **o):
        e = dict(type="image", id=uid("e"), src=src, x=px(x), y=px(y), w=px(w), h=px(h), rot=0, op=1,
                 mask="rect", r=0, crop={"z": 1, "x": 0.5, "y": 0.5}, filt={}, fit="contain")
        e.update(o)
        els.append(e)
        return e

    def header(label, y):
        g = uid("g")
        t = text(label, EDGE, y, 400, 15, 700, GOLD, ls=200, upper=True, gid=g, _fit=True)
        line(EDGE, y + HEAD_H / 2 - 8, INNER, RULE, 1, gid=g, _after=t["id"], _x1=EDGE + INNER)

    def dim(cx, cy, length, label, vertical):
        g = uid("g")
        if vertical:
            line(cx - length / 2, cy - 8, length, DIM_LINE, 2, rot=90, capS="bar", capE="bar", gid=g)
        else:
            line(cx - length / 2, cy - 8, length, DIM_LINE, 2, capS="bar", capE="bar", gid=g)
        text(label, cx - 22, cy - 12, 44, 15, 600, DIM_TEXT, align="center", lh=1, ls=20,
             bgc=NAVY, bgp=0.3, bgr=0, gid=g, _cy=cy)

    spec_items = []
    for row, label in ((0, "Boxes"), (1, "Wooden Boards")):
        header(label, head_y[row])
        for it in [i for i in ITEMS if i["row"] == row]:
            x0 = slot_x[it["col"]]
            y0 = img_bottom[row] - it["img_h"]
            fname = f'{it["key"]}-{it["kind"]}.svg'
            if it["kind"] == "box":
                svg, region = box_svg(it["w"], it["h"], it["d"], it["alt"])
            else:
                svg, region = board_svg(it["w"], it["h"], it["alt"], it["seed"])
            open(os.path.join(GFX_DIR, fname), "w").write(svg)
            image(GFX_URL + fname, x0, y0, it["img_w"], it["img_h"])

            placed = place(it["cheese"], (region[0] + region[2]) / 2, (region[1] + region[3]) / 2, region, it["key"])
            gids = {}
            for p in placed:
                vx, vy, vw, vh = vbs[p["file"]]
                k = p["k"]
                o = {}
                if p.get("group") is not None:
                    o["gid"] = gids.setdefault(p["group"], uid("g"))
                image(GFX_URL + p["file"], x0 + (M + p["ax"] + k * vx) * S, y0 + (M + p["ay"] + k * vy) * S,
                      k * vw * S, k * vh * S, **o)

            bx, by = x0 + M * S, y0 + M * S                       # the box/board's top-left corner
            bw, bh = it["w"] * S, it["h"] * S
            dim(bx + bw / 2, y0 - DIM_GAP - DIM_BAND / 2, bw, f'{it["w"]} in', False)
            dim(x0 + it["img_w"] + SIDE_GAP + SIDE_W / 2, by + bh / 2, bh, f'{it["h"]} in', True)
            text(it["name"], bx, img_bottom[row] + CAP_GAP, 300, 24, 700, WHITE, lh=1.1)
            spec_items.append(dict(key=it["key"], wedges=len(placed)))

    spec = dict(w=PAGE_W, h=PAGE_H, bg=NAVY, els=els, items=spec_items)
    open(os.path.join(OUT, "spec.json"), "w").write(json.dumps(spec))
    print(f"{len(els)} layers; graphics in {os.path.relpath(GFX_DIR, REPO)}:", ", ".join(sorted(os.listdir(GFX_DIR))))
    for s in spec_items:
        print(f'  {s["key"]}: {s["wedges"]} cheese piece(s)')


if __name__ == "__main__":
    main()
