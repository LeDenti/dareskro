#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dareskro — the final English explainer, built entirely on the Mac.

Cards drawn with Pillow in the style of the existing videos (flat colour, white
line art, title + subtitle), narration with macOS `say`, assembly with ffmpeg.
Each card lasts as long as its narration plus a breath, so the voice and the
image never drift apart.

Usage:  .venv/bin/python presentation/video-final/make_video.py
Output: presentation/video-final/dareskro_final_EN.mp4
"""
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build")
W, H = 1280, 720
VOICE = os.environ.get("VOICE", "Samantha")
RATE = os.environ.get("RATE", "182")          # words per minute
PAUSE = 0.9                                    # seconds of air after each card's narration
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
WHITE = (255, 255, 255)

# Palette of the existing dareskro videos.
ORANGE, PINK, TEAL, BLUE, YELLOW, PURPLE, RUST, NAVY, GREEN, VIOLET = (
    (242, 107, 29), (214, 36, 92), (10, 163, 181), (30, 79, 214), (245, 180, 0),
    (58, 24, 96), (200, 80, 42), (15, 47, 127), (46, 158, 91), (90, 45, 145))

# --------------------------------------------------------------------- script
# (background, title, subtitle, icon, narration)
CARDS = [
    (NAVY, "dareskro", "Pay that pays itself. On the XRP Ledger.", "walk",
     "Dareskro. Pay that pays itself, on the XRP Ledger. Four examples, one rule."),
    (BLUE, "One rule", "A human decides. Code calculates. The ledger pays.", "rule",
     "The rule is simple. A human decides. Code calculates. The ledger pays. "
     "And an oracle opens the door at the right moment, with no power over the money."),
    (ORANGE, "1 · Variable pay", "Paid according to the collective agreements. A healthcare job with long, irregular hours: a pharmacist, Sunday shift 9 to 21, badge 12 h 12, retained 12 h.", "clock",
     "Example one. Variable pay, computed according to the collective agreements of the profession. "
     "Take a healthcare job with wide working-hour amplitudes: nights, Sundays, on-call shifts. "
     "A pharmacist works a Sunday shift, nine to twenty-one. "
     "The badge proves he was there: twelve hours and twelve minutes. The schedule qualifies the hours: twelve. "
     "An agent reads both. The badge never qualifies an hour; only the schedule does."),
    (TEAL, "Code computes", "250.51 + 83.50 + 94.99 + 37.58 = $466.57", "stack",
     "Code computes the pay from the collective agreement, line by line. "
     "Shift time, overtime, Sunday allowance, seniority bonus. "
     "Four hundred sixty-six dollars fifty-seven. Replayable to the cent, three years later."),
    (PURPLE, "A human signs on a Ledger device", "Dollars owed, XRP locked at the day's rate · Destination · Pay date · Hash · Oracle", "device",
     "A named person validates the statement. Then the employer signs the escrow on a Ledger device. "
     "The pay is in dollars; the escrow holds the same value in XRP at the rate of the moment, and the device shows both. "
     "It also shows the destination, the pay date, the hash of the statement, "
     "and the name of the oracle. Nothing moves before that signature."),
    (VIOLET, "The oracle, in real life", "An account. A birth certificate. A small program.", "oracle",
     "So what is the oracle, in real life? Three things. An account on the XRP Ledger, with a name. "
     "A birth certificate: one transaction that says what it is, for anyone to read. "
     "And a small program that watches the escrows it is cited in."),
    (VIOLET, "One job", "Wait for the date. Submit the finish. Pay 12 drops. Then the employee's choice: crypto, or dollars via Mastercard.", "oracle_job",
     "Its only job: wait for the pay date, submit the finish, pay the fee. Twelve drops. "
     "It never holds the money. The ledger releases the value, and the employee chooses: "
     "keep the crypto, the XRP the ledger released; or dollars, RLUSD settled through Mastercard Agent Pay for Machines, "
     "triggered by the ledger's release and nothing else. Both ran this weekend."),
    (RUST, "What it cannot do", "Pay early: refused. Redirect: no field. Cancel: nothing to cancel.", "lock",
     "What it cannot do, by construction, not by promise. Pay early: the ledger refuses. "
     "Redirect: there is no such field. Cancel: the escrow has no cancel date. "
     "We tried all three on testnet. All three failed."),
    (BLUE, "If the oracle dies", "Anyone can finish after the date. The employee too.", "open",
     "And if the oracle dies? Anyone can finish the escrow after the date. The employee himself. "
     "The money goes where it was written. A good oracle is useful, and not needed."),
    (GREEN, "2 · The real-estate agent", "Nothing at the preliminary contract. Everything at the deed. Oracle: the notary's signature, then the official publication of the sale.", "notary",
     "Example two. A real-estate agent. Nothing is owed at the preliminary contract, everything at the deed. "
     "The escrow holds the commission behind a secret. The oracle is in two steps: "
     "the notary's signature on the deed releases the secret, and the official publication of the sale "
     "confirms it for anyone to check. Neither the notary nor the public record is a party to the deal."),
    (PINK, "3 · The freelancer", "Lagos and Paris. Released on proof of delivery. Oracle: the service.", "globe",
     "Example three. A freelancer in Lagos, a client in Paris. The oracle holds the secret "
     "and reveals it when delivery is proven. It cannot steal: the money goes to the written destination. "
     "It can only block, and blocking ends at the deadline, with a refund."),
    (YELLOW, "4 · Influencer and affiliate", "Product placement: paid when the post is live, and still live at the date. Commissions: one escrow per sale.", "shop",
     "Example four. An influencer places a product. The brand locks the fee. The oracle checks that the post "
     "is live at the agreed address, and still live thirty days later, then releases. Deleted post, no pay. "
     "Affiliate commissions: one escrow per expected sale, released by the merchant's sales system, automatically. "
     "The merchant is a party, so the money is locked before the sale. "
     "Or no oracle at all: the customer pays through dareskro and the commission splits at source."),
    (NAVY, "The question that sorts oracles", "Is it a party to the dispute?", "question",
     "The question that sorts oracles is not whether it can disappear. "
     "It is whether it is a party to the dispute. An oracle with a stake is not an oracle. "
     "We put it where it has nothing to gain, or we remove it."),
    (ORANGE, "The agent pays for its evidence", "0.05 RLUSD a query · Mastercard Agent Pay for Machines · inside a cap", "coins",
     "One more thing. The agent buys the collective-agreement rules it needs. "
     "Five cents a query, on Mastercard Agent Pay for Machines, inside a budget the employer set. "
     "Nobody clicks. Every cent leaves a proof on the ledger."),
    (TEAL, "Built this weekend, on testnet", "Signed on device. Released by the oracle alone. Paid by the agent alone.", "check",
     "All of this ran this weekend on testnet. The escrow signed on the device. "
     "The oracle released it by itself, twelve seconds after the date. The agent paid by itself. "
     "Every step has a hash you can open."),
    (NAVY, "dareskro", "The AI reads. Code calculates. A human signs. The ledger pays. Not before.", "walk_end",
     "Dareskro. The AI reads. Code calculates. A human signs. The ledger pays. Not before."),
]


# ----------------------------------------------------------------- drawing
def font(size, bold=True):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def text_centered(d, y, s, size, bold=True, fill=WHITE):
    f = font(size, bold)
    w = d.textlength(s, font=f)
    d.text(((W - w) / 2, y), s, font=f, fill=fill)


def wrap(d, s, size, bold, max_w):
    f = font(size, bold)
    words, lines, cur = s.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if d.textlength(t, font=f) <= max_w:
            cur = t
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def person(d, x, y, s=1.0, arms="down", lw=5):
    """A white line figure: head, body, arms, legs. (x, y) is the feet line."""
    r = 26 * s
    hx, hy = x, y - 150 * s
    d.ellipse((hx - r, hy - r, hx + r, hy + r), outline=WHITE, width=lw)
    d.line((x, hy + r, x, y - 55 * s), fill=WHITE, width=lw)                 # body
    if arms == "down":
        d.line((x, y - 110 * s, x - 38 * s, y - 60 * s), fill=WHITE, width=lw)
        d.line((x, y - 110 * s, x + 38 * s, y - 60 * s), fill=WHITE, width=lw)
    elif arms == "up":
        d.line((x, y - 110 * s, x - 45 * s, y - 150 * s), fill=WHITE, width=lw)
        d.line((x, y - 110 * s, x + 45 * s, y - 150 * s), fill=WHITE, width=lw)
    elif arms == "point":
        d.line((x, y - 110 * s, x - 30 * s, y - 70 * s), fill=WHITE, width=lw)
        d.line((x, y - 110 * s, x + 60 * s, y - 112 * s), fill=WHITE, width=lw)
    d.line((x, y - 55 * s, x - 30 * s, y), fill=WHITE, width=lw)             # legs
    d.line((x, y - 55 * s, x + 30 * s, y), fill=WHITE, width=lw)


def ground(d, y, x0=120, x1=W - 120, lw=5):
    d.line((x0, y, x1, y), fill=WHITE, width=lw)


def clock(d, cx, cy, r, lw=5):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=WHITE, width=lw)
    d.line((cx, cy, cx, cy - r * 0.6), fill=WHITE, width=lw)
    d.line((cx, cy, cx + r * 0.45, cy + r * 0.2), fill=WHITE, width=lw)


def padlock(d, cx, cy, s=1.0, lw=5, open_=False):
    w, h = 90 * s, 70 * s
    d.rounded_rectangle((cx - w / 2, cy, cx + w / 2, cy + h), radius=10 * s, outline=WHITE, width=lw)
    r = 32 * s
    if open_:
        # shackle lifted: attached on the right, a gap on the left
        lift = 22 * s
        d.arc((cx - r, cy - 2 * r - lift, cx + r, cy - lift), 180, 360, fill=WHITE, width=lw)
        d.line((cx + r, cy - r - lift, cx + r, cy), fill=WHITE, width=lw)
        d.line((cx - r, cy - r - lift, cx - r, cy - r - lift + 14 * s), fill=WHITE, width=lw)
    else:
        d.arc((cx - r, cy - 2 * r, cx + r, cy), 180, 360, fill=WHITE, width=lw)
        d.line((cx - r, cy - r, cx - r, cy), fill=WHITE, width=lw)
        d.line((cx + r, cy - r, cx + r, cy), fill=WHITE, width=lw)
    d.ellipse((cx - 7 * s, cy + 25 * s, cx + 7 * s, cy + 39 * s), outline=WHITE, width=lw)


def coins(d, x, y, n=4, r=18, lw=4):
    for i in range(n):
        cx = x + i * (r * 2 + 14)
        d.ellipse((cx - r, y - r, cx + r, y + r), outline=WHITE, width=lw)
        d.ellipse((cx - r * 0.45, y - r * 0.45, cx + r * 0.45, y + r * 0.45), outline=WHITE, width=lw - 1)


def document(d, x, y, w=110, h=140, lw=5, seal=False):
    d.rounded_rectangle((x, y, x + w, y + h), radius=8, outline=WHITE, width=lw)
    for i in range(4):
        d.line((x + 18, y + 30 + i * 24, x + w - 18 - (28 if i == 3 else 0), y + 30 + i * 24), fill=WHITE, width=3)
    if seal:
        d.ellipse((x + w - 50, y + h - 50, x + w - 10, y + h - 10), outline=WHITE, width=4)


def device(d, x, y, w=150, h=90, lw=5):
    d.rounded_rectangle((x, y, x + w, y + h), radius=12, outline=WHITE, width=lw)
    d.rounded_rectangle((x + 18, y + 16, x + w - 18, y + h - 16), radius=6, outline=WHITE, width=3)
    d.ellipse((x + w - 34, y + h / 2 - 8, x + w - 18, y + h / 2 + 8), outline=WHITE, width=3)


def stack(d, x, y, n=4, lw=5):
    for i in range(n):
        h = 40 + i * 22
        d.arc((x + i * 95, y - h, x + i * 95 + 80, y + h), 180, 360, fill=WHITE, width=lw)
        d.line((x + i * 95, y, x + i * 95 + 80, y), fill=WHITE, width=lw)


def icon(d, name):
    gy = 560
    if name in ("walk", "walk_end"):
        ground(d, gy)
        person(d, 520 if name == "walk" else 740, gy, arms="point" if name == "walk" else "down")
        d.line((790, gy, 790, gy - 70), fill=WHITE, width=5)
        d.line((775, gy - 50, 805, gy - 50), fill=WHITE, width=5)
        d.line((790, gy - 65, 790, gy - 35), fill=WHITE, width=5)   # the pharmacy cross
    elif name == "rule":
        ground(d, gy)
        person(d, 380, gy)
        d.text((430, gy - 150), "→", font=font(80), fill=WHITE)
        document(d, 520, gy - 150, seal=True)
        d.text((650, gy - 150), "→", font=font(80), fill=WHITE)
        padlock(d, 790, gy - 110)
        d.text((850, gy - 150), "→", font=font(80), fill=WHITE)
        coins(d, 940, gy - 60, n=3)
    elif name == "clock":
        ground(d, gy)
        person(d, 470, gy, arms="point")
        clock(d, 700, gy - 90, 70)
    elif name == "stack":
        ground(d, gy)
        person(d, 380, gy)
        stack(d, 470, gy)
    elif name == "device":
        ground(d, gy)
        person(d, 470, gy, arms="point")
        device(d, 620, gy - 110)
        d.text((800, gy - 125), "466.57 XRP", font=font(30), fill=WHITE)
        d.text((800, gy - 85), "2026-10-25 · rUuvu1X…", font=font(24, False), fill=WHITE)
    elif name == "oracle":
        ground(d, gy)
        # the oracle: a figure with a document (birth certificate) and a tiny program (device)
        person(d, 420, gy)
        document(d, 540, gy - 160, seal=True)
        device(d, 700, gy - 110, w=130, h=80)
        d.text((850, gy - 150), "rUuvu1X…", font=font(30), fill=WHITE)
        d.text((850, gy - 108), "born 15:51 UTC", font=font(24, False), fill=WHITE)
    elif name == "oracle_job":
        ground(d, gy)
        clock(d, 330, gy - 90, 55)
        d.text((410, gy - 125), "→", font=font(80), fill=WHITE)
        person(d, 540, gy, arms="point")
        padlock(d, 690, gy - 110, open_=True)
        d.text((770, gy - 125), "→", font=font(80), fill=WHITE)
        coins(d, 880, gy - 60, n=3)
        person(d, 1010, gy, arms="up")
    elif name == "lock":
        ground(d, gy)
        person(d, 450, gy, arms="point")
        padlock(d, 640, gy - 110, s=1.3)
        for k, label in enumerate(("pay early", "redirect", "cancel")):
            yy = gy - 150 + k * 40
            d.line((765, yy + 6, 787, yy + 28), fill=WHITE, width=5)   # a drawn cross: Arial has no ✕
            d.line((787, yy + 6, 765, yy + 28), fill=WHITE, width=5)
            d.text((805, yy), label, font=font(28), fill=WHITE)
    elif name == "open":
        ground(d, gy)
        padlock(d, 420, gy - 110, open_=True)
        coins(d, 540, gy - 60, n=4)
        person(d, 820, gy, arms="up")
    elif name == "notary":
        ground(d, gy)
        person(d, 360, gy)
        document(d, 480, gy - 160, seal=True)
        person(d, 660, gy, arms="point")
        d.text((720, gy - 150), "NOTARY", font=font(30), fill=WHITE)
        padlock(d, 900, gy - 110, open_=True)
    elif name == "globe":
        ground(d, gy)
        person(d, 330, gy)
        d.text((290, gy - 215), "Paris", font=font(26), fill=WHITE)
        d.ellipse((560, gy - 190, 720, gy - 30), outline=WHITE, width=5)
        d.ellipse((610, gy - 190, 670, gy - 30), outline=WHITE, width=3)
        d.line((560, gy - 110, 720, gy - 110), fill=WHITE, width=3)
        person(d, 950, gy, arms="up")
        d.text((905, gy - 215), "Lagos", font=font(26), fill=WHITE)
    elif name == "shop":
        ground(d, gy)
        d.rounded_rectangle((330, gy - 140, 560, gy), radius=8, outline=WHITE, width=5)
        d.polygon([(310, gy - 140), (445, gy - 200), (580, gy - 140)], outline=WHITE, width=5)
        for i in range(5):
            padlock(d, 680 + i * 75, gy - 70, s=0.5, lw=3)
        d.text((680, gy - 150), "5 escrows, one per sale", font=font(24, False), fill=WHITE)
    elif name == "question":
        ground(d, gy)
        person(d, 450, gy)
        d.text((560, gy - 230), "?", font=font(150), fill=WHITE)
        person(d, 800, gy)
    elif name == "coins":
        ground(d, gy)
        person(d, 380, gy, arms="point")
        d.text((470, gy - 145), "402", font=font(44), fill=WHITE)
        d.text((590, gy - 125), "→", font=font(80), fill=WHITE)
        coins(d, 700, gy - 60, n=1)
        d.text((750, gy - 72), "0.05 RLUSD", font=font(28), fill=WHITE)
        document(d, 950, gy - 160, w=90, h=120)
    elif name == "check":
        ground(d, gy)
        for i, s in enumerate(("device", "oracle", "agent")):
            x = 380 + i * 230
            d.ellipse((x - 40, gy - 150, x + 40, gy - 70), outline=WHITE, width=5)
            d.line((x - 22, gy - 110, x - 6, gy - 92), fill=WHITE, width=6)
            d.line((x - 6, gy - 92, x + 26, gy - 130), fill=WHITE, width=6)
            d.text((x - 40, gy - 50), s, font=font(26), fill=WHITE)


def render_card(i, bg, title, subtitle, ic):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    tsize = 56 if len(title) < 30 else 46
    text_centered(d, 70, title, tsize)
    y = 150
    for line in wrap(d, subtitle, 28, False, 1040):
        text_centered(d, y, line, 28, False)
        y += 38
    icon(d, ic)
    d.text((W - 170, H - 44), "dareskro", font=font(22), fill=WHITE)
    path = os.path.join(OUT, "card%02d.png" % i)
    img.save(path)
    return path


# ------------------------------------------------------------------ audio
def narrate(i, text):
    aiff = os.path.join(OUT, "voice%02d.aiff" % i)
    wav = os.path.join(OUT, "voice%02d.wav" % i)
    subprocess.run(["say", "-v", VOICE, "-r", RATE, "-o", aiff, text], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", aiff, "-ar", "48000", "-ac", "2", wav], check=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", wav], capture_output=True, text=True).stdout.strip())
    return wav, dur


def main():
    os.makedirs(OUT, exist_ok=True)
    segments, total = [], 0.0
    for i, (bg, title, sub, ic, narr) in enumerate(CARDS):
        png = render_card(i, bg, title, sub, ic)
        wav, vdur = narrate(i, narr)
        dur = math.ceil((vdur + PAUSE) * 10) / 10
        seg = os.path.join(OUT, "seg%02d.mp4" % i)
        # image + voice, padded with silence to `dur`, fade in/out on the picture
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", "25", "-i", png, "-i", wav,
            "-t", str(dur), "-vf", "fade=t=in:st=0:d=0.4,fade=t=out:st=%.1f:d=0.4,format=yuv420p" % (dur - 0.4),
            "-af", "apad,atrim=0:%s,afade=t=in:st=0:d=0.1" % dur,
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "25",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest", seg], check=True)
        segments.append(seg)
        total += dur
        print("card %2d  %5.1f s  %s" % (i, dur, title))
    lst = os.path.join(OUT, "list.txt")
    with open(lst, "w") as f:
        for s in segments:
            f.write("file '%s'\n" % s)
    joined = os.path.join(OUT, "joined.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    final = os.path.join(HERE, "dareskro_final_EN.mp4")
    # one more pass: room loudness, same picture
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", joined, "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final], check=True)
    print("total %.1f s -> %s" % (total, final))
    with open(os.path.join(HERE, "script_EN.json"), "w") as f:
        json.dump([{"title": c[1], "subtitle": c[2], "narration": c[4]} for c in CARDS], f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
