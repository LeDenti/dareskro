#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dareskro — the final English explainer, animated.

Same cards, same narration as make_video.py, but every scene moves: figures
walk, the clock turns, the pay bars grow, the padlock opens and the coins run
to the employee, the crosses fall one by one, the globe spins, the checks draw
themselves. Titles fade and slide in. Frames are drawn with Pillow at 25 fps
and piped raw into ffmpeg, one segment per card, then joined.

Usage:  .venv/bin/python presentation/video-final/make_video_anim.py
Output: presentation/video-final/dareskro_final_EN_anim.mp4
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_video import (CARDS, FONT, FONT_BOLD, H, OUT, PAUSE, W, WHITE, coins,  # noqa: E402
                        device, document, font, narrate, wrap)

FPS = 25
HERE = os.path.dirname(os.path.abspath(__file__))

# The voice, rounder and deeper: pitch and formants down (asetrate), duration
# kept (atempo), warmth in the low mids, a little air, broadcast compression.
VOICE_PITCH = float(os.environ.get("VOICE_PITCH", "0.87"))   # 0.87 ≈ −2.4 semitones
VOICE_EQ = ("highpass=f=70,equalizer=f=140:t=q:w=1.0:g=4,equalizer=f=320:t=q:w=1.2:g=1.5,"
            "equalizer=f=2500:t=q:w=1.5:g=-1,equalizer=f=5500:t=q:w=1.5:g=1.5,"
            "acompressor=threshold=-20dB:ratio=3.5:attack=6:release=150:makeup=4,alimiter=limit=0.9")


def voice_fx(wav):
    """Post-process a narration wav: same length, rounder and deeper timbre."""
    out = wav.replace(".wav", "_fx.wav")
    chain = "asetrate=48000*%.3f,aresample=48000,atempo=%.4f,%s" % (VOICE_PITCH, 1 / VOICE_PITCH, VOICE_EQ)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-af", chain, "-ar", "48000", "-ac", "2", out], check=True)
    return out


# ------------------------------------------------------------------ easing
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out(t, t0, dur):
    """0 → 1 from t0 over dur seconds, decelerating."""
    x = clamp((t - t0) / dur)
    return 1 - (1 - x) ** 3


def lerp(a, b, x):
    return tuple(int(round(a[i] + (b[i] - a[i]) * x)) for i in range(3))


def pulse(t, period=1.2, lo=0.9, hi=1.0):
    return lo + (hi - lo) * (0.5 + 0.5 * math.sin(2 * math.pi * t / period))


# ----------------------------------------------------------- primitives
def person(d, x, y, s=1.0, arms="down", lw=5, walk=0.0, color=WHITE):
    """A white line figure, feet at (x, y). `walk` is a phase: legs and arms swing."""
    r = 26 * s
    hy = y - 150 * s
    d.ellipse((x - r, hy - r, x + r, hy + r), outline=color, width=lw)
    d.line((x, hy + r, x, y - 55 * s), fill=color, width=lw)
    sw = math.sin(walk) * 22 * s if walk else 0
    if arms == "down":
        d.line((x, y - 112 * s, x - 36 * s + sw, y - 60 * s), fill=color, width=lw)
        d.line((x, y - 112 * s, x + 36 * s - sw, y - 60 * s), fill=color, width=lw)
    elif arms == "up":
        d.line((x, y - 112 * s, x - 45 * s, y - 155 * s), fill=color, width=lw)
        d.line((x, y - 112 * s, x + 45 * s, y - 155 * s), fill=color, width=lw)
    elif arms == "point":
        d.line((x, y - 112 * s, x - 30 * s, y - 70 * s), fill=color, width=lw)
        d.line((x, y - 112 * s, x + 62 * s, y - 114 * s), fill=color, width=lw)
    elif arms == "push":
        d.line((x, y - 112 * s, x + 55 * s, y - 100 * s), fill=color, width=lw)
        d.line((x, y - 112 * s, x + 55 * s, y - 80 * s), fill=color, width=lw)
    d.line((x, y - 55 * s, x - 30 * s + sw, y), fill=color, width=lw)
    d.line((x, y - 55 * s, x + 30 * s - sw, y), fill=color, width=lw)


def ground(d, y, x0=120, x1=W - 120, lw=5):
    d.line((x0, y, x1, y), fill=WHITE, width=lw)


