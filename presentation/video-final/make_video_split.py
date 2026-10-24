#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dareskro — split screen: the code writing itself on the left, the line-art
scene evolving on the right, one voice.

Left: a terminal typing real lines from the real runs of the day (statement,
rate, device screens, oracle log, delivery demo, AP4M agent). Right: the
animated card of the explainer (make_video_anim), scaled. Same 16 cards, same
narration, same voice A.

Usage:  .venv/bin/python presentation/video-final/make_video_split.py
Output: presentation/video-final/dareskro_final_EN_split.mp4
"""
import json
import math
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_video import CARDS, OUT, PAUSE, narrate  # noqa: E402
from make_video_anim import FPS, frame as scene_frame, voice_fx  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
CAP = os.path.join(HERE, "..", "demo-terminal", "capture")
W, H = 1280, 720
LW = 640                      # terminal width
MONO = "/System/Library/Fonts/Menlo.ttc"
SANS_B = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BG = (24, 26, 32)
BAR = (44, 46, 54)
FG = (222, 224, 230)
DIM = (150, 154, 165)
GREEN = (120, 220, 140)
CYAN = (120, 210, 230)
YELL = (245, 200, 90)
FONT_SZ = 15
LINE_H = 22
PAD = 16
TYPE_CPS = 40


def mono():
    return ImageFont.truetype(MONO, FONT_SZ)


def sans(size):
    return ImageFont.truetype(SANS_B, size)


# ------------------------------------------------------- real material
def read_lines(name):
    p = os.path.join(CAP, name)
    if not os.path.exists(p):
        return []
    return [l.rstrip("\n") for l in open(p, encoding="utf-8", errors="replace")]


trace = json.load(open(os.path.join(CAP, "trace.json")))
T = trace["trace"]
bulletin = read_lines("bulletin.log")
oracle_log = read_lines("oracle.log")
livraison = read_lines("livraison.log")
ap4m = read_lines("ap4m_agent.log")


def tr(kind_prefix, start, count=None):
    """Lines of the terminal trace from the entry whose text starts with `start`."""
    out, on = [], False
    for e in T:
        if e["text"].startswith(start):
            on = True
        if on:
            if e["kind"] == "cmd" and not e["text"].startswith(start) and out:
                break
            if e["kind"] in ("cmd", "out", "device"):
                out.append((e["kind"], e["text"]))
    return out if count is None else out[:count]


def o(pattern, n=None):
    """Oracle log lines matching a pattern."""
    res = [("out", l) for l in oracle_log if re.search(pattern, l)]
    return res if n is None else res[-n:]


def ls_root():
    names = sorted(n for n in os.listdir(ROOT) if not n.startswith(".") and n not in ("ledger-workshop",))
    return [("out", "  ".join(names))]


def readme_lines(start, n):
    lines = [l.rstrip("\n") for l in open(os.path.join(ROOT, "README.md"), encoding="utf-8")]
    for i, l in enumerate(lines):
        if l.startswith(start):
            return [("out", x) for x in lines[i:i + n]]
    return []


TERMINAL = [
    # 0 title
    [("cmd", "$ cd dareskro && ls")] + ls_root() + [("cmd", "$ cat README.md | head -3")] + readme_lines("# dareskro", 3),
    # 1 one rule
    [("cmd", "$ grep -n -A1 '^[1-5]\\. \\*\\*' README.md | head -12")] + readme_lines("1. **Evidence.**", 11),
    # 2 variable pay
    [("cmd", "$ cat agent/preuves/planning_2026-10-25.txt | grep -v '^#'"),
     ("out", "salarie: Pharmacien adjoint, coefficient 600, 18 ans"), ("out", "date: 2026-10-25   plage: 09:00-21:00"),
     ("out", "type: garde dimanche, volets ouverts   heures_semaine_avant: 35"),
     ("cmd", "$ cat agent/preuves/badge_2026-10-25.csv"), ("out", "A-0412,2026-10-25T08:56:00+01:00,entree"), ("out", "A-0412,2026-10-25T21:03:00+01:00,sortie"),
     ("cmd", "$ python agent/bulletin_garde.py --exige-achat")] + [("out", l) for l in bulletin[:1]],
    # 3 code computes
    [("cmd", "$ python agent/bulletin_garde.py --exige-achat")] + [("out", l) for l in bulletin[:10]],
    # 4 device
    tr("cmd", "$ curl https://api.kraken") + tr("cmd", "$ node scripts/sign-on-ledger")[:3] + [("out", "  → review on the device")] + [(k, t) for k, t in tr("out", "  → review on the device") if t.startswith("  [device]")][:20],
    # 5 oracle in real life
    [("cmd", "$ node oracle/oracle.mjs status"),
     ("out", '  "name": "dareskro payroll oracle v1",'), ("out", '  "address": "rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW",'),
     ("out", '  "birth": "AF5C74C86FB526396E4FCF0B659AB2F3AA8D450C9218A19DA4F54C23EC3B4A2A",'), ("out", '  "birthResult": "tesSUCCESS"'),
     ("cmd", "$ node oracle/oracle.mjs watch")] + o(r"born|listening", 2),
    # 6 one job
    [("cmd", "$ tail -f oracle.log")] + o(r"watching escrow #21789943|#21789943: date passed|#21789943: finished", 3),
    # 7 cannot do
    [("cmd", "$ node proofs.mjs --early-finish --by third-party")] + [(k, t) for k, t in tr("cmd", "$ node proofs.mjs") if k == "out"][:1]
    + [("cmd", "$ node proofs.mjs --cancel --sign-on-device"), ("out", "  tecNO_PERMISSION  https://testnet.xrpl.org/transactions/1E08B209F6C42A9217E24B028611F98C2FF6F33A1631CA3DD965BDD221772600"),
       ("cmd", "$ node proofs.mjs --redirect"), ("out", "  EscrowFinish has no destination field: nothing to try")],
    # 8 if it dies
    [("cmd", "$ pkill -f 'oracle.mjs watch'   # the oracle is gone"),
     ("cmd", "$ node finish.mjs --as third-party --escrow 21789555"),
     ("out", "  tesSUCCESS  https://testnet.xrpl.org/transactions/79C97E6B56728E660DABAB32854ADFFA6EB4CE52FC6DDA98FC3FC378125B4913"),
     ("out", "  employee balance: 566.57 XRP — the money went where it was written")],
    # 9 real estate
    [("cmd", "$ cat escrow-deed.json"), ("out", "{ \"TransactionType\": \"EscrowCreate\","), ("out", "  \"Amount\": \"5833.33 EUR → XRP at the day's rate\","),
     ("out", "  \"Condition\": \"<secret held by the oracle>\","), ("out", "  \"CancelAfter\": \"compromis deadline → refund\","),
     ("out", "  \"Memos\": [ \"deed: notary signature\", \"then: official publication\" ] }"),
     ("out", "  oracle: party to nothing")],
    # 10 freelancer
    [("cmd", "$ node oracle/demo_livraison.mjs")] + [("out", re.sub(r"^\d\d:\d\d:\d\d ", "", l)) for l in livraison if re.search(r"escrow 1 \(the job\)|WRONG|oracle says|third party|RIGHT|escrow 1:|freelancer balance|escrow 2 \(no|escrow 2:|client balance", l)],
    # 11 influencer / affiliate
    [("cmd", "$ cat escrow-post.json"), ("out", "{ \"proof\": { \"url\": \"https://platform/…/post\", \"check\": \"live now, still live at the date\" },"),
     ("out", "  \"FinishAfter\": \"+30 days\", \"CancelAfter\": \"+45 days → refund\" }"),
     ("cmd", "$ for sale in 1 2 3 4 5; do node escrow.mjs --commission $sale; done"),
     ("out", "  5 × EscrowCreate, one per expected sale, released by the sales feed"),
     ("out", "  unreleased at campaign end → EscrowCancel, back to the merchant")],
    # 12 question
    [("cmd", "$ grep -n 'party to the dispute' README.md")] + readme_lines("The question that sorts oracles", 4),
    # 13 agent pays
    [("cmd", "$ node ap4m/agent.mjs")] + [("out", l) for l in ap4m[:9]],
    # 14 built this weekend
    [("cmd", "$ cat proofs.txt"),
     ("out", "  EscrowCreate signed on device  9D59BC76…  tesSUCCESS"), ("out", "  early finish by a stranger      7C2A9FDB…  tecNO_PERMISSION"),
     ("out", "  released by the oracle          0356E36B…  tesSUCCESS  (12 s after the date)"),
     ("out", "  delivery: right file → paid     3AA9B66D…  tesSUCCESS"), ("out", "  delivery: nothing → refunded    3CDE5B05…  tesSUCCESS"),
     ("out", "  AP4M VoucherRedeemed            0xf6b37003…  0.05 RLUSD"), ("out", "  AP4M settlement to merchant     0xf6fc32f8…  receipt verified")],
    # 15 end
    [("cmd", "$ echo 'The AI reads. Code calculates. A human signs. The ledger pays. Not before.'"),
     ("out", "The AI reads. Code calculates. A human signs. The ledger pays. Not before.")],
]


# --------------------------------------------------------------- render
def wrap_rows(d, lines, f, max_w):
    rows = []
    for kind, text in lines:
        first = True
        while d.textlength(text, font=f) > max_w and len(text) > 8:
            cut = len(text)
            while cut > 8 and d.textlength(text[:cut], font=f) > max_w:
                cut -= 3
            rows.append((kind if first else "cont", text[:cut]))
            text = "  " + text[cut:]
            first = False
        rows.append((kind if first else "cont", text))
    return rows


def terminal_pane(img, lines, t, T):
    """Lines appear progressively: commands typed, outputs line by line, all done by 80 % of T."""
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, LW, H), fill=BG)
    d.rectangle((0, 0, LW, 34), fill=BAR)
    for i, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        d.ellipse((12 + i * 20, 11, 24 + i * 20, 23), fill=c)
    d.text((LW / 2 - 90, 8), "dareskro — what really ran", font=sans(14), fill=DIM)
    # schedule
    total_chars = sum(len(x[1]) if x[0] == "cmd" else 0 for x in lines)
    budget = max(1.0, T * 0.8)
    per_out = max(0.12, min(0.45, (budget - total_chars / TYPE_CPS) / max(1, sum(1 for x in lines if x[0] != "cmd"))))
    tt, visible = 0.4, []
    for kind, text in lines:
        if kind == "cmd":
            if t < tt:
                break
            n = min(len(text), int((t - tt) * TYPE_CPS) + 1)
            visible.append((kind, text[:n]))
            tt += len(text) / TYPE_CPS + 0.3
        else:
            if t < tt:
                break
            visible.append((kind, text))
            tt += per_out
    f = mono()
    rows = wrap_rows(d, visible, f, LW - 2 * PAD - 20)
    max_rows = (H - 50 - PAD) // LINE_H
    rows = rows[-max_rows:]
    y = 48
    for kind, text in rows:
        if kind == "cmd":
            d.text((PAD, y), "$", font=f, fill=GREEN)
            d.text((PAD + 18, y), text[2:] if text.startswith("$ ") else text, font=f, fill=FG)
        elif kind == "cont":
            d.text((PAD + 18, y), text.lstrip(), font=f, fill=FG)
        else:
            color = DIM
            if "tesSUCCESS" in text or "finished" in text or "bought:" in text or "settled:" in text or "match" in text:
                color = GREEN
            elif "tecNO_PERMISSION" in text or "tecCRYPTOCONDITION" in text or "not yet" in text or "≠" in text:
                color = YELL
            elif text.lstrip().startswith("[device]"):
                color = CYAN
            d.text((PAD, y), text, font=f, fill=color)
        y += LINE_H
    if int(t * 2) % 2 == 0 and rows:
        d.rectangle((PAD, y + 2, PAD + 9, y + LINE_H - 6), fill=FG)


def split_frame(i, bg, title, sub, name, t, T, lines):
    img = Image.new("RGB", (W, H), bg)
    right = scene_frame(i, bg, title, sub, name, t, T).resize((LW, 360), Image.LANCZOS)
    img.paste(right, (LW, 180))
    terminal_pane(img, lines, t, T)
    d = ImageDraw.Draw(img)
    d.line((LW, 0, LW, H), fill=(60, 62, 70), width=2)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    segments, total = [], 0.0
    for i, (bg, title, sub, name, narr) in enumerate(CARDS):
        wav, vdur = narrate(i, narr)
        wav = voice_fx(wav)
        T = math.ceil((vdur + PAUSE) * 10) / 10
        n = int(T * FPS)
        seg = os.path.join(OUT, "split%02d.mp4" % i)
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
            p.stdin.write(split_frame(i, bg, title, sub, name, k / FPS, T, lines).tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit("ffmpeg failed on card %d" % i)
        segments.append(seg)
        total += T
        print("card %2d  %5.1f s  %s" % (i, T, title), flush=True)
    lst = os.path.join(OUT, "list_split.txt")
    with open(lst, "w") as f:
        for s in segments:
            f.write("file '%s'\n" % s)
    joined = os.path.join(OUT, "joined_split.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    final = os.path.join(HERE, "dareskro_final_EN_split.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", joined, "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final], check=True)
    print("total %.1f s -> %s" % (total, final))


if __name__ == "__main__":
    main()
