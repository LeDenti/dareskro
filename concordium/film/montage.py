#!/usr/bin/env python3
"""Assembles the Concordium demo: each shot recorded by film.mjs is cut from the moment its page was
ready, shots are joined scene by scene, and each scene's narration (voix/<id>.aiff) starts 0.5 s in.
    python3 montage.py   -> sortie/dareskro_accountable_concordium.mp4
"""
import json, subprocess, pathlib, sys
ICI = pathlib.Path(__file__).parent
P, V, OUT = ICI / "prises", ICI / "voix", ICI / "sortie"
OUT.mkdir(exist_ok=True)
SCRIPT = json.load(open(ICI / "script.json"))
PLANS = json.load(open(P / "plans.json"))
FPS, AVANCE = 25, 0.5

def run(c):
    r = subprocess.run([str(x) for x in c], capture_output=True, text=True)
    if r.returncode: sys.exit("ffmpeg: " + r.stderr[-2000:])

clips, voix, horloge = [], [], 0.0
for sc in SCRIPT:
    debut_scene = horloge
    for n, s in enumerate(PLANS[sc["id"]]):
        out = OUT / f"c_{sc['id']}_{n}.mp4"
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{s['debut']:.2f}", "-t", f"{s['duree']:.2f}", "-i", s["fichier"],
             "-vf", f"fps={FPS},scale=1920:1080,format=yuv420p", "-an", "-c:v", "libx264", "-crf", "20", "-preset", "medium", out])
        clips.append(out); horloge += s["duree"]
    voix.append((V / f"{sc['id']}.aiff", debut_scene + AVANCE))

liste = OUT / "liste.txt"; liste.write_text("".join(f"file '{c}'\n" for c in clips))
muet = OUT / "muet.mp4"
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", liste, "-c", "copy", muet])
entrees, filtres = [], []
for i, (f, t) in enumerate(voix):
    entrees += ["-i", f]; ms = int(t * 1000); filtres.append(f"[{i+1}:a]adelay={ms}|{ms},aresample=44100[a{i}]")
mix = ";".join(filtres) + ";" + "".join(f"[a{i}]" for i in range(len(voix))) + f"amix=inputs={len(voix)}:normalize=0,apad[a]"
final = OUT / "dareskro_accountable_concordium.mp4"
run(["ffmpeg", "-y", "-loglevel", "error", "-i", muet, *entrees, "-filter_complex", mix, "-map", "0:v", "-map", "[a]",
     "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", final])
d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size", "-of", "json", final], capture_output=True, text=True).stdout
f = json.loads(d)["format"]; print(f"{final.name}: {float(f['duration']):.1f} s, {int(f['size'])/1e6:.1f} MB")
for x in clips + [muet, liste]: x.unlink()
