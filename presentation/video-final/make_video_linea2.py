#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dareskro — La Linea, second version, closer to the cartoon.

One white line on a flat colour. The character walks on the line while an unseen
pencil draws it ahead of him; the things of the story rise out of the line as he
reaches them; when the line stops, he stops at its tip and complains. Captions
stay small, at the bottom, like subtitles. Narration: voice A; mumbles when he
complains; a small riff under everything.

Usage:  .venv/bin/python presentation/video-final/make_video_linea2.py [card indexes…]
Output: presentation/video-final/dareskro_final_EN_linea2.mp4
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import linea  # noqa: E402
from linea import (circle, rect, figure, padlock_strokes, clock_strokes, coin_strokes, document_strokes,  # noqa: E402
                   device_strokes, globe_strokes, check_strokes, cross_strokes, question_strokes, pharmacy_cross, seg_len, clamp, ease_out)
from make_video import OUT, narrate  # noqa: E402
from make_video_anim import FPS, voice_fx  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1280, 720
GY = 500            # the ground line, a little above the captions
LW = 7
PAUSE = 0.8
WALK_X = 430        # where the character stays on screen while the world scrolls
GAG = 2.0           # seconds for the end-of-line complaint
WHITE = (255, 255, 255)

# the cartoon's flat colours
BLUE, RED, GREEN, ORANGE, PURPLE, TEAL, PINK, BROWN = ((28, 84, 196), (206, 38, 38), (26, 142, 74), (232, 118, 22),
                                                        (118, 42, 160), (0, 136, 150), (200, 40, 110), (150, 84, 40))

