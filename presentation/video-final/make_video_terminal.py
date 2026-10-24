#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dareskro — the demo as it really ran, in a terminal, with the Ledger screen.

Source: presentation/demo-terminal/capture/trace.json and screens/*.png, written
by app/scripts/demo-terminal.mjs during a real run on testnet (the statement in
euros, the Kraken rate, the escrow signed on the emulated Ledger, the oracle
releasing at the date). Nothing here is typed by hand: every line comes from the
trace. Commands are typed in, outputs appear, the device screen shows at the
right while the employer reviews, with the same voice as the explainer.

Usage:  .venv/bin/python presentation/video-final/make_video_terminal.py
Output: presentation/video-final/dareskro_demo_terminal_EN.mp4
"""
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_video import OUT, narrate  # noqa: E402
from make_video_anim import FPS, VOICE_PITCH, ease_out, voice_fx  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURE = os.path.join(HERE, "..", "demo-terminal", "capture")
W, H = 1280, 720
MONO = "/System/Library/Fonts/Menlo.ttc"
SANS_B = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BG = (24, 26, 32)
BAR = (44, 46, 54)
FG = (222, 224, 230)
DIM = (150, 154, 165)
GREEN = (120, 220, 140)
CYAN = (120, 210, 230)
YELL = (245, 200, 90)
RED = (240, 110, 110)
PAUSE = 0.9
TYPE_CPS = 32          # characters per second when "typing"
LINE_S = 0.22          # seconds between output lines
SCREEN_S = 1.05        # seconds per device screen
FONT_SZ = 20
LINE_H = 28
PAD = 22
COLS_LEFT_W = 850      # terminal width while the device panel is shown


def mono(size=FONT_SZ):
    return ImageFont.truetype(MONO, size)


def sans(size):
    return ImageFont.truetype(SANS_B, size)


trace = json.load(open(os.path.join(CAPTURE, "trace.json")))
entries = trace["trace"]

# ----------------------------------------------------------- the scenes
# (narration, first trace index, last trace index inclusive)  — indexes refer to `entries`
def idx_of(kind, startswith):
    for i, e in enumerate(entries):
        if e["kind"] == kind and e["text"].startswith(startswith):
            return i
    raise KeyError(startswith)


i_pay = idx_of("cmd", "$ python")
i_rate = idx_of("cmd", "$ curl https://api.kraken")
i_dev = idx_of("cmd", "$ node scripts/sign-on-ledger")
i_faucet = idx_of("cmd", "$ curl -X POST https://faucet")
i_submit = idx_of("cmd", "$ xrpl submit")
i_watch = idx_of("cmd", "$ curl -X POST http://127.0.0.1:8787")
i_proof = idx_of("cmd", "$ node proofs.mjs")
i_tail = idx_of("cmd", "$ tail -f")
i_review = idx_of("out", "  → review on the device")

SCENES = [
    ("The statement, in euros, computed by code from the evidence. The rules were bought by the agent on Mastercard this afternoon.",
     i_pay, i_rate - 1),
    ("The rate of the moment, from Kraken. Four hundred sixty-six euros fifty-seven is four hundred six XRP. The pay stays in euros; the escrow holds XRP.",
     i_rate, i_dev - 1),
    ("The employer's Ledger, through the Device Management Kit. The device gives the account; the testnet faucet funds it; a test employee is created.",
     i_dev, i_review - 1),
    ("The escrow is built for the device: the amount in XRP, the euros and the rate in a memo, the pay date, the hash of the statement, the oracle's name. The employer reviews it screen by screen, and signs.",
     i_review, i_submit - 1),
    ("Submitted. The oracle, cited in the escrow, is now watching it.",
     i_submit, i_proof - 1),
    ("A stranger tries to pay early. The ledger refuses: not before the date.",
     i_proof, i_tail - 1),
    ("At the date, the oracle finishes the escrow by itself. The employee is paid. Nobody clicked.",
     i_tail, len(entries) - 1),
]


# ------------------------------------------------------- timeline build
def build_timeline(lo, hi):
    """Events with absolute times inside the scene: (t, kind, text, file)."""
    t, ev = 0.6, []
    for e in entries[lo:hi + 1]:
        if e["kind"] == "cmd":
            ev.append((t, "cmd", e["text"], None))
            t += len(e["text"]) / TYPE_CPS + 0.45
        elif e["kind"] == "screen":
            ev.append((t, "screen", e["text"], e["file"]))
            t += SCREEN_S
        elif e["kind"] == "device":
            ev.append((t, "device", e["text"], None))   # the text line; the screen event carries the picture
        else:
            ev.append((t, "out", e["text"], None))
            t += LINE_S + (0.6 if "tesSUCCESS" in e["text"] or "tecNO_PERMISSION" in e["text"] or "finished" in e["text"] else 0)
    return ev, t + 0.8


# -------------------------------------------------------------- drawing
_screen_cache = {}


def device_panel(img, file, t_since):
    """The emulated Nano screen (128×64) blown up, framed, at the right."""
    if file not in _screen_cache:
        s = Image.open(os.path.join(CAPTURE, "screens", file)).convert("RGB")
        _screen_cache[file] = s.resize((s.width * 3, s.height * 3), Image.NEAREST)
    s = _screen_cache[file]
    x0, y0 = W - s.width - 46, 150
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((x0 - 22, y0 - 48, x0 + s.width + 22, y0 + s.height + 60), radius=18, fill=(10, 10, 12), outline=(90, 92, 100), width=3)
    d.text((x0, y0 - 36), "Ledger · XRP app 2.8.1 · Speculos", font=sans(16), fill=DIM)
    a = ease_out(t_since, 0, 0.25)
    frame = s if a >= 1 else Image.blend(Image.new("RGB", s.size, (0, 0, 0)), s, a)
    img.paste(frame, (x0, y0))
    d.ellipse((x0 + 30, y0 + s.height + 22, x0 + 50, y0 + s.height + 42), outline=(140, 142, 150), width=2)
    d.ellipse((x0 + s.width - 50, y0 + s.height + 22, x0 + s.width - 30, y0 + s.height + 42), outline=(140, 142, 150), width=2)


def render_frame(t, ev, scene_i, carried):
    """`carried` = terminal lines from previous scenes, kept on screen."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # title bar
    d.rectangle((0, 0, W, 44), fill=BAR)
    for i, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        d.ellipse((18 + i * 24, 14, 34 + i * 24, 30), fill=c)
    d.text((W / 2 - 150, 12), "dareskro — pay desk, from the terminal (testnet)", font=sans(17), fill=DIM)
    # which lines are visible at time t
    lines = list(carried)
    current_screen, screen_since = None, 0.0
    for (et, kind, text, file) in ev:
        if et > t:
            break
        if kind == "cmd":
            n = min(len(text), int((t - et) * TYPE_CPS) + 2)
            lines.append(("cmd", text[:n]))
        elif kind == "screen":
            current_screen, screen_since = file, t - et
        else:
            lines.append((kind, text))
    show_panel = current_screen is not None
    max_w = COLS_LEFT_W if show_panel else W - 2 * PAD
    f = mono()
    # wrap long lines
    rows = []
    for kind, text in lines:
        first = True
        while d.textlength(text, font=f) > max_w and len(text) > 10:
            cut = len(text)
            while cut > 10 and d.textlength(text[:cut], font=f) > max_w:
                cut -= 4
            rows.append((kind if first else "cont", text[:cut]))
            text = "    " + text[cut:]
            first = False
        rows.append((kind if first else "cont", text))
    max_rows = (H - 60 - PAD) // LINE_H
    rows = rows[-max_rows:]
    y = 60
    for kind, text in rows:
        color = {"cmd": FG, "out": DIM, "device": CYAN, "cont": FG}.get(kind, DIM)
        if kind == "cmd":
            d.text((PAD, y), "$", font=f, fill=GREEN)
            d.text((PAD + 26, y), text[2:] if text.startswith("$ ") else text, font=f, fill=FG)
        elif kind == "cont":
            d.text((PAD + 26, y), text.lstrip(), font=f, fill=FG)
        else:
            if "tesSUCCESS" in text or "finished by the oracle" in text or "signed on the device" in text:
                color = GREEN
            elif "tecNO_PERMISSION" in text:
                color = YELL
            elif text.lstrip().startswith("[device]"):
                color = CYAN
            d.text((PAD, y), text, font=f, fill=color)
        y += LINE_H
    # cursor
    if int(t * 2) % 2 == 0:
        d.rectangle((PAD + 26 + d.textlength(rows[-1][1][2:] if rows and rows[-1][0] == "cmd" else "", font=f) if rows and rows[-1][0] == "cmd" else PAD,
                     y - LINE_H + 4, (PAD + 26 + d.textlength(rows[-1][1][2:], font=f) if rows and rows[-1][0] == "cmd" else PAD) + 11, y - 4), fill=FG)
    if show_panel:
        device_panel(img, current_screen, screen_since)
    d.text((W - 150, H - 36), "dareskro", font=sans(20), fill=DIM)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    carried = []
    segments, total = [], 0.0
    for si, (narr, lo, hi) in enumerate(SCENES):
        wav, vdur = narrate(100 + si, narr)
        wav = voice_fx(wav)
        ev, vis_end = build_timeline(lo, hi)
        T = math.ceil(max(vis_end, vdur + PAUSE) * 10) / 10
        n = int(T * FPS)
        seg = os.path.join(OUT, "term%02d.mp4" % si)
        cmd = ["ffmpeg", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
               "-i", wav, "-t", str(T),
               "-vf", "format=yuv420p", "-af", "apad,atrim=0:%s" % T,
               "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(FPS),
               "-c:a", "aac", "-b:a", "160k", "-ar", "48000", seg]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for k in range(n):
            p.stdin.write(render_frame(k / FPS, ev, si, carried).tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit("ffmpeg failed on scene %d" % si)
        # carry the finished lines of this scene into the next (typed commands complete)
        for (_, kind, text, _) in ev:
            if kind in ("cmd", "out", "device"):
                carried.append((kind, text))
        segments.append(seg)
        total += T
        print("scene %d  %5.1f s  %s" % (si, T, narr[:60]))
    lst = os.path.join(OUT, "list_term.txt")
    with open(lst, "w") as f:
        for s in segments:
            f.write("file '%s'\n" % s)
    joined = os.path.join(OUT, "joined_term.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    final = os.path.join(HERE, "dareskro_demo_terminal_EN.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", joined, "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final], check=True)
    print("total %.1f s -> %s" % (total, final))


if __name__ == "__main__":
    main()
