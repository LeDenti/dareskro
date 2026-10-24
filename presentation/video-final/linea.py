#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""La Linea for dareskro: one white line that draws the scene.

Every scene is an ordered list of strokes (polylines). At time t a budget of
length has been "drawn" by the line; whole strokes before the budget are shown,
the current one is shown up to the budget, the rest is not there yet. The
character is part of the ground line, drawn in one go, as in the cartoon.
Labels appear when the line reaches them. Once the scene is drawn, it moves:
the character walks, the clock turns, the padlock opens, coins run.

render(name, t, T, bg) → PIL image 1280×720.
"""
import math

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
WHITE = (255, 255, 255)
LW = 6
GY = 560
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def font(size, bold=True):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out(t, t0, dur):
    x = clamp((t - t0) / dur)
    return 1 - (1 - x) ** 3


# ------------------------------------------------------------ primitives
def circle(cx, cy, r, start=-90, sweep=360, n=48):
    pts = []
    for i in range(n + 1):
        a = math.radians(start + sweep * i / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def rect(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]


def line(x0, y0, x1, y1):
    return [(x0, y0), (x1, y1)]


def figure(x, y, s=1.0, walk=0.0, arm="down", nose=True):
    """The character, one continuous stroke from the ground and back to it.

    Starts on the ground left of the feet, climbs the back leg, the back, loops
    the head with its nose, comes down the front, the arm, the front leg, and
    lands on the ground again. `walk` swings the legs and the arm.
    """
    sw = math.sin(walk) * 22 * s if walk else 0.0
    hip = (x, y - 62 * s)
    neck = (x, y - 128 * s)
    r = 24 * s
    hc = (x + 2 * s, y - 155 * s)
    pts = [(x - 44 * s - sw, y), (x - 12 * s - sw * 0.5, y - 30 * s), hip,
           (x - 4 * s, y - 95 * s), (neck[0] - 3 * s, neck[1])]
    # the head: from the back of the neck (140°), up the back, over the top (270°),
    # down the face with a nose around 0°, to the chin (400°) and the front of the neck.
    # Screen coordinates: y grows downwards, so 270° is the top of the circle.
    def arc(a0, a1, n):
        return [(hc[0] + r * math.cos(math.radians(a)), hc[1] + r * math.sin(math.radians(a)))
                for a in (a0 + (a1 - a0) * k / n for k in range(n + 1))]
    pts += arc(140, 345, 18)
    if nose:
        pts += [(hc[0] + r + 9 * s, hc[1] - 1 * s), (hc[0] + r + 3 * s, hc[1] + 7 * s)]
    pts += arc(15, 400, 10)
    pts += [(neck[0] + 3 * s, neck[1])]
    # arm
    if arm == "point":
        pts += [(x + 4 * s, y - 112 * s), (x + 62 * s, y - 116 * s), (x + 6 * s, y - 106 * s)]
    elif arm == "up":
        pts += [(x + 4 * s, y - 112 * s), (x + 46 * s, y - 158 * s), (x + 6 * s, y - 106 * s)]
    elif arm == "push":
        pts += [(x + 4 * s, y - 112 * s), (x + 56 * s, y - 96 * s), (x + 6 * s, y - 106 * s)]
    else:
        pts += [(x + 4 * s, y - 112 * s), (x + 34 * s + sw * 0.6, y - 62 * s), (x + 6 * s, y - 106 * s)]
    pts += [(x + 6 * s, y - 62 * s), (x + 14 * s + sw * 0.5, y - 30 * s), (x + 44 * s + sw, y)]
    return pts


def padlock_strokes(cx, cy, s=1.0, open_=0.0):
    w, h, r = 90 * s, 70 * s, 32 * s
    lift = 24 * s * open_
    body = rect(cx - w / 2, cy, w, h)
    sh = [(cx + r, cy)] + [(cx + r, cy - r - lift)] + circle(cx, cy - r - lift, r, start=0, sweep=-180, n=24) + \
         [(cx - r, cy - r - lift + (14 * s if open_ > 0.5 else r))]
    key = circle(cx, cy + 32 * s, 7 * s, n=16)
    return [body, sh, key]


def clock_strokes(cx, cy, r, angle):
    a = angle * 2 * math.pi - math.pi / 2
    b = angle / 12 * 2 * math.pi - math.pi / 2 + 0.9
    return [circle(cx, cy, r), line(cx, cy, cx + r * 0.62 * math.cos(a), cy + r * 0.62 * math.sin(a)),
            line(cx, cy, cx + r * 0.4 * math.cos(b), cy + r * 0.4 * math.sin(b))]


def coin_strokes(cx, cy, r=18, spin=0.0):
    return [circle(cx, cy, r, n=24), line(cx, cy, cx + r * 0.6 * math.cos(spin), cy + r * 0.6 * math.sin(spin))]


def document_strokes(x, y, w=110, h=140, seal=False):
    s = [rect(x, y, w, h)]
    for i in range(4):
        s.append(line(x + 18, y + 30 + i * 24, x + w - 18 - (28 if i == 3 else 0), y + 30 + i * 24))
    if seal:
        s.append(circle(x + w - 30, y + h - 30, 20, n=24))
    return s


def device_strokes(x, y, w=150, h=90):
    return [rect(x, y, w, h), rect(x + 18, y + 16, w - 36, h - 32), circle(x + w - 26, y + h / 2, 8, n=16)]


def bar_strokes(x, y, grow):
    out = []
    for i in range(4):
        g = clamp(grow - i)
        if g <= 0:
            continue
        h = (40 + i * 22) * g
        cx, w = x + i * 95 + 40, 40
        pts = []
        for k in range(21):
            a = math.pi + math.pi * k / 20
            pts.append((cx + w * math.cos(a), y + h * math.sin(a)))
        out.append(pts)
    return out


def globe_strokes(cx, cy, r, spin):
    s = [circle(cx, cy, r), line(cx - r, cy, cx + r, cy)]
    for k in range(3):
        ph = (spin + k / 3) % 1.0
        hw = abs(math.cos(ph * math.pi)) * r
        if hw > 4:
            pts = []
            for i in range(41):
                a = -math.pi / 2 + math.pi * 2 * i / 40
                pts.append((cx + hw * math.cos(a), cy + r * math.sin(a)))
            s.append(pts)
    return s


def check_strokes(cx, cy, a):
    s = []
    if a <= 0:
        return s
    s.append(circle(cx, cy, 40, start=-90, sweep=360 * clamp(a * 1.6), n=40))
    b = clamp((a - 0.4) / 0.6)
    if b > 0:
        p0, p1, p2 = (cx - 22, cy), (cx - 6, cy + 18), (cx + 26, cy - 20)
        if b < 0.5:
            q = b / 0.5
            s.append([p0, (p0[0] + (p1[0] - p0[0]) * q, p0[1] + (p1[1] - p0[1]) * q)])
        else:
            q = (b - 0.5) / 0.5
            s.append([p0, p1, (p1[0] + (p2[0] - p1[0]) * q, p1[1] + (p2[1] - p1[1]) * q)])
    return s


def cross_strokes(x, y, a=1.0):
    if a <= 0:
        return []
    return [[(x, y), (x + 22 * a, y + 22 * a)], [(x + 22, y), (x + 22 - 22 * a, y + 22 * a)]]


def question_strokes(cx, cy, s=1.0):
    pts = circle(cx, cy - 60 * s, 40 * s, start=180, sweep=270, n=30)
    pts += [(cx, cy + 5 * s), (cx, cy + 30 * s)]
    return [pts, circle(cx, cy + 58 * s, 6 * s, n=12)]


def pharmacy_cross(x, y):
    return [line(x, y, x, y - 70), line(x - 15, y - 50, x + 15, y - 50), line(x, y - 65, x, y - 35)]


# --------------------------------------------------------------- scenes
def scene(name, t, T):
    """Returns (strokes, labels): strokes in drawing order; labels (x, y, text, size, bold, after_stroke_index)."""
    end = T - 0.9
    S, L = [], []

    def lab(x, y, text, size=24, bold=False):
        L.append((x, y, text, size, bold, len(S)))

    if name in ("walk", "walk_end"):
        drawn = draw_done(name, t, T)
        x = (360 + ease_out(t, drawn, min(4.5, max(1.0, end - drawn))) * 240) if name == "walk" else (420 + ease_out(t, drawn, max(2.0, end - drawn - 0.5)) * 300)
        moving = drawn < t < (drawn + 4.5 if name == "walk" else end - 0.5)
        S.append([(120, GY)] + figure(x, GY, walk=t * 7 if moving else 0.0, arm="point" if (name == "walk" and t > drawn + 4.8) or (name == "walk_end" and t > end - 0.4) else "down") + [(W - 120, GY)])
        S += pharmacy_cross(790, GY)
    elif name == "rule":
        S.append([(120, GY)] + figure(380, GY, arm="point") + [(W - 120, GY)])
        lab(430, GY - 150, "→", 80, True)
        S += document_strokes(520, GY - 150, seal=True)
        lab(650, GY - 150, "→", 80, True)
        S += padlock_strokes(790, GY - 110)
        lab(850, GY - 150, "→", 80, True)
        for k in range(3):
            S += coin_strokes(940 + k * 50, GY - 60)
    elif name == "clock":
        drawn = draw_done(name, t, T)
        x = 300 + ease_out(t, drawn, 2.5) * 170
        S.append([(120, GY)] + figure(x, GY, walk=t * 7 if drawn < t < drawn + 2.6 else 0.0, arm="point" if t > drawn + 2.8 else "down") + [(W - 120, GY)])
        S += clock_strokes(700, GY - 90, 70, clamp((t - drawn - 2.5) / max(1.0, end - drawn - 2.5)) * 2.0)
        if t > drawn + 3.5:
            lab(800, GY - 125, "badge 08:56 → 21:03", 26)
        if t > drawn + 6.5:
            lab(800, GY - 85, "schedule 09:00 → 21:00", 26)
        if t > drawn + 9.5:
            lab(800, GY - 45, "retained: 12 h", 28, True)
    elif name == "stack":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(380, GY, arm="point" if t > drawn + 1 else "down") + [(W - 120, GY)])
        grow = clamp((t - drawn - 0.5) / 6.0) * 4
        S += bar_strokes(470, GY, grow)
        for i, v in enumerate(["250.51", "83.50", "94.99", "37.58"]):
            if grow > i + 0.9:
                lab(470 + i * 95 + 12, GY + 14, v, 22, True)
        if t > drawn + 7.5:
            lab(880, GY - 150, "= $466.57", 44, True)
    elif name == "device":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(470, GY, arm="point" if drawn + 1.5 < t < end - 1 else "down") + [(W - 120, GY)])
        S += device_strokes(620, GY - 110)
        lines = [("$466.57 → XRP, day's rate", 2.0, 28, True), ("to r3kiDtPb…", 4.0, 24, False),
                 ("2026-10-25 15:55 UTC", 6.0, 24, False), ("hash 6313d0e0…", 8.0, 24, False), ("oracle rUuvu1X…", 10.0, 24, False)]
        y = GY - 160
        for s_, t0, size, bold in lines:
            if t > drawn + t0:
                lab(800, y, s_, size, bold)
            y += 34
        if t > end - 1.2:
            S += check_strokes(690, GY - 170, clamp((t - (end - 1.2)) / 0.8))
    elif name == "oracle":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(420, GY) + [(W - 120, GY)])
        S += document_strokes(540, GY - 160, seal=t > drawn + 4.5)
        S += device_strokes(700, GY - 110, w=130, h=80)
        lab(850, GY - 150, "rUuvu1X…", 30, True)
        if t > drawn + 4.8:
            lab(850, GY - 108, "born 15:51 UTC", 24)
        if t > drawn + 9.0:
            lab(850, GY - 70, "watching…", 24)
    elif name == "oracle_job":
        drawn = draw_done(name, t, T)
        S += clock_strokes(330, GY - 90, 55, clamp((t - drawn) / 3.0))
        lab(410, GY - 125, "→", 80, True)
        S.append([(120, GY)] + figure(540, GY, arm="point" if t > drawn + 3.0 else "down") + [(W - 120, GY)])
        S += padlock_strokes(690, GY - 110, open_=ease_out(t, drawn + 4.0, 0.8))
        lab(770, GY - 125, "→", 80, True)
        for i in range(3):
            a = ease_out(t, drawn + 5.2 + i * 0.15, 1.6)
            if a > 0:
                S += coin_strokes(740 + (900 - 740) * a - i * 48, GY - 40, spin=a * 6)
        S.append(figure(1010, GY, arm="up" if t > drawn + 6.8 else "down"))
        if t > drawn + 7.5:
            lab(560, GY + 14, "fee: 12 drops", 22, True)
    elif name == "lock":
        drawn = draw_done(name, t, T)
        pushing = drawn + 2.0 < t < drawn + 4.0 or drawn + 5.5 < t < drawn + 7.5 or drawn + 9.0 < t < drawn + 11.0
        S.append([(120, GY)] + figure(470 if pushing else 450, GY, arm="push" if pushing else "point") + [(W - 120, GY)])
        shake = math.sin(t * 40) * 3 if pushing else 0
        S += padlock_strokes(640 + shake, GY - 110, s=1.3)
        for k, (label, t0) in enumerate((("pay early", 4.0), ("redirect", 7.5), ("cancel", 11.0))):
            yy = GY - 150 + k * 40
            S += cross_strokes(765, yy + 6, ease_out(t, drawn + t0, 0.4))
            if t > drawn + t0:
                lab(805, yy, label, 28, True)
    elif name == "open":
        drawn = draw_done(name, t, T)
        S.append([(120, GY), (W - 120, GY)])
        S += padlock_strokes(420, GY - 110, open_=ease_out(t, drawn + 1.5, 0.8))
        for i in range(4):
            a = ease_out(t, drawn + 2.6 + i * 0.15, 2.0)
            if a > 0:
                S += coin_strokes(470 + (760 - 470) * a - i * 48, GY - 40, spin=a * 6)
        S.append(figure(820, GY, arm="up" if t > drawn + 4.6 else "down"))
        if t > drawn + 6.0:
            lab(560, GY + 14, "the employee, or anyone", 22, True)
    elif name == "notary":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(360, GY) + figure(660, GY, arm="point" if t > drawn + 4.0 else "down") + [(W - 120, GY)])
        S += document_strokes(480, GY - 160, seal=False)
        if t > drawn + 5.0:
            a = ease_out(t, drawn + 5.0, 0.5)
            S.append(circle(560, GY - 50, 20 + 60 * (1 - a), n=24))
        lab(720, GY - 150, "NOTARY", 30, True)
        S += padlock_strokes(900, GY - 110, open_=ease_out(t, drawn + 7.5, 0.8))
        for i in range(2):
            a = ease_out(t, drawn + 8.5 + i * 0.15, 1.2)
            if a > 0:
                S += coin_strokes(930 + 110 * a - i * 48, GY - 40, spin=a * 6)
    elif name == "globe":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(330, GY, arm="point" if drawn + 2 < t < drawn + 6 else "down") + [(W - 120, GY)])
        lab(290, GY - 215, "Paris", 26, True)
        S += globe_strokes(640, GY - 110, 80, t / 6.0)
        for i in range(3):
            a = ease_out(t, drawn + 8.5 + i * 0.15, 2.5)
            if a > 0:
                S += coin_strokes(380 + 500 * a - i * 48, GY - 40, spin=a * 6)
        S.append(figure(950, GY, arm="up" if t > drawn + 11.0 else "down"))
        lab(905, GY - 215, "Lagos", 26, True)
    elif name == "shop":
        drawn = draw_done(name, t, T)
        S.append([(120, GY), (W - 120, GY)])
        S += [rect(330, GY - 200, 110, 190), rect(345, GY - 185, 80, 125)]
        if t > drawn + 2.5:
            lab(355, GY - 150, "post", 22, True)
            lab(355, GY - 120, "live", 22, True)
        if t > drawn + 5.5:
            S += check_strokes(390, GY - 230, clamp((t - drawn - 5.5) / 0.8))
        if t > drawn + 7.0:
            lab(300, GY + 14, "still live at the date → paid", 22, True)
        S += [rect(560, GY - 140, 200, 140), [(540, GY - 140), (660, GY - 195), (780, GY - 140)]]
        for i in range(5):
            S += padlock_strokes(830 + i * 70, GY - 70, s=0.5, open_=ease_out(t, drawn + 11.0 + i * 1.0, 0.5))
        lab(820, GY - 150, "5 escrows, one per sale", 24)
        if t > drawn + 17.0:
            lab(560, GY + 14, "or: the customer pays through dareskro, no oracle", 22, True)
    elif name == "question":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(450, GY) + figure(800, GY) + [(W - 120, GY)])
        sc = 1.0 + 0.08 * math.sin(2 * math.pi * (t - drawn) / 1.6) if t > drawn else 1.0
        S += question_strokes(640, GY - 150, sc)
    elif name == "coins":
        drawn = draw_done(name, t, T)
        S.append([(120, GY)] + figure(380, GY, arm="point" if t > drawn + 1 else "down") + [(W - 120, GY)])
        if t > drawn + 1.5:
            lab(470, GY - 145, "402", 44, True)
        if t > drawn + 3.0:
            lab(590, GY - 125, "→", 80, True)
        a = ease_out(t, drawn + 3.5, 1.4)
        if a > 0:
            S += coin_strokes(690 + 210 * a, GY - 60, spin=a * 6)
        if t > drawn + 5.0:
            lab(700, GY - 20, "0.05 RLUSD", 28, True)
        S += document_strokes(950, GY - 160, w=90, h=120)
        if t > drawn + 5.5:
            S += check_strokes(995, GY - 190, clamp((t - drawn - 5.5) / 0.8))
    elif name == "check":
        drawn = draw_done(name, t, T)
        S.append([(120, GY), (W - 120, GY)])
        for i, s_ in enumerate(("device", "oracle", "agent")):
            S += check_strokes(380 + i * 230, GY - 110, clamp((t - drawn - 0.3 - i * 2.8) / 1.2))
            if t > drawn + 1.5 + i * 2.8:
                lab(380 + i * 230 - 40, GY - 50, s_, 26, True)
    else:
        S.append([(120, GY), (W - 120, GY)])
    return S, L


# The line draws the static part of a scene in its first seconds; animation starts after.
DRAW_SECONDS = {"walk": 1.8, "walk_end": 1.8, "rule": 3.5, "clock": 2.2, "stack": 2.0, "device": 2.6, "oracle": 3.2,
                "oracle_job": 3.0, "lock": 2.6, "open": 2.2, "notary": 3.4, "globe": 3.0, "shop": 3.2, "question": 2.6,
                "coins": 2.8, "check": 1.2}


def draw_done(name, t, T):
    return DRAW_SECONDS.get(name, 2.5)


def seg_len(p, q):
    return math.hypot(q[0] - p[0], q[1] - p[1])


def render(name, t, T, bg, title=None, subtitle=None, lw=LW, mark=True):
    """A frame: the scene drawn up to the line's budget at time t, labels when reached."""
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    strokes, labels = scene(name, t, T)
    total = sum(sum(seg_len(s[i], s[i + 1]) for i in range(len(s) - 1)) for s in strokes)
    budget_t = max(0.4, DRAW_SECONDS.get(name, 2.5))
    budget = total * clamp((t - 0.25) / budget_t) if t < 0.25 + budget_t else total
    drawn_len, pen = 0.0, None
    done_strokes = 0
    for si, s in enumerate(strokes):
        if len(s) < 2:
            continue
        if drawn_len >= budget:
            break
        pts = [s[0]]
        complete = True
        for i in range(len(s) - 1):
            l = seg_len(s[i], s[i + 1])
            if drawn_len + l <= budget:
                pts.append(s[i + 1])
                drawn_len += l
            else:
                f = (budget - drawn_len) / l if l else 1
                pts.append((s[i][0] + (s[i + 1][0] - s[i][0]) * f, s[i][1] + (s[i + 1][1] - s[i][1]) * f))
                drawn_len = budget
                complete = False
                break
        if len(pts) >= 2:
            d.line(pts, fill=WHITE, width=lw, joint="curve")
        pen = pts[-1]
        if complete:
            done_strokes = si + 1
        else:
            break
    else:
        done_strokes = len(strokes)
    if pen is not None and budget < total - 0.5:
        d.ellipse((pen[0] - 5, pen[1] - 5, pen[0] + 5, pen[1] + 5), fill=WHITE)   # the tip of the line
    for (x, y, text, size, bold, after) in labels:
        if after <= done_strokes:
            d.text((x, y), text, font=font(size, bold), fill=WHITE)
    if title:
        a = ease_out(t, 0.0, 0.7)
        f = font(56 if len(title) < 30 else 46)
        col = tuple(int(bg[i] + (255 - bg[i]) * a) for i in range(3))
        d.text(((W - d.textlength(title, font=f)) / 2, 70 + (1 - a) * 20), title, font=f, fill=col)
    if subtitle:
        b = ease_out(t, 0.5, 0.7)
        f2 = font(28, False)
        col = tuple(int(bg[i] + (255 - bg[i]) * b) for i in range(3))
        words, lines, cur = subtitle.split(), [], ""
        for w_ in words:
            tt = (cur + " " + w_).strip()
            if d.textlength(tt, font=f2) <= 1040:
                cur = tt
            else:
                lines.append(cur)
                cur = w_
        lines.append(cur)
        y = 150
        for ln in lines:
            d.text(((W - d.textlength(ln, font=f2)) / 2, y + (1 - b) * 14), ln, font=f2, fill=col)
            y += 38
    if mark:
        d.text((W - 170, H - 44), "dareskro", font=font(22), fill=WHITE)
    return img


if __name__ == "__main__":
    import sys
    name = sys.argv[1] if len(sys.argv) > 1 else "walk"
    for t in (0.3, 0.8, 1.5, 3.0, 6.0):
        render(name, t, 12.0, (30, 79, 214), "test", "subtitle").save("/tmp/linea_%s_%.1f.png" % (name, t))
    print("ok")
