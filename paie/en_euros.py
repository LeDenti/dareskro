#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The demo statement, labelled in euros — the currency it was computed in.

WHY. agent/bulletin_garde.py computed every line from euro parameters (point value
5.277 EUR, hourly rate in EUR, collective agreement IDCC 1996) and then labelled the
statement "USD" for the New York demo, because the dollar leg (Mastercard AP4M, RLUSD)
needed dollars. For a real Sunday shift in a French pharmacy the pay is in euros: the
payslip, the SEPA order and the escrow memo must all say EUR.

WHAT THIS SCRIPT DOES. It reads a statement, checks that its parameters are euro
parameters (point_value_eur, hourly_rate_eur), sets "currency" to "EUR" — and nothing
else: same lines, same amounts to the cent, same computed_at — then recomputes the
SHA-256 with the exact canonical rule of bulletin_garde.py (sort_keys, no spaces,
without sha256/status/validation). The result is a different statement with a
different hash, and it says where it comes from in a provenance file next to it.

Equivalent to `agent/bulletin_garde.py --devise EUR` run on the same evidence, minus
the computed_at it would stamp. Measured: see paie/README.md.

USAGE.  .venv/bin/python paie/en_euros.py [agent/sortie/bulletin.json]
        writes paie/sortie/bulletin_eur.json, app/public/bulletin_eur.json and
        paie/sortie/bulletin_eur.provenance.json
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")


def canonique(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def empreinte(bulletin):
    sans = {k: v for k, v in bulletin.items() if k not in ("sha256", "status", "validation")}
    return hashlib.sha256(canonique(sans)).hexdigest()


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "agent", "sortie", "bulletin.json")
    with open(src, encoding="utf-8") as f:
        b = json.load(f)
    if empreinte(b) != b.get("sha256"):
        sys.exit("REFUS : l'empreinte du bulletin source ne correspond pas à son contenu (%s)" % src)
    p = b.get("parameters", {})
    if "point_value_eur" not in p or "hourly_rate_eur" not in p:
        sys.exit("REFUS : les paramètres ne sont pas en euros (point_value_eur, hourly_rate_eur absents)")
    source_sha = b["sha256"]
    source_currency = b.get("currency")
    b["currency"] = "EUR"
    b["sha256"] = empreinte(b)

    outs = [os.path.join(HERE, "sortie", "bulletin_eur.json"),
            os.path.join(ROOT, "app", "public", "bulletin_eur.json")]
    for path in outs:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(b, f, indent=2, ensure_ascii=False)
            f.write("\n")
    prov = {
        "what": "the same statement with currency set to EUR, the currency of its parameters; no amount changed",
        "source": os.path.relpath(src, ROOT),
        "source_sha256": source_sha,
        "source_currency": source_currency,
        "result_sha256": b["sha256"],
        "rule": "SHA-256 of the canonical JSON (sort_keys, separators (',', ':'), without sha256/status/validation), as in agent/bulletin_garde.py",
        "equivalent_command": "agent/bulletin_garde.py --devise EUR (same amounts; computed_at would differ)",
    }
    with open(os.path.join(HERE, "sortie", "bulletin_eur.provenance.json"), "w", encoding="utf-8") as f:
        json.dump(prov, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("source   %s  %s  %s" % (os.path.relpath(src, ROOT), source_currency, source_sha))
    print("eur      %s  EUR  %s" % (os.path.relpath(outs[0], ROOT), b["sha256"]))
    print("net paid %s EUR, gross %s EUR, URSSAF %s, DGFiP %s" % (
        b["net_paid"], b["gross"], b["contributions"]["total_to_urssaf"], b["withholding"]["amount"]))


if __name__ == "__main__":
    main()