# (background, title, caption, items, narration). Items: (world x, kind, params) drawn in order along the line.
CARDS = [
 (BLUE, "dareskro", "Pay that pays itself. On the XRP Ledger.",
  [(760, "pharmacy", {}), (1100, "coins", {"n": 3})],
  "Dareskro. Pay that pays itself, on the XRP Ledger."),
 (RED, "One rule", "A human decides. Code calculates. The ledger pays. The oracle only opens the door.",
  [(700, "document", {"label": "a human"}), (980, "device", {"label": "code"}), (1280, "padlock", {"label": "the ledger"}), (1560, "clock", {"label": "the oracle"})],
  "The rule is simple. A human decides. Code calculates. The ledger pays. And an oracle opens the door at the right moment, with no power over the money."),
 (GREEN, "1 · The pharmacist", "Sunday shift, 9 to 21. Badge: 12 h 12. Schedule: garde, Sunday, shutters open.",
  [(720, "pharmacy", {}), (1060, "clock", {"labels": ["badge 08:56 → 21:03", "schedule 09:00 → 21:00", "retained: 12 h"]})],
  "Example one. A pharmacist works a Sunday shift. The badge proves he was there: twelve hours and twelve minutes. The schedule says what those hours were: a Sunday shift, shutters open. Twelve hours retained."),
 (ORANGE, "Code computes the shift", "250.51 + 83.50 + 94.99 + 37.58 = 466.57",
  [(760, "bars", {"values": ["250.51", "83.50", "94.99", "37.58"], "total": "466.57"})],
  "Code computes the shift from the collective agreement, line by line. Shift time, overtime, Sunday allowance, seniority bonus. Four hundred sixty-six dollars fifty-seven. Deterministic, replayable to the cent."),
 (PURPLE, "A one-day contract", "+ 10 % end of contract · + 10 % paid leave · gross 564.55",
  [(760, "document", {"label": "CDD, one day", "seal": True}), (1080, "plus", {"lines": ["+ 46.66 end of contract", "+ 51.32 paid leave"], "total": "gross 564.55"})],
  "A Sunday shift by an outside pharmacist is a one-day fixed-term contract. So two indemnities are added: the end-of-contract bonus, ten percent, and the paid-leave allowance, ten percent. Gross: five hundred sixty-four fifty-five."),
 (TEAL, "The contributions", "employee 22 % → net 440.35 · employer 42 % · 361.31 to URSSAF, due the 15th",
  [(720, "coins", {"n": 2, "label": "net 440.35"}), (1060, "building", {"label": "URSSAF 361.31", "sub": "due 2026-11-15"})],
  "Then the contributions, at rates the agent bought with the rules. Net to the employee: four hundred forty thirty-five. To URSSAF: three hundred sixty-one thirty-one, due the fifteenth of next month."),
 (BLUE, "Two escrows, one signature session", "The net to the employee at the pay date. The contributions to URSSAF at the due date.",
  [(720, "device", {"label": "Ledger, twice"}), (1040, "fork", {"up": "employee · net", "down": "URSSAF · contributions"})],
  "The employer signs twice on the Ledger device: the net to the employee at the pay date, the contributions to URSSAF at the due date. Two escrows, locked the day the shift is validated. Nobody can forget them, nobody can divert them."),
 (RED, "The oracle, in real life", "An account. A birth certificate. One job: wait, finish, pay 12 drops.",
  [(740, "oracle", {}), (1100, "clock", {"spin": True}), (1400, "padlock", {"open": True, "coins": 3})],
  "So what is the oracle, in real life? An account on the ledger, with a name and a birth certificate. One job: wait for the date, submit the finish, pay the fee. Twelve drops. It never holds the money: the ledger moves it."),
 (ORANGE, "What it cannot do", "Pay early: refused. Redirect: no field. Cancel: nothing to cancel.",
  [(780, "padlock", {"big": True, "crosses": ["pay early", "redirect", "cancel"]})],
  "What it cannot do, by construction, not by promise. Pay early: the ledger refuses. Redirect: there is no such field. Cancel: the escrow has no cancel date. Nothing to cancel."),
 (GREEN, "If the oracle dies", "Anyone can finish after the date. The employee too.",
  [(820, "padlock", {"open": True, "coins": 3, "by": "the employee, or anyone"})],
  "And if the oracle dies? Anyone can finish the escrow after the date. The employee himself. The money goes where it was written. A good oracle is useful and not needed."),
 (PURPLE, "Dollars, through Mastercard", "The employee chooses: keep the XRP, or RLUSD through Agent Pay for Machines, after the ledger has released.",
  [(740, "coins", {"n": 3, "label": "XRP"}), (1040, "card", {"label": "RLUSD · Mastercard", "sub": "only after the ledger"})],
  "The employee chooses. Keep the XRP. Or dollars: RLUSD through Mastercard Agent Pay for Machines, settled only after the ledger has released. Nothing moves on Mastercard before the ledger has moved."),
 (TEAL, "2 · The freelancer", "Lagos and Paris. Fee behind a secret. Released on proof: the file at the agreed address, the agreed hash.",
  [(720, "globe", {}), (1060, "document", {"label": "file + hash"}), (1340, "padlock", {"open": True, "coins": 2})],
  "Example two. A freelancer in Lagos, a client in Paris. The fee is locked behind a secret. The oracle reads the file at the agreed address, compares its hash with the agreed one, and reveals the secret when they match. Nothing published by the deadline: the client is refunded."),
 (PINK, "3 · The influencer", "The post must still be there at the end of the period. Deleted post, no pay.",
  [(760, "post", {"live": True}), (1100, "post", {"live": False})],
  "Example three. An influencer places a product. The oracle checks that the post is still there at the end of the period, then releases. Deleted post, no pay: the brand is refunded."),
 (BROWN, "4 · Affiliate commissions", "Locked before the sale. The merchant's system confirms with a token. The release carries the order hash.",
  [(740, "padlocks", {"n": 5}), (1160, "document", {"label": "order hash", "seal": True})],
  "Example four. Affiliate commissions, one escrow per expected sale, locked before the sale. The merchant's own sales system confirms with a token given once, and the release carries the hash of the order. The merchant is a party, so the oracle judges nothing: it only guarantees the money was there first."),
 (BLUE, "Invisible to the public, visible to the administration", "The statement sealed for two readers. A zero-knowledge proof that the pay is lawful.",
  [(760, "sealed", {}), (1100, "check", {"label": "lawful · zero knowledge"})],
  "A salary must be invisible to the public and visible to the administration. The statement is sealed for two readers, the employee and the administration. On the chain, only hashes. And a zero-knowledge proof lets anyone check that the pay is lawful under the collective agreement, without learning who, or how many hours."),
 (GREEN, "Built this weekend, on testnet", "Signed on a Nano. Released by the oracle. Paid by the agent. Verified by anyone.",
  [(760, "checks", {"names": ["device", "oracle", "agent", "proof"]})],
  "All of this ran this weekend on testnet. The escrow signed on a Nano. Released by the oracle, by itself. The rules paid by the agent, by itself. The dollars settled after the ledger. The proof verified by anyone, in fifteen milliseconds."),
 (RED, "dareskro", "The AI reads. Code calculates. A human signs. The ledger pays. Not before.",
  [(900, "coins", {"n": 3})],
  "Dareskro. The AI reads. Code calculates. A human signs. The ledger pays. Not before."),
]
MUMBLE_AT = {1, 4, 8, 9, 12, 13}   # cards where the end-of-line complaint gets a voice

