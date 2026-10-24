#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dareskro — the La Linea versions: one continuous white line draws each scene.

Two outputs from the same narration (voice A):
  dareskro_final_EN_linea.mp4        full screen: title, subtitle, the line
  dareskro_final_EN_linea_split.mp4  left: the code writing itself (real logs),
                                     right: title, subtitle, the line

Usage:  .venv/bin/python presentation/video-final/make_video_linea.py [full|split|both]
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import linea  # noqa: E402
from make_video import CARDS, OUT, PAUSE, narrate  # noqa: E402
from make_video_anim import FPS, voice_fx  # noqa: E402
from make_video_split import LW, TERMINAL, terminal_pane  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1280, 720


def full_frame(i, bg, title, sub, name, t, T):
    return linea.render(name, t, T, bg, title=title, subtitle=sub)


def split_frame(i, bg, title, sub, name, t, T, lines):
    img = Image.new("RGB", (W, H), bg)
    # right: title + subtitle at readable size, then the line scene
    d = ImageDraw.Draw(img)
    a = linea.ease_out(t, 0.0, 0.7)
    col = tuple(int(bg[k] + (255 - bg[k]) * a) for k in range(3))
    f = linea.font(34 if len(title) < 26 else 28)
    d.text((LW + (LW - d.textlength(title, font=f)) / 2, 54 + (1 - a) * 14), title, font=f, fill=col)
    b = linea.ease_out(t, 0.5, 0.7)
    col2 = tuple(int(bg[k] + (255 - bg[k]) * b) for k in range(3))
    f2 = linea.font(19, False)
    words, lines_, cur = sub.split(), [], ""
    for w_ in words:
        tt = (cur + " " + w_).strip()
        if d.textlength(tt, font=f2) <= LW - 60:
            cur = tt
        else:
            lines_.append(cur)
            cur = w_
    lines_.append(cur)
    y = 108
    for ln in lines_:
        d.text((LW + (LW - d.textlength(ln, font=f2)) / 2, y + (1 - b) * 10), ln, font=f2, fill=col2)
        y += 26
    scene = linea.render(name, t, T, bg, lw=8, mark=False).resize((LW, 360), Image.LANCZOS)
    img.paste(scene, (LW, 300))
    terminal_pane(img, lines, t, T)
    d = ImageDraw.Draw(img)
    d.line((LW, 0, LW, H), fill=(60, 62, 70), width=2)
    d.text((W - 110, H - 34), "dareskro", font=linea.font(18), fill=(255, 255, 255))
    return img


def build(kind):
    os.makedirs(OUT, exist_ok=True)
    segments, total = [], 0.0
    for i, (bg, title, sub, name, narr) in enumerate(CARDS):
        wav, vdur = narrate(i, narr)
        wav = voice_fx(wav)
        T = math.ceil((vdur + PAUSE) * 10) / 10
        n = int(T * FPS)
        seg = os.path.join(OUT, "%s%02d.mp4" % (kind, i))
        cmd = ["ffmpeg", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
               "-i", wav, "-t", str(T),
               "-vf", "fade=t=in:st=0:d=0.3,fade=t=out:st=%.1f:d=0.3,format=yuv420p" % (T - 0.3),
               "-af", "apad,atrim=0:%s" % T,
               "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(FPS),
               "-c:a", "aac", "-b:a", "160k", "-ar", "48000", seg]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        lines = TERMINAL[i] if i < len(TERMINAL) else []
        for k in range(n):
            t = k / FPS
            fr = full_frame(i, bg, title, sub, name, t, T) if kind == "linea" else split_frame(i, bg, title, sub, name, t, T, lines)
            p.stdin.write(fr.tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit("ffmpeg failed on card %d" % i)
        segments.append(seg)
        total += T
        print("%s card %2d  %5.1f s  %s" % (kind, i, T, title), flush=True)
    lst = os.path.join(OUT, "list_%s.txt" % kind)
    with open(lst, "w") as f:
        for s in segments:
            f.write("file '%s'\n" % s)
    joined = os.path.join(OUT, "joined_%s.mp4" % kind)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    final = os.path.join(HERE, "dareskro_final_EN_%s.mp4" % ("linea" if kind == "linea" else "linea_split"))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", joined, "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final], check=True)
    print("total %.1f s -> %s" % (total, final))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    if mode in ("full", "both"):
        build("linea")
    if mode in ("split", "both"):
        build("lsplit")