def clock(d, cx, cy, r, angle, lw=5):
    """`angle` in turns of the minute hand; the hour hand follows at 1/12."""
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=WHITE, width=lw)
    a = angle * 2 * math.pi - math.pi / 2
    d.line((cx, cy, cx + r * 0.62 * math.cos(a), cy + r * 0.62 * math.sin(a)), fill=WHITE, width=lw)
    b = angle / 12 * 2 * math.pi - math.pi / 2 + 0.9
    d.line((cx, cy, cx + r * 0.4 * math.cos(b), cy + r * 0.4 * math.sin(b)), fill=WHITE, width=lw)


def padlock(d, cx, cy, s=1.0, lw=5, open_=0.0, shake=0.0):
    """`open_` 0..1 lifts the shackle; `shake` offsets the body sideways."""
    cx += shake
    w, h = 90 * s, 70 * s
    d.rounded_rectangle((cx - w / 2, cy, cx + w / 2, cy + h), radius=10 * s, outline=WHITE, width=lw)
    r = 32 * s
    lift = 24 * s * open_
    d.arc((cx - r, cy - 2 * r - lift, cx + r, cy - lift), 180, 360, fill=WHITE, width=lw)
    d.line((cx + r, cy - r - lift, cx + r, cy), fill=WHITE, width=lw)
    if open_ < 0.5:
        d.line((cx - r, cy - r - lift, cx - r, cy), fill=WHITE, width=lw)
    else:
        d.line((cx - r, cy - r - lift, cx - r, cy - r - lift + 14 * s), fill=WHITE, width=lw)
    d.ellipse((cx - 7 * s, cy + 25 * s, cx + 7 * s, cy + 39 * s), outline=WHITE, width=lw)


def stack(d, x, y, grow, lw=5):
    """Four pay bars; `grow` 0..4 = how many are up (fractional = growing)."""
    for i in range(4):
        g = clamp(grow - i)
        if g <= 0:
            continue
        h = (40 + i * 22) * g
        d.arc((x + i * 95, y - h, x + i * 95 + 80, y + h), 180, 360, fill=WHITE, width=lw)
        d.line((x + i * 95, y, x + i * 95 + 80, y), fill=WHITE, width=lw)


def cross(d, x, y, a=1.0, lw=5):
    """A drawn X, revealed by `a` 0..1."""
    if a <= 0:
        return
    d.line((x, y, x + 22 * a, y + 22 * a), fill=WHITE, width=lw)
    d.line((x + 22, y, x + 22 - 22 * a, y + 22 * a), fill=WHITE, width=lw)


def check(d, cx, cy, a, label=None, lw=6):
    """A circled check mark, drawn progressively by `a` 0..1."""
    if a <= 0:
        return
    d.arc((cx - 40, cy - 40, cx + 40, cy + 40), 0, 360 * clamp(a * 1.6), fill=WHITE, width=5)
    b = clamp((a - 0.4) / 0.6)
    if b > 0:
        p0, p1, p2 = (cx - 22, cy), (cx - 6, cy + 18), (cx + 26, cy - 20)
        if b < 0.5:
            q = b / 0.5
            d.line((p0, (p0[0] + (p1[0] - p0[0]) * q, p0[1] + (p1[1] - p0[1]) * q)), fill=WHITE, width=lw)
        else:
            q = (b - 0.5) / 0.5
            d.line((p0, p1), fill=WHITE, width=lw)
            d.line((p1, (p1[0] + (p2[0] - p1[0]) * q, p1[1] + (p2[1] - p1[1]) * q)), fill=WHITE, width=lw)
    if label and a >= 1:
        f = font(26)
        d.text((cx - d.textlength(label, font=f) / 2, cy + 50), label, font=f, fill=WHITE)


def rolling_coins(d, x0, x1, y, t, t0, dur, n=4, r=18):
    """Coins travel from x0 to x1, one behind the other, spinning."""
    for i in range(n):
        a = ease_out(t, t0 + i * 0.15, dur)
        if a <= 0:
            continue
        cx = x0 + (x1 - x0) * a - i * (r * 2 + 12)
        ang = a * 6
        d.ellipse((cx - r, y - r, cx + r, y + r), outline=WHITE, width=4)
        d.line((cx, y, cx + r * 0.6 * math.cos(ang), y + r * 0.6 * math.sin(ang)), fill=WHITE, width=3)


def globe(d, cx, cy, r, spin, lw=5):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=WHITE, width=lw)
    d.line((cx - r, cy, cx + r, cy), fill=WHITE, width=3)
    for k in range(3):
        ph = (spin + k / 3) % 1.0
        hw = abs(math.cos(ph * math.pi)) * r
        if hw > 4:
            d.ellipse((cx - hw, cy - r, cx + hw, cy + r), outline=WHITE, width=3)