# The oracle's real loop (oracle/oracle.mjs, tick), trimmed to what the voice says — wait,
# finish, pay the fee — sits in the top right corner of every card, from the film's first
# second: the lines fall into place during the first card and then stay.
MONO = "/System/Library/Fonts/Menlo.ttc"
CODE = [
  "// oracle.mjs — the oracle's loop, every few seconds",
  "for (const e of reg.escrows) {",
  "  if (e.status !== \"waiting\") continue;",
  "  if (now() < e.finishAfter + CLOSE_TIME_MARGIN) continue; // wait",
  "  const res = await c.submitAndWait({",
  "    TransactionType: \"EscrowFinish\",",
  "    Account: wallet.classicAddress,",
  "    Owner: e.owner, OfferSequence: e.sequence,",
  "  }, { wallet, autofill: true });   // finish, fee: 12 drops",
  "  if (res.result.meta.TransactionResult === \"tesSUCCESS\")",
  "    e.status = \"finished\";",
  "}",
]


def mono(size):
    return ImageFont.truetype(MONO, size)


def draw_code(d, bg, t, reveal):
    """The code in the top right corner. On the first card the lines fall into place one after
    the other (first at 0.2 s, then one every 0.18 s) with a cursor; afterwards the block is
    simply there, whole, on every card."""
    size, step, x0, y0 = 14, 19, 672, 64
    f = mono(size)
    dim = tuple(int(c * 0.35 + w * 0.65) for c, w in zip(bg, WHITE))   # comments, a little softer
    t0, per = 0.2, 0.18
    n = len(CODE) if not reveal else (0 if t < t0 else min(len(CODE), int((t - t0) / per) + 1))
    y = y0
    cursor = None
    for ln in CODE[:n]:
        at = ln.find("//")
        if at >= 0:
            d.text((x0, y), ln[:at], font=f, fill=WHITE)
            d.text((x0 + d.textlength(ln[:at], font=f), y), ln[at:], font=f, fill=dim)
        else:
            d.text((x0, y), ln, font=f, fill=WHITE)
        cursor = (x0 + d.textlength(ln, font=f) + 2, y)
        y += step
    if reveal and cursor is not None and t < t0 + per * len(CODE) + 1.5 and int(t * 2.5) % 2 == 0:
        cx, cy = cursor
        d.rectangle((cx, cy + 1, cx + 8, cy + size + 2), fill=WHITE)


# ------------------------------------------------------------ the things of the story (world coordinates)
def building(x, y, w=150, h=120):
    s = [rect(x, y - h, w, h), [(x - 10, y - h), (x + w / 2, y - h - 36), (x + w + 10, y - h)]]
    for k in range(3):
        s.append(line(x + 25 + k * 50, y, x + 25 + k * 50, y - h + 18))
    return s


def line(x0, y0, x1, y1):
    return [(x0, y0), (x1, y1)]


def item_strokes(x, kind, p, t_local):
    """Strokes (world coordinates) and labels [(x, y, text, size, bold)] of one item; t_local = seconds since it was drawn."""
    S, L = [], []
    a = clamp(t_local / 1.0)
    if kind == "pharmacy":
        S += pharmacy_cross(x, GY)
    elif kind == "coins":
        for k in range(p.get("n", 3)):
            S += coin_strokes(x + k * 46, GY - 60 - (k % 2) * 6, spin=t_local * 3)
        if p.get("label"):
            L.append((x - 20, GY - 130, p["label"], 26, True))
    elif kind == "document":
        S += document_strokes(x, GY - 150, w=100, h=130, seal=p.get("seal", False) and t_local > 1.2)
        if p.get("label"):
            L.append((x - 10, GY - 185, p["label"], 24, True))
    elif kind == "device":
        S += device_strokes(x, GY - 110, w=140, h=84)
        if p.get("label"):
            L.append((x, GY - 150, p["label"], 24, True))
    elif kind == "padlock":
        s = 1.4 if p.get("big") else 1.0
        opened = ease_out(t_local, 1.0, 0.8) if p.get("open") else 0.0
        S += padlock_strokes(x, GY - 110 * s, s=s, open_=opened)
        if p.get("label"):
            L.append((x - 60, GY - 180 * s, p["label"], 24, True))
        for k in range(p.get("coins", 0)):
            b = ease_out(t_local, 1.9 + k * 0.15, 1.5)
            if b > 0:
                S += coin_strokes(x + 60 + 220 * b - k * 46, GY - 44, spin=b * 6)
        if p.get("by") and t_local > 3.2:
            L.append((x + 120, GY - 150, p["by"], 24, True))
        for k, lab_ in enumerate(p.get("crosses", [])):
            yy = GY - 215 + k * 44
            S += cross_strokes(x + 120, yy + 6, ease_out(t_local, 1.0 + k * 1.6, 0.4))
            if t_local > 1.0 + k * 1.6:
                L.append((x + 160, yy, lab_, 28, True))
    elif kind == "padlocks":
        for k in range(p.get("n", 5)):
            S += padlock_strokes(x + k * 64, GY - 60, s=0.55, open_=ease_out(t_local, 1.0 + k * 0.8, 0.5))
        L.append((x - 10, GY - 150, "one escrow per sale", 24, True))
    elif kind == "clock":
        ang = (t_local * 0.6) if p.get("spin") else clamp(t_local / 6.0) * 2.0
        S += clock_strokes(x, GY - 90, 62, ang)
        for k, lab_ in enumerate(p.get("labels", [])):
            if t_local > 0.8 + k * 2.4:
                L.append((x + 90, GY - 140 + k * 36, lab_, 24, k == 2))
        if p.get("label"):
            L.append((x - 60, GY - 190, p["label"], 24, True))
    elif kind == "bars":
        grow = clamp((t_local - 0.2) / 4.0) * 4
        S += linea.bar_strokes(x, GY, grow)
        for k, v in enumerate(p["values"]):
            if grow > k + 0.9:
                L.append((x + k * 95 + 12, GY + 14, v, 22, True))
        if t_local > 4.8:
            L.append((x + 420, GY - 150, "= " + p["total"], 40, True))
    elif kind == "plus":
        for k, ln in enumerate(p["lines"]):
            if t_local > 0.6 + k * 1.5:
                L.append((x - 20, GY - 170 + k * 40, ln, 26, True))
        if t_local > 3.8:
            S += [line(x - 20, GY - 92, x + 320, GY - 92)]
            L.append((x - 20, GY - 84, p["total"], 36, True))
    elif kind == "building":
        S += building(x, GY)
        L.append((x - 10, GY - 190, p["label"], 26, True))
        if p.get("sub") and t_local > 1.2:
            L.append((x - 10, GY - 160, p["sub"], 22, False))
    elif kind == "fork":
        # the line splits: one branch climbs to a second character (the employee), the other goes on to a building
        S.append([(x, GY), (x + 60, GY - 40), (x + 200, GY - 150)])
        S.append(figure(x + 300, GY - 150, s=0.8))
        S += padlock_strokes(x + 420, GY - 230, s=0.7, open_=ease_out(t_local, 2.5, 0.8))
        S += building(x + 330, GY, w=120, h=100)
        S += padlock_strokes(x + 540, GY - 60, s=0.7, open_=ease_out(t_local, 3.3, 0.8))
        L.append((x + 380, GY - 330, p["up"], 24, True))
        L.append((x + 300, GY + 14, p["down"], 24, True))
    elif kind == "oracle":
        S += document_strokes(x, GY - 160, w=90, h=120, seal=t_local > 1.5)
        L.append((x + 120, GY - 160, "rUuvu1X…", 30, True))
        if t_local > 1.5:
            L.append((x + 120, GY - 120, "born with a memo", 22, False))
    elif kind == "card":
        S += [rect(x, GY - 130, 180, 110), line(x, GY - 100, x + 180, GY - 100)]
        L.append((x + 12, GY - 160, p["label"], 24, True))
        if p.get("sub") and t_local > 1.4:
            L.append((x + 12, GY - 62, p["sub"], 22, False))
    elif kind == "globe":
        S += globe_strokes(x, GY - 110, 76, t_local / 6.0)
        L.append((x - 160, GY - 215, "Paris", 24, True))
        L.append((x + 110, GY - 215, "Lagos", 24, True))
    elif kind == "post":
        S += [rect(x, GY - 200, 110, 190), rect(x + 15, GY - 185, 80, 125)]
        if p["live"]:
            if t_local > 1.0:
                S += check_strokes(x + 55, GY - 230, clamp((t_local - 1.0) / 0.8))
            L.append((x - 10, GY + 14, "still there → paid", 22, True))
        else:
            if t_local > 1.0:
                S += cross_strokes(x + 40, GY - 225, clamp((t_local - 1.0) / 0.6))
            L.append((x - 20, GY + 14, "deleted → refunded", 22, True))
    elif kind == "sealed":
        S += document_strokes(x, GY - 160, w=100, h=130, seal=False)
        S += padlock_strokes(x + 50, GY - 60, s=0.6)
        L.append((x - 30, GY - 195, "sealed: employee + administration", 22, True))
    elif kind == "check":
        S += check_strokes(x, GY - 110, clamp((t_local - 0.3) / 1.0))
        if p.get("label") and t_local > 1.2:
            L.append((x - 90, GY - 40, p["label"], 24, True))
    elif kind == "checks":
        for k, n in enumerate(p["names"]):
            S += check_strokes(x + k * 200, GY - 110, clamp((t_local - 0.3 - k * 1.6) / 1.0))
            if t_local > 1.2 + k * 1.6:
                L.append((x + k * 200 - 40, GY - 40, n, 24, True))
    return S, L