def cross_sign(d, x, y, lw=5):
    """The pharmacy cross on its post."""
    d.line((x, y, x, y - 70), fill=WHITE, width=lw)
    d.line((x - 15, y - 50, x + 15, y - 50), fill=WHITE, width=lw)
    d.line((x, y - 65, x, y - 35), fill=WHITE, width=lw)


# ----------------------------------------------------------------- scenes
GY = 560


def scene(d, name, t, T, bg):
    """Draw the animated picture of card `name` at time t (seconds) of T."""
    end = T - PAUSE  # when the narration ends
    if name == "walk":
        ground(d, GY)
        x = 360 + ease_out(t, 0.2, min(4.5, end)) * 240
        person(d, x, GY, arms="point" if t > 4.8 else "down", walk=t * 7 if t < 4.8 else 0)
        cross_sign(d, 790, GY)
    elif name == "walk_end":
        ground(d, GY)
        x = 420 + ease_out(t, 0.2, max(2.0, end - 0.5)) * 300
        person(d, x, GY, arms="up" if t > end - 0.4 else "down", walk=t * 7 if t < end - 0.5 else 0)
        cross_sign(d, 790, GY)
    elif name == "rule":
        ground(d, GY)
        steps = [(0.3, lambda: person(d, 380, GY, arms="point")),
                 (2.2, lambda: document(d, 520, GY - 150, seal=True)),
                 (4.4, lambda: padlock(d, 790, GY - 110)),
                 (6.4, lambda: coins(d, 940, GY - 60, n=3))]
        for i, (t0, draw) in enumerate(steps):
            if t >= t0:
                draw()
                if i > 0 and t >= t0 - 0.3:
                    d.text((430 + (i - 1) * 210 + (0 if i == 1 else 0), GY - 150), "→", font=font(80), fill=WHITE)
    elif name == "clock":
        ground(d, GY)
        x = 300 + ease_out(t, 0.2, 2.5) * 170
        person(d, x, GY, arms="point" if t > 2.8 else "down", walk=t * 7 if t < 2.8 else 0)
        clock(d, 700, GY - 90, 70, angle=clamp((t - 2.5) / (end - 2.5)) * 2.0)
        if t > 3.5:
            f = font(26, False)
            d.text((800, GY - 125), "badge 08:56 → 21:03", font=f, fill=WHITE)
        if t > 6.5:
            d.text((800, GY - 85), "schedule 09:00 → 21:00", font=font(26, False), fill=WHITE)
        if t > 9.5:
            d.text((800, GY - 45), "retained: 12 h", font=font(28), fill=WHITE)
    elif name == "stack":
        ground(d, GY)
        person(d, 380, GY, arms="point" if t > 1 else "down")
        stack(d, 470, GY, grow=clamp((t - 1.5) / 6.0) * 4)
        labels = ["250.51", "83.50", "94.99", "37.58"]
        for i, lab in enumerate(labels):
            if t > 1.5 + (i + 1) * 1.5:
                f = font(22)
                d.text((470 + i * 95 + 40 - d.textlength(lab, font=f) / 2, GY + 14), lab, font=f, fill=WHITE)
        if t > 9.5:
            d.text((880, GY - 150), "= $466.57", font=font(44), fill=WHITE)
    elif name == "device":
        ground(d, GY)
        person(d, 470, GY, arms="point" if 1.5 < t < end - 1 else "down")
        device(d, 620, GY - 110)
        lines = [("$466.57 → XRP, day's rate", 2.0, 28, True), ("to r3kiDtPb…", 4.0, 24, False),
                 ("2026-10-25 15:55 UTC", 6.0, 24, False), ("hash 6313d0e0…", 8.0, 24, False),
                 ("oracle rUuvu1X…", 10.0, 24, False)]
        y = GY - 160
        for s, t0, size, bold in lines:
            if t > t0:
                d.text((800, y), s, font=font(size, bold), fill=WHITE)
                y += 34
        if t > end - 1.2:
            check(d, 690, GY - 170, clamp((t - (end - 1.2)) / 0.8))
    elif name == "oracle":
        ground(d, GY)
        person(d, 420, GY)
        if t > 3.0:
            a = ease_out(t, 3.0, 0.6)
            document(d, 540, GY - 160 + int((1 - a) * 40), seal=t > 4.5)
        if t > 8.0:
            a = ease_out(t, 8.0, 0.6)
            device(d, 700, GY - 110 + int((1 - a) * 40), w=130, h=80)
        if t > 0.8:
            d.text((850, GY - 150), "rUuvu1X…", font=font(30), fill=WHITE)
        if t > 4.8:
            d.text((850, GY - 108), "born 15:51 UTC", font=font(24, False), fill=WHITE)
        if t > 9.0:
            d.text((850, GY - 70), "watching…", font=font(24, False), fill=WHITE)
    elif name == "oracle_job":
        ground(d, GY)
        clock(d, 330, GY - 90, 55, angle=clamp(t / 3.0) * 1.0)
        if t > 0.5:
            d.text((410, GY - 125), "→", font=font(80), fill=WHITE)
        person(d, 540, GY, arms="point" if t > 3.0 else "down")
        padlock(d, 690, GY - 110, open_=ease_out(t, 4.0, 0.8))
        if t > 5.0:
            d.text((770, GY - 125), "→", font=font(80), fill=WHITE)
        rolling_coins(d, 740, 900, GY - 40, t, 5.2, 1.6, n=3)
        person(d, 1010, GY, arms="up" if t > 6.8 else "down")
        if t > 7.5:
            d.text((560, GY + 14), "fee: 12 drops", font=font(22), fill=WHITE)
    elif name == "lock":
        ground(d, GY)
        pushing = 2.0 < t < 4.0 or 5.5 < t < 7.5 or 9.0 < t < 11.0
        person(d, 470 if pushing else 450, GY, arms="push" if pushing else "point")
        shake = math.sin(t * 40) * 3 if pushing else 0
        padlock(d, 640, GY - 110, s=1.3, shake=shake)
        for k, (label, t0) in enumerate((("pay early", 4.0), ("redirect", 7.5), ("cancel", 11.0))):
            yy = GY - 150 + k * 40
            cross(d, 765, yy + 6, a=ease_out(t, t0, 0.4))
            if t > t0:
                d.text((805, yy), label, font=font(28), fill=WHITE)
    elif name == "open":
        ground(d, GY)
        padlock(d, 420, GY - 110, open_=ease_out(t, 1.5, 0.8))
        rolling_coins(d, 470, 760, GY - 40, t, 2.6, 2.0, n=4)
        person(d, 820, GY, arms="up" if t > 4.6 else "down")
        if t > 6.0:
            d.text((560, GY + 14), "the employee, or anyone", font=font(22), fill=WHITE)
    elif name == "notary":
        ground(d, GY)
        person(d, 360, GY)
        document(d, 480, GY - 160, seal=False)
        if t > 5.0:
            a = ease_out(t, 5.0, 0.5)
            r = int(20 + 60 * (1 - a))
            d.ellipse((560 - r, GY - 50 - r, 560 + r, GY - 50 + r), outline=WHITE, width=4)
        person(d, 660, GY, arms="point" if t > 4.0 else "down")
        d.text((720, GY - 150), "NOTARY", font=font(30), fill=WHITE)
        padlock(d, 900, GY - 110, open_=ease_out(t, 7.5, 0.8))
        rolling_coins(d, 930, 1040, GY - 40, t, 8.5, 1.2, n=2)
    elif name == "globe":
        ground(d, GY)
        person(d, 330, GY, arms="point" if 2 < t < 6 else "down")
        d.text((290, GY - 215), "Paris", font=font(26), fill=WHITE)
        globe(d, 640, GY - 110, 80, spin=t / 6.0)
        rolling_coins(d, 380, 880, GY - 40, t, 8.5, 2.5, n=3)
        person(d, 950, GY, arms="up" if t > 11.0 else "down")
        d.text((905, GY - 215), "Lagos", font=font(26), fill=WHITE)
        if 3.0 < t < 8.5:
            padlock(d, 640, GY - 40, s=0.6, lw=3, open_=ease_out(t, 7.5, 0.8))
    elif name == "shop":
        ground(d, GY)
        # the influencer's phone: the post goes live, then stays live at the date
        d.rounded_rectangle((330, GY - 200, 440, GY - 10), radius=14, outline=WHITE, width=5)
        d.rounded_rectangle((345, GY - 185, 425, GY - 60), radius=6, outline=WHITE, width=3)
        if t > 2.5:
            d.text((355, GY - 150), "post", font=font(22), fill=WHITE)
            d.text((355, GY - 120), "live", font=font(22), fill=WHITE)
        if t > 5.5:
            check(d, 390, GY - 230, clamp((t - 5.5) / 0.8))
        if t > 7.0:
            d.text((300, GY + 14), "still live at the date → paid", font=font(22), fill=WHITE)
        # the shop: one escrow per expected sale, opened by the sales system
        d.rounded_rectangle((560, GY - 140, 760, GY), radius=8, outline=WHITE, width=5)
        d.polygon([(540, GY - 140), (660, GY - 195), (780, GY - 140)], outline=WHITE, width=5)
        for i in range(5):
            padlock(d, 830 + i * 70, GY - 70, s=0.5, lw=3, open_=ease_out(t, 11.0 + i * 1.0, 0.5))
        d.text((820, GY - 150), "5 escrows, one per sale", font=font(24, False), fill=WHITE)
        if t > 17.0:
            d.text((560, GY + 14), "or: the customer pays through dareskro, no oracle", font=font(22), fill=WHITE)
    elif name == "question":
        ground(d, GY)
        person(d, 450, GY)
        s = pulse(t, 1.6, 0.92, 1.08)
        f = font(int(150 * s))
        d.text((640 - d.textlength("?", font=f) / 2, GY - 250 - (s - 1) * 60), "?", font=f, fill=WHITE)
        person(d, 800, GY)
    elif name == "coins":
        ground(d, GY)
        person(d, 380, GY, arms="point" if t > 1 else "down")
        if t > 1.5:
            d.text((470, GY - 145), "402", font=font(44), fill=WHITE)
        if t > 3.0:
            d.text((590, GY - 125), "→", font=font(80), fill=WHITE)
        rolling_coins(d, 690, 900, GY - 60, t, 3.5, 1.4, n=1)
        if t > 5.0:
            d.text((700, GY - 20), "0.05 RLUSD", font=font(28), fill=WHITE)
        document(d, 950, GY - 160, w=90, h=120)
        if t > 5.5:
            check(d, 995, GY - 190, clamp((t - 5.5) / 0.8))
    elif name == "check":
        ground(d, GY)
        for i, s in enumerate(("device", "oracle", "agent")):
            check(d, 380 + i * 230, GY - 110, clamp((t - 1.0 - i * 2.8) / 1.2), label=s)
    else:
        ground(d, GY)