WIDTH = {"fork": 660, "bars": 440, "padlocks": 360, "checks": 680, "plus": 380, "building": 200, "post": 150, "card": 220, "globe": 200, "clock": 160, "coins": 180, "document": 140, "device": 170, "padlock": 150, "oracle": 260, "sealed": 150, "check": 120, "pharmacy": 80}


def stroke_len(strokes):
    return sum(seg_len(s[i], s[i + 1]) for s in strokes for i in range(len(s) - 1))


# ------------------------------------------------------------ the timeline of a card
def timeline(items, T):
    """When the pencil reaches each item, how long it draws it, and the walking speed."""
    draw_times = []
    for x, kind, p in items:
        S, _ = item_strokes(x, kind, p, 99)
        draw_times.append(clamp(stroke_len(S) / 900.0, 0.8, 2.4))
    wide = bool(items) and WIDTH.get(items[-1][1], 180) > 300
    end_x = (items[-1][0] + WIDTH.get(items[-1][1], 180) + (40 if wide else 320)) if items else 1200
    usable = T - 0.6 - GAG - sum(draw_times)
    v = max(90.0, (end_x - 80) / max(2.0, usable))
    # events: (t_start, kind, x_or_index)
    ev, t, x = [], 0.6, 80.0
    for k, (ix, kind, p) in enumerate(items):
        dt = (ix - x) / v
        ev.append((t, "walk", x, ix)); t += dt; x = ix
        ev.append((t, "draw", k, draw_times[k])); t += draw_times[k]
    ev.append((t, "walk", x, end_x)); t += (end_x - x) / v
    ev.append((t, "end", wide, 0))
    return ev, v, end_x, t


def state(ev, v, end_x, t_end, t, xs):
    """At time t: the ground drawn to x, each item's draw fraction and local time, the character's x and mood."""
    ground = 80.0
    fr = {}
    walker_x = 80.0
    mood = "walk"
    stay = False
    for (t0, kind, a, b) in ev:
        if kind == "end":
            stay = a
            continue
        if kind == "walk":
            x0, x1 = a, b
            dur = (x1 - x0) / v
            if t >= t0 + dur:
                ground = x1
                if not (x1 == end_x and walker_x > x1 - 400):
                    walker_x = x1 - 130
            elif t >= t0:
                ground = x0 + (t - t0) * v
                if not (x1 == end_x and walker_x > x1 - 400):
                    walker_x = ground - 130
                return ground, fr, walker_x, "walk", t
            else:
                break
        else:
            k, dt = a, b
            if t >= t0 + dt:
                fr[k] = (1.0, t - t0)
                walker_x = xs[k] - 140
            elif t >= t0:
                fr[k] = ((t - t0) / dt, t - t0)
                return ground, fr, xs[k] - 140, "look", t
            else:
                break
    if t >= t_end:
        # the line stopped: he walks to the tip, then complains (or complains where he stands, after a wide thing)
        reach = clamp((t - t_end) / 0.6)
        if not stay:
            walker_x = ground - 130 + 115 * reach
        mood = "walk" if (reach < 1 and not stay) else "gag"
    return ground, fr, walker_x, mood, t


def draw_partial(d, strokes, frac, cam, lw):
    """Draw strokes in order up to a fraction of their total length (the pencil's progress)."""
    total = stroke_len(strokes)
    budget = total * frac
    drawn = 0.0
    tip = None
    for s in strokes:
        if len(s) < 2 or drawn >= budget:
            break
        pts = [s[0]]
        for i in range(len(s) - 1):
            l = seg_len(s[i], s[i + 1])
            if drawn + l <= budget:
                pts.append(s[i + 1]); drawn += l
            else:
                f = (budget - drawn) / l if l else 1
                pts.append((s[i][0] + (s[i + 1][0] - s[i][0]) * f, s[i][1] + (s[i + 1][1] - s[i][1]) * f)); drawn = budget
                break
        if len(pts) >= 2:
            d.line([(px - cam, py) for px, py in pts], fill=WHITE, width=lw, joint="curve")
        tip = pts[-1]
    return tip if frac < 1 else None


def frame(bg, title, caption, items, ev, v, end_x, t_end, t, T, reveal=False):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    ground, fr, wx, mood, _ = state(ev, v, end_x, t_end, t, [ix for ix, _, _ in items])
    cam = max(0.0, wx - WALK_X)
    # the ground line, from the left edge of the world to where the pencil is
    d.line((max(0, 0 - cam), GY, ground - cam, GY), fill=WHITE, width=LW)
    tip = (ground, GY) if mood == "walk" and t < t_end else None
    # the things, each drawn up to its fraction
    for k, (ix, kind, p) in enumerate(items):
        if k in fr:
            frac, tl = fr[k]
            S, L = item_strokes(ix, kind, p, tl if frac >= 1 else 0.0)
            tip2 = draw_partial(d, S, frac, cam, LW)
            if tip2 is not None:
                tip = tip2
            if frac >= 1:
                for (lx, ly, text, size, bold) in L:
                    d.text((lx - cam, ly), text, font=linea.font(size, bold), fill=WHITE)
    # the character: on the line, walking, looking, or complaining at the tip
    if mood == "walk":
        pts = figure(wx, GY, walk=t * 9, arm="down")
    elif mood == "look":
        pts = figure(wx, GY, arm="point")
    else:
        wave = math.sin((t - t_end) * 14)
        pts = figure(wx, GY, arm="up" if wave > 0 else "point")
        # the head leans over the edge
    d.line([(px - cam, py) for px, py in pts], fill=WHITE, width=LW, joint="curve")
    # the pencil's tip
    if tip is not None:
        tx, ty = tip[0] - cam, tip[1]
        d.ellipse((tx - 6, ty - 6, tx + 6, ty + 6), fill=WHITE)
        d.line((tx + 4, ty - 4, tx + 26, ty - 30), fill=WHITE, width=3)   # the pencil, from off-screen in spirit
    draw_code(d, bg, t, reveal)
    # title (small, top left) and caption (bottom, like a subtitle)
    d.text((40, 32), title.upper(), font=linea.font(22), fill=WHITE)
    f = linea.font(25, False)
    words, lines_, cur = caption.split(), [], ""
    for w_ in words:
        tt = (cur + " " + w_).strip()
        if d.textlength(tt, font=f) <= W - 160:
            cur = tt
        else:
            lines_.append(cur); cur = w_
    lines_.append(cur)
    y = H - 56 - 32 * (len(lines_) - 1)
    for ln in lines_:
        d.text(((W - d.textlength(ln, font=f)) / 2, y), ln, font=f, fill=WHITE)
        y += 32
    d.text((W - 110, 34), "dareskro", font=linea.font(16), fill=WHITE)
    return img