def frame(i, bg, title, subtitle, name, t, T):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    # title: fade + slide, then subtitle
    a = ease_out(t, 0.0, 0.7)
    tsize = 56 if len(title) < 30 else 46
    f = font(tsize)
    d.text(((W - d.textlength(title, font=f)) / 2, 70 + (1 - a) * 20), title, font=f, fill=lerp(bg, WHITE, a))
    b = ease_out(t, 0.5, 0.7)
    y = 150
    for line in wrap(d, subtitle, 28, False, 1040):
        f2 = font(28, False)
        d.text(((W - d.textlength(line, font=f2)) / 2, y + (1 - b) * 14), line, font=f2, fill=lerp(bg, WHITE, b))
        y += 38
    scene(d, name, t, T, bg)
    d.text((W - 170, H - 44), "dareskro", font=font(22), fill=WHITE)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    segments, total = [], 0.0
    for i, (bg, title, sub, name, narr) in enumerate(CARDS):
        wav, vdur = narrate(i, narr)
        wav = voice_fx(wav)
        T = math.ceil((vdur + PAUSE) * 10) / 10
        n = int(T * FPS)
        seg = os.path.join(OUT, "anim%02d.mp4" % i)
        cmd = ["ffmpeg", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
               "-i", wav, "-t", str(T),
               "-vf", "fade=t=in:st=0:d=0.3,fade=t=out:st=%.1f:d=0.3,format=yuv420p" % (T - 0.3),
               "-af", "apad,atrim=0:%s" % T,
               "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(FPS),
               "-c:a", "aac", "-b:a", "160k", "-ar", "48000", seg]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for k in range(n):
            p.stdin.write(frame(i, bg, title, sub, name, k / FPS, T).tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit("ffmpeg failed on card %d" % i)
        segments.append(seg)
        total += T
        print("card %2d  %5.1f s  %4d frames  %s" % (i, T, n, title), flush=True)
    lst = os.path.join(OUT, "list_anim.txt")
    with open(lst, "w") as f:
        for s in segments:
            f.write("file '%s'\n" % s)
    joined = os.path.join(OUT, "joined_anim.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    final = os.path.join(HERE, "dareskro_final_EN_anim.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", joined, "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final], check=True)
    print("total %.1f s -> %s" % (total, final))


if __name__ == "__main__":
    main()