# ------------------------------------------------------------ sounds: the riff and the mumbles
def riff(path):
    if os.path.exists(path):
        return path
    # a jaunty eight-note loop, square-ish, one bar at 150 bpm; mixed low under the voice
    notes = [196.0, 261.6, 196.0, 329.6, 196.0, 261.6, 349.2, 329.6]
    expr = "+".join("(gte(mod(t\\,3.2)\\,%.2f)*lt(mod(t\\,3.2)\\,%.2f))*(0.5*sin(2*PI*%.1f*t)+0.25*sin(2*PI*%.1f*t))*exp(-6*mod(t\\,0.4))" % (k * 0.4, k * 0.4 + 0.4, f, f * 2) for k, f in enumerate(notes))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=%s:s=48000:d=3.2" % expr, "-ac", "2", path], check=True)
    return path


def folk_loop(path):
    """An original fingerpicked guitar loop, 12 bars in G at 90 bpm (32 s), in the spirit of a
    gentle folk ballad: plucked strings by Karplus-Strong, bass on the beat, arpeggio between.
    Nothing is borrowed from any recording. The note tails wrap around, so the loop is seamless."""
    if os.path.exists(path):
        return path
    import numpy as np
    import wave
    fs, bpm = 48000, 90
    eighth = 60.0 / bpm / 2
    # voicings, low string first (Hz): G, C, D, Em
    G = [98.00, 123.47, 146.83, 196.00, 246.94, 392.00]
    C = [130.81, 164.81, 196.00, 261.63, 329.63, 392.00]
    D = [146.83, 220.00, 293.66, 369.99, 440.00, 587.33]
    Em = [82.41, 123.47, 164.81, 196.00, 246.94, 329.63]
    bars = [G, G, C, G, G, D, Em, C, G, D, G, G]
    # one bar of picking, eight eighths: (string, velocity); bass on 1 and 3, thumb-and-fingers
    pattern = [(0, 1.0), (3, 0.55), (2, 0.65), (4, 0.55), (1, 0.85), (3, 0.55), (5, 0.7), (4, 0.5)]
    L = int(round(len(bars) * 8 * eighth * fs))
    left, right = np.zeros(L), np.zeros(L)
    rng = np.random.default_rng(7)

    def pluck(f, vel, secs=2.2):
        n = int(fs / f)
        buf = rng.uniform(-1, 1, n)
        buf = np.convolve(buf, [0.5, 0.5], mode="same")          # a softer attack than raw noise
        periods = int(secs * fs / n)
        out = np.empty(periods * n)
        decay = 0.996 if f < 200 else 0.993
        for k in range(periods):
            out[k * n:(k + 1) * n] = buf
            buf = decay * 0.5 * (buf + np.roll(buf, -1))
        return vel * out * np.linspace(1, 0.2, out.size)

    for b, chord in enumerate(bars):
        for e, (string, vel) in enumerate(pattern):
            t0 = int(round((b * 8 + e) * eighth * fs))
            vel *= 0.92 + 0.16 * rng.random()                        # a human hand, not a machine
            t0 += int(rng.integers(-fs // 400, fs // 400))             # a few milliseconds early or late
            note = pluck(chord[string], vel)
            idx = (np.arange(note.size) + t0) % L                       # wrap: the tails cross the loop point
            pan = 0.35 + 0.3 * string / 5                              # bass a little left, trebles a little right
            np.add.at(left, idx, note * (1 - pan))
            np.add.at(right, idx, note * pan)
    # a touch of room: one short echo
    d = int(0.083 * fs)
    left += 0.18 * np.roll(right, d)
    right += 0.18 * np.roll(left, d)
    peak = max(np.abs(left).max(), np.abs(right).max())
    pcm = (np.stack([left, right], axis=1) / peak * 0.6 * 32767).astype("<i2")
    raw = path.replace(".wav", "_raw.wav")
    with wave.open(raw, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(fs); w.writeframes(pcm.tobytes())
    # a fixed loudness, so the mix volume below means something
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-af", "loudnorm=I=-22:TP=-3:LRA=9", "-ar", str(fs), "-ac", "2", path], check=True)
    return path


def mumble(i, path):
    if os.path.exists(path):
        return path
    texts = ["ba da bada bla bla bada", "mm hm hmpf bla bada bo", "bla bla brr bada blu bla"]
    aiff = path.replace(".wav", ".aiff")
    subprocess.run(["say", "-v", "Samantha", "-r", "300", "-o", aiff, texts[i % 3]], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", aiff, "-af", "asetrate=48000*1.35,aresample=48000,atempo=0.9,volume=0.8", "-ar", "48000", "-ac", "2", path], check=True)
    return path


def build(only=None):
    os.makedirs(OUT, exist_ok=True)
    riff_wav = folk_loop(os.path.join(OUT, "folk32.wav"))      # the music under everything, looped
    segments, total = [], 0.0
    for i, (bg, title, caption, items, narr) in enumerate(CARDS):
        if only and i not in only:
            continue
        wav, vdur = narrate(100 + i, narr)
        wav = voice_fx(wav)
        T = math.ceil((vdur + PAUSE + 0.6) * 10) / 10
        ev, v, end_x, t_end = timeline(items, T - GAG)
        n = int(T * FPS)
        seg = os.path.join(OUT, "l2_%02d.mp4" % i)
        cmd = ["ffmpeg", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
               "-i", wav, "-stream_loop", "-1", "-i", riff_wav]
        filt = "[1]apad[v];[2]volume=0.7[r];"
        if i in MUMBLE_AT:
            m = mumble(i, os.path.join(OUT, "mumble%d.wav" % (i % 3)))
            cmd += ["-itsoffset", "%.2f" % (t_end + 0.5), "-i", m]
            filt += "[3]apad[m];[v][r][m]amix=inputs=3:duration=first:normalize=0[a]"
        else:
            filt += "[v][r]amix=inputs=2:duration=first:normalize=0[a]"
        cmd += ["-filter_complex", filt, "-map", "0:v", "-map", "[a]", "-t", str(T),
                "-vf", "fade=t=in:st=0:d=0.25,fade=t=out:st=%.1f:d=0.3,format=yuv420p" % (T - 0.3),
                "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(FPS),
                "-c:a", "aac", "-b:a", "160k", "-ar", "48000", seg]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for k in range(n):
            t = k / FPS
            p.stdin.write(frame(bg, title, caption, items, ev, v, end_x, t_end, t, T, reveal=(i == 0)).tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit("ffmpeg failed on card %d" % i)
        segments.append(seg)
        total += T
        print("card %2d  %5.1f s  v=%3.0f px/s  %s" % (i, T, v, title), flush=True)
    lst = os.path.join(OUT, "list_l2.txt")
    with open(lst, "w") as f:
        for s in segments:
            f.write("file '%s'\n" % s)
    joined = os.path.join(OUT, "joined_l2.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    final = os.path.join(HERE, "dareskro_final_EN_linea2.mp4" if not only else "linea2_test.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", joined, "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final], check=True)
    print("total %.1f s -> %s" % (total, final))
    return final


if __name__ == "__main__":
    idx = [int(a) for a in sys.argv[1:]] if len(sys.argv) > 1 else None
    build(idx)
