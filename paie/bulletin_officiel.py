#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The official payslip, in PDF, from the very JSON the escrow memo hashes.

ONE SOURCE. agent/sortie/bulletin.json (or its euro twin, paie/sortie/bulletin_eur.json)
is the statement: lines, gross, contributions, tax, net paid, sources, SHA-256. The pay
desk puts that SHA-256 in the escrow memo. This script lays the SAME file out as a French
payslip and prints that SHA-256 on it. It never recomputes the pay; it re-checks it:

  - the file's sha256 must equal the SHA-256 of its canonical form (the rule of
    bulletin_garde.py), otherwise the script refuses;
  - every remuneration line is recomputed from base x rate and must match the amount in
    the file to the cent (ROUND_HALF_UP), otherwise the script refuses;
  - gross = sum of the lines, net = gross - employee contributions, paid = net - tax,
    employer cost = gross + employer contributions, otherwise the script refuses.

DETERMINISTIC. Same JSON + same employer file -> byte-identical PDF (reportlab's
invariant mode: fixed creation date, fixed document ID). So the PDF has a stable
SHA-256 of its own, written next to it in paie/sortie/<name>.pdf.sha256.

WHAT IS ON IT (Code du travail art. R3243-1, simplified model of the arrêté of
25/02/2016 as amended; montant net social since 2023): employer (name, address, SIRET,
APE, URSSAF), collective agreement, employee (name, job, classification), period and
hours, the lines with base and rate, gross, contributions in the legal rubrics, net
before tax, net social amount, income tax at source (base, rate, amount), net paid,
employer cost, paid leave, payment date, the two legal notices. What is NOT real yet is
said on the sheet itself: the contribution rates are aggregated indicative rates until
the real rates are entered (taux_reels_saisis in the employer file), and the example
employer file is marked as such. See paie/README.md for what is still missing for the
sheet to be opposable (DSN, real rates, payroll software).

USAGE.  .venv/bin/python paie/bulletin_officiel.py [bulletin.json] [--employeur FILE]
            [--sortie FILE.pdf] [--validateur "Name"] [--bureau]
        defaults: paie/sortie/bulletin_eur.json if present else agent/sortie/bulletin.json;
        paie/employeur.json if present else paie/employeur.exemple.json;
        paie/sortie/bulletin_officiel.pdf (paie/sortie/reel/ when the real employer file is used);
        --bureau also copies the PDF to ~/Desktop.
"""
import hashlib
import json
import os
import shutil
import sys
from decimal import Decimal, ROUND_HALF_UP

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table,
                                TableStyle)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CENT = Decimal("0.01")

ENCRE = colors.HexColor("#1A1A1A")
GRIS = colors.HexColor("#5A5A5A")
TRAIT = colors.HexColor("#C8C8C8")
FOND = colors.HexColor("#F2F2F2")
ALERTE = colors.HexColor("#8A1C1C")

S = {
    "titre": ParagraphStyle("titre", fontName="Helvetica-Bold", fontSize=15, leading=18, textColor=ENCRE),
    "sous": ParagraphStyle("sous", fontName="Helvetica", fontSize=9.5, leading=12, textColor=GRIS),
    "bloc_t": ParagraphStyle("bloc_t", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=GRIS),
    "bloc": ParagraphStyle("bloc", fontName="Helvetica", fontSize=8.6, leading=10.6, textColor=ENCRE),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.3, leading=10, textColor=ENCRE),
    "cell_g": ParagraphStyle("cell_g", fontName="Helvetica", fontSize=7.2, leading=8.8, textColor=GRIS),
    "cell_b": ParagraphStyle("cell_b", fontName="Helvetica-Bold", fontSize=8.5, leading=10.5, textColor=ENCRE),
    "num": ParagraphStyle("num", fontName="Helvetica", fontSize=8.5, leading=10.5, alignment=TA_RIGHT),
    "num_b": ParagraphStyle("num_b", fontName="Helvetica-Bold", fontSize=8.5, leading=10.5, alignment=TA_RIGHT),
    "num_g": ParagraphStyle("num_g", fontName="Helvetica", fontSize=7.2, leading=8.8, alignment=TA_RIGHT, textColor=GRIS),
    "h": ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=7.5, leading=9.5, textColor=GRIS),
    "hn": ParagraphStyle("hn", fontName="Helvetica-Bold", fontSize=7.5, leading=9.5, textColor=GRIS, alignment=TA_RIGHT),
    "alerte": ParagraphStyle("alerte", fontName="Helvetica-Bold", fontSize=8, leading=10.5, textColor=ALERTE, alignment=TA_CENTER),
    "note": ParagraphStyle("note", fontName="Helvetica", fontSize=7.3, leading=9.2, textColor=GRIS),
    "mention": ParagraphStyle("mention", fontName="Helvetica-Oblique", fontSize=7.3, leading=9.2, textColor=ENCRE),
    "mono": ParagraphStyle("mono", fontName="Courier", fontSize=7.2, leading=9, textColor=ENCRE),
}


# ----------------------------------------------------------------- helpers

def dec(x):
    return Decimal(str(x))


def cents(d):
    return dec(d).quantize(CENT, ROUND_HALF_UP)


def fr(d, unite=""):
    """1234.5 -> '1 234,50' (French number formatting, non-breaking thin spaces avoided: cp1252)."""
    d = cents(d)
    neg = d < 0
    d = abs(d)
    ent, frac = divmod(int(d * 100), 100)
    groupes = []
    s = str(ent)
    while len(s) > 3:
        groupes.insert(0, s[-3:])
        s = s[:-3]
    groupes.insert(0, s)
    out = "%s%s,%02d" % ("- " if neg else "", " ".join(groupes), frac)
    return out + unite


def taux_pct(t):
    """Decimal rate -> '7,50 %' / '22,00 %'."""
    v = dec(t) * 100
    s = ("%.2f" % v).replace(".", ",")
    return s + " %"


def date_fr(iso):
    y, m, d = iso[:10].split("-")
    return "%s/%s/%s" % (d, m, y)


def canonique(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def empreinte(bulletin):
    sans = {k: v for k, v in bulletin.items() if k not in ("sha256", "status", "validation")}
    return hashlib.sha256(canonique(sans)).hexdigest()


def sha256_fichier(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloc in iter(lambda: f.read(1 << 16), b""):
            h.update(bloc)
    return h.hexdigest()


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def P(text, style="cell"):
    return Paragraph(esc(text) if "<b>" not in text and "<br/>" not in text else text, S[style])


def garde_cp1252(textes):
    """reportlab's built-in fonts encode cp1252 only; a stray character prints as a black box
    and nobody sees it before printing. Refuse instead."""
    for t in textes:
        try:
            str(t).encode("cp1252")
        except UnicodeEncodeError as e:
            sys.exit("REFUS : caractère hors cp1252 dans « %s » (%s)" % (t, e))


# ------------------------------------------------------- reading + checks

def charge(chemin_bulletin, chemin_employeur):
    with open(chemin_bulletin, encoding="utf-8") as f:
        b = json.load(f)
    if empreinte(b) != b.get("sha256"):
        sys.exit("REFUS : le sha256 du bulletin ne correspond pas à son contenu canonique (%s)" % chemin_bulletin)
    with open(chemin_employeur, encoding="utf-8") as f:
        e = json.load(f)
    for cle in ("employeur", "salarie", "paiement"):
        if cle not in e:
            sys.exit("REFUS : fichier employeur sans la clé « %s »" % cle)
    return b, e


def lignes_controlees(b):
    """Each remuneration line, with its base and rate recomputed from the parameters, and
    checked against the amount in the file. Returns [(rubrique, base_txt, taux_txt, montant, detail)]."""
    p = b["parameters"]
    heures = dec(b["evidence"]["badge"]["heures_retenues"])
    taux_h = dec(p["hourly_rate_eur"])
    point = dec(p["point_value_eur"])
    anciennete = int(p["seniority_years"])
    c = b.get("contract") or {}
    out = []
    brut_garde = Decimal("0")
    attendu = {}
    # bases and rates the engine used (officine.garde + bulletin_garde.py), to the cent
    temps = cents(heures * taux_h)
    attendu["temps de garde"] = (temps, "%s h" % fr(heures), fr(taux_h).rstrip("0").rstrip(",") if False else ("%.4f" % taux_h).replace(".", ","))
    attendu["indemnite de dimanche"] = (cents(heures * Decimal("1.5") * point), "%s h" % fr(heures),
                                        "1,5 pt x %s" % str(point).replace(".", ","))
    taux_anc = {3: "0.03", 6: "0.06", 9: "0.09", 12: "0.12", 15: "0.15"}
    t_anc = Decimal("0")
    for seuil, t in sorted(taux_anc.items()):
        if anciennete >= seuil:
            t_anc = Decimal(t)
    attendu["prime d anciennete"] = (cents(heures * taux_h * t_anc), fr(heures * taux_h), taux_pct(t_anc))
    for l in b["lines"]:
        item, montant = l["item"], cents(l["amount"])
        if item in attendu:
            m, base, taux = attendu[item]
            if m != montant:
                sys.exit("REFUS : ligne « %s » : %s dans le fichier, %s recalculé" % (item, montant, m))
            out.append((item, base, taux, montant, l["detail"]))
            brut_garde += montant
        elif item == "majorations heures sup.":
            # the detail carries the split (8 h at +25 %, 4 h at +50 %); the amount is checked against the hourly rate
            out.append((item, "%s h" % fr(heures), "sur %s" % ("%.4f" % taux_h).replace(".", ","), montant, l["detail"]))
            brut_garde += montant
        elif item == "indemnite de fin de contrat":
            t = dec(c.get("end_of_contract_bonus_rate", "0.10"))
            m = cents(brut_garde * t)
            if m != montant:
                sys.exit("REFUS : indemnité de fin de contrat : %s dans le fichier, %s recalculé (%s x %s)" % (montant, m, brut_garde, t))
            out.append((item, fr(brut_garde), taux_pct(t), montant, l["detail"]))
            fin = montant
        elif item == "indemnite compensatrice de conges payes":
            t = dec(c.get("paid_leave_rate", "0.10"))
            base = brut_garde + fin
            m = cents(base * t)
            if m != montant:
                sys.exit("REFUS : indemnité de congés payés : %s dans le fichier, %s recalculé" % (montant, m))
            out.append((item, fr(base), taux_pct(t), montant, l["detail"]))
        else:
            out.append((item, "", "", montant, l["detail"]))
    return out


def controle_totaux(b, lignes):
    brut = sum((l[3] for l in lignes), Decimal("0"))
    if brut != cents(b["gross"]):
        sys.exit("REFUS : brut %s dans le fichier, %s en sommant les lignes" % (b["gross"], brut))
    c = b["contributions"]
    sal, pat = cents(c["employee"]["amount"]), cents(c["employer"]["amount"])
    if cents(brut * dec(c["employee"]["rate"])) != sal or cents(brut * dec(c["employer"]["rate"])) != pat:
        sys.exit("REFUS : cotisations : les montants ne sont pas brut x taux")
    if sal + pat != cents(c["total_to_urssaf"]):
        sys.exit("REFUS : total URSSAF")
    net = brut - sal
    if net != cents(b["net_to_pay"]):
        sys.exit("REFUS : net avant impôt %s dans le fichier, %s recalculé" % (b["net_to_pay"], net))
    w = b["withholding"]
    impot = cents(net * dec(w["rate"]))
    if impot != cents(w["amount"]):
        sys.exit("REFUS : prélèvement à la source %s dans le fichier, %s recalculé" % (w["amount"], impot))
    if net - impot != cents(b["net_paid"]):
        sys.exit("REFUS : net payé")
    if brut + pat != cents(b["employer_cost"]):
        sys.exit("REFUS : coût employeur")
    return {"brut": brut, "sal": sal, "pat": pat, "net": net, "impot": impot,
            "paye": net - impot, "cout": brut + pat, "urssaf": sal + pat}


# ------------------------------------------------------------------ layout

RUBRIQUES_LEGALES = [
    "Santé (sécurité sociale maladie-maternité-invalidité-décès, complémentaire santé)",
    "Accidents du travail - maladies professionnelles",
    "Retraite (sécurité sociale plafonnée et déplafonnée, complémentaire Agirc-Arrco T1, CEG)",
    "Famille",
    "Assurance chômage (chômage, APEC)",
    "Autres contributions dues par l'employeur (FNAL, versement mobilité, dialogue social, formation, apprentissage)",
    "Cotisations statutaires ou prévues par la convention collective (prévoyance)",
    "CSG déductible de l'impôt sur le revenu",
    "CSG / CRDS non déductible de l'impôt sur le revenu",
]


def construit(b, e, totaux, lignes, validateur, chemin_sortie, exemple, taux_reels):
    emp, sal, pay = e["employeur"], e["salarie"], e["paiement"]
    devise = b.get("currency", "EUR")
    unite = " €" if devise == "EUR" else " " + devise
    sched = b["evidence"]["schedule"]
    badge = b["evidence"]["badge"]
    c = b["contributions"]
    w = b["withholding"]
    story = []

    # --- title
    story.append(Paragraph("BULLETIN DE PAIE", S["titre"]))
    story.append(Paragraph(esc("Période du %s au %s  -  payé le %s  -  %s" % (
        date_fr(sal.get("date_entree", sched["date"])), date_fr(sal.get("date_sortie", sched["date"])),
        date_fr(pay["date_paiement"]), sal.get("contrat") or (b.get("contract") or {}).get("type", ""))), S["sous"]))
    story.append(Spacer(1, 2.4 * mm))

    # --- banners: what is not real yet, said first
    if exemple:
        story.append(Paragraph("DONNÉES D'EXEMPLE : employeur et salarié fictifs (paie/employeur.exemple.json). "
                               "Remplir paie/employeur.json pour un bulletin réel.", S["alerte"]))
    if not taux_reels:
        story.append(Paragraph("TAUX DE COTISATIONS AGRÉGÉS INDICATIFS (%s salarial, %s patronal) : le détail par rubrique "
                               "n'est connu qu'une fois les taux réels saisis et la DSN produite. Ce bulletin n'est pas "
                               "opposable en l'état." % (taux_pct(c["employee"]["rate"]), taux_pct(c["employer"]["rate"])),
                               S["alerte"]))
    if devise != "EUR":
        story.append(Paragraph("BULLETIN LIBELLÉ EN %s : un bulletin de paie français est libellé en euros "
                               "(paie/en_euros.py)." % devise, S["alerte"]))
    story.append(Spacer(1, 2.4 * mm))

    # --- employer / employee blocks
    def bloc(titre, lignes_txt):
        cellules = [Paragraph(titre, S["bloc_t"])]
        for t in lignes_txt:
            if t:
                cellules.append(Paragraph(esc(t), S["bloc"]))
        return cellules

    nir = sal.get("numero_securite_sociale")
    bloc_emp = bloc("EMPLOYEUR", [emp["raison_sociale"], *emp.get("adresse", []),
                                  "SIRET %s  -  APE %s" % (emp.get("siret", "à compléter"), emp.get("code_ape", "")),
                                  "Organisme de recouvrement : %s" % emp.get("urssaf", "URSSAF"),
                                  "Convention collective : %s" % emp.get("convention_collective", "Pharmacie d'officine (IDCC 1996)")])
    bloc_sal = bloc("SALARIÉ", ["%s %s" % (sal.get("prenom", ""), sal.get("nom", "")), *sal.get("adresse", []),
                                "N° de sécurité sociale : %s" % (nir or "non renseigné"),
                                "Emploi : %s" % sal.get("emploi", ""),
                                "Classification : %s" % sal.get("classification", b["employee"]["label"]),
                                "Entrée le %s  -  sortie le %s" % (date_fr(sal.get("date_entree", sched["date"])), date_fr(sal.get("date_sortie", sched["date"]))),
                                ("Motif du CDD : %s" % sal["motif_cdd"]) if sal.get("motif_cdd") else ""])
    t = Table([[bloc_emp, bloc_sal]], colWidths=[88 * mm, 88 * mm])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOX", (0, 0), (0, 0), 0.5, TRAIT),
                           ("BOX", (1, 0), (1, 0), 0.5, TRAIT), ("LEFTPADDING", (0, 0), (-1, -1), 5),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    story.append(t)
    story.append(Spacer(1, 2.4 * mm))

    # --- hours and evidence
    anomalies = b["evidence"].get("anomalies") or []
    story.append(Paragraph(esc(
        "Temps de travail : %s h retenues (planning %s, %s ; badge %s - %s, %s h badgées ; %s). "
        "Heures déjà faites dans la semaine : %s h, donc %s. Repos compensateur dû : %s h (%s), hors bulletin.%s" % (
            fr(dec(badge["heures_retenues"])), sched["slot"], sched["type"], badge["arrivee"][11:16], badge["depart"][11:16],
            fr(dec(badge["heures_badgees"])), badge["regle"], sched["week_hours_before"],
            next((l["detail"].split(":", 1)[1].strip() for l in b["lines"] if l["item"] == "majorations heures sup."), "pas d'heures supplémentaires"),
            fr(dec(b["rest_hours_outside_escrow"])), b["rest_note"].replace("—", "-"),
            (" Anomalies à trancher : " + " ; ".join(anomalies)) if anomalies else "")), S["note"]))
    story.append(Spacer(1, 2 * mm))

    # --- remuneration lines
    noms = {"temps de garde": "Salaire de base - temps de garde (volets ouverts, 100 % du temps passé)",
            "majorations heures sup.": "Majorations pour heures supplémentaires",
            "indemnite de dimanche": "Indemnité de garde du dimanche (1,5 point par heure, accord du 23/03/2000 art. 4)",
            "prime d anciennete": "Prime d'ancienneté (CCN art. 11)",
            "indemnite de fin de contrat": "Indemnité de fin de contrat (CDD, C. trav. L1243-8)",
            "indemnite compensatrice de conges payes": "Indemnité compensatrice de congés payés (C. trav. L1242-16)"}
    rows = [[P("Rubrique", "h"), P("Base", "hn"), P("Taux", "hn"), P("Montant", "hn")]]
    for item, base, taux, montant, detail in lignes:
        rows.append([[P(noms.get(item, item), "cell"), P(detail.replace("->", "soit").replace("—", "-"), "cell_g")],
                     P(base, "num"), P(taux, "num"), P(fr(montant, unite), "num")])
    rows.append([P("SALAIRE BRUT", "cell_b"), "", "", P(fr(totaux["brut"], unite), "num_b")])
    t = Table(rows, colWidths=[104 * mm, 24 * mm, 24 * mm, 24 * mm], repeatRows=1)
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.5, TRAIT), ("LINEABOVE", (0, -1), (-1, -1), 1, ENCRE),
                           ("BACKGROUND", (0, -1), (-1, -1), FOND), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("TOPPADDING", (0, 0), (-1, -1), 2.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2)]))
    story.append(t)
    story.append(Spacer(1, 2.4 * mm))

    # --- contributions
    rows = [[P("Cotisations et contributions sociales", "h"), P("Base", "hn"), P("Taux salarial", "hn"),
             P("Part salariale", "hn"), P("Taux patronal", "hn"), P("Part patronale", "hn")]]
    for r in RUBRIQUES_LEGALES:
        rows.append([P(r, "cell_g"), P("", "num_g"), P("", "num_g"), P("incluse dans", "num_g"), P("", "num_g"), P("le total agrégé", "num_g")])
    rows.append([[P("TOTAL DES COTISATIONS ET CONTRIBUTIONS", "cell_b"),
                  P("taux agrégés %s ; source des taux : %s" % ("indicatifs" if not taux_reels else "réels", c["rates_source"]), "cell_g")],
                 P(fr(totaux["brut"]), "num_b"), P(taux_pct(c["employee"]["rate"]), "num_b"), P(fr(totaux["sal"], unite), "num_b"),
                 P(taux_pct(c["employer"]["rate"]), "num_b"), P(fr(totaux["pat"], unite), "num_b")])
    rows.append([P("Exonérations, écrêtements et allègements de cotisations (réduction générale) : non calculés", "cell_g"), "", "", P("0,00" + unite, "num_g"), "", P("0,00" + unite, "num_g")])
    t = Table(rows, colWidths=[72 * mm, 20 * mm, 20 * mm, 22 * mm, 20 * mm, 22 * mm], repeatRows=1)
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.5, TRAIT), ("LINEABOVE", (0, -2), (-1, -2), 1, ENCRE),
                           ("BACKGROUND", (0, -2), (-1, -2), FOND), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("TOPPADDING", (0, 0), (-1, -1), 1.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.2)]))
    story.append(t)
    story.append(Spacer(1, 2.4 * mm))

    # --- the totals that matter
    rows = [
        [P("NET À PAYER AVANT IMPÔT SUR LE REVENU", "cell_b"), P(fr(totaux["net"], unite), "num_b")],
        [[P("Montant net social", "cell"), P("estimé = net à payer avant impôt, faute de détail des rubriques", "cell_g")], P(fr(totaux["net"], unite), "num")],
        [[P("Net imposable", "cell"), P("assiette simplifiée = net à payer avant impôt (la DSN calcule l'assiette exacte, CSG/CRDS non déductible comprise)", "cell_g")], P(fr(totaux["net"], unite), "num")],
        [[P("Impôt sur le revenu prélevé à la source", "cell"),
          P("base %s  x  taux personnalisé %s (transmis par la DGFiP), reversé à la DGFiP le %s" % (fr(totaux["net"], unite), taux_pct(w["rate"]), date_fr(w["due"])), "cell_g")],
         P("- " + fr(totaux["impot"], unite), "num")],
        [P("NET PAYÉ EN EUROS" if devise == "EUR" else "NET PAYÉ", "cell_b"), P(fr(totaux["paye"], unite), "num_b")],
        [[P("Total versé par l'employeur (coût total)", "cell"), P("brut + cotisations patronales ; cotisations dues à %s le %s : %s" % (c["recipient"], date_fr(c["due"]), fr(totaux["urssaf"], unite)), "cell_g")], P(fr(totaux["cout"], unite), "num")],
        [P("Allègement de cotisations employeur", "cell"), P("0,00" + unite, "num")],
    ]
    t = Table(rows, colWidths=[152 * mm, 24 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), FOND), ("BACKGROUND", (0, 4), (-1, 4), FOND),
                           ("LINEABOVE", (0, 0), (-1, 0), 1, ENCRE), ("LINEABOVE", (0, 4), (-1, 4), 1, ENCRE),
                           ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)]))
    story.append(KeepTogether([t]))
    story.append(Spacer(1, 2.4 * mm))

    # --- leave, payment
    conges = next((l for l in b["lines"] if l["item"] == "indemnite compensatrice de conges payes"), None)
    story.append(Paragraph(esc(
        "Congés payés : contrat d'un jour, aucun congé acquis ni pris ; l'indemnité compensatrice de congés payés%s est versée avec ce bulletin, solde 0,00. "
        "Paiement : %s, le %s, sur le compte du salarié (IBAN %s)." % (
            (" (%s)" % fr(cents(conges["amount"]), unite)) if conges else "", pay.get("mode", "virement"), date_fr(pay["date_paiement"]),
            masque_iban(sal.get("iban")))), S["note"]))
    story.append(Spacer(1, 2 * mm))

    # --- the proof line: the hash the escrow carries
    valid = b.get("validation") or ({"by": validateur} if validateur else None)
    story.append(KeepTogether([
        Paragraph("PREUVE", S["bloc_t"]),
        Paragraph(esc("Identifiant du bulletin : %s  -  calculé par %s  -  le %s UTC  -  statut : %s" % (
            b["statement_id"], b["computed_by"].replace("—", "-"), b["computed_at"].replace("T", " ")[:19],
            ("validé par %s" % valid["by"]) if valid else b.get("status", ""))), S["note"]),
        Paragraph("Empreinte SHA-256 du bulletin (JSON canonique), portée en mémo de l'escrow XRPL du net payé :", S["note"]),
        Paragraph(b["sha256"], S["mono"]),
        Paragraph(esc("Sources : " + " - ".join(s.replace("->", ":") for s in b["sources"])), S["note"]),
    ]))
    story.append(Spacer(1, 2.4 * mm))

    # --- legal notices (R3243-1 and R3243-5)
    story.append(Paragraph("Dans votre intérêt et pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée.", S["mention"]))
    story.append(Paragraph("Pour la définition des termes employés, se reporter au site internet www.service-public.fr, rubrique cotisations sociales.", S["mention"]))
    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph(esc("Document produit par paie/bulletin_officiel.py (dareskro), de manière déterministe, à partir du fichier %s. "
                               "Le présent PDF n'est pas une DSN et ne remplace pas la déclaration sociale nominative." % os.path.basename(b.get("_source", "bulletin.json"))), S["note"]))
    return story


def masque_iban(iban):
    if not iban:
        return "à compléter"
    iban = iban.replace(" ", "")
    return iban[:4] + " " + "XXXX " * 4 + iban[-3:]


# -------------------------------------------------------------------- main

def main():
    args = sys.argv[1:]

    def opt(k, d=None):
        return args[args.index(k) + 1] if k in args else d

    positionnels = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--") or args[i - 1] == "--bureau")]
    defaut_eur = os.path.join(HERE, "sortie", "bulletin_eur.json")
    chemin_bulletin = positionnels[0] if positionnels else (defaut_eur if os.path.exists(defaut_eur) else os.path.join(ROOT, "agent", "sortie", "bulletin.json"))
    reel = os.path.join(HERE, "employeur.json")
    chemin_employeur = opt("--employeur", reel if os.path.exists(reel) else os.path.join(HERE, "employeur.exemple.json"))
    b, e = charge(chemin_bulletin, chemin_employeur)
    exemple = bool(e.get("exemple"))
    taux_reels = bool(e.get("taux_reels_saisis"))
    sortie = opt("--sortie", os.path.join(HERE, "sortie", "reel" if not exemple else "", "bulletin_officiel.pdf"))
    validateur = opt("--validateur")

    lignes = lignes_controlees(b)
    totaux = controle_totaux(b, lignes)
    b["_source"] = os.path.relpath(chemin_bulletin, ROOT)
    story = construit(b, e, totaux, lignes, validateur, sortie, exemple, taux_reels)
    # the cp1252 guard, on every string that will be drawn
    textes = []
    for fl in story:
        for p in (fl.getContents() if hasattr(fl, "getContents") else [fl]):
            if hasattr(p, "text"):
                textes.append(p.text)
            elif hasattr(p, "_cellvalues"):
                for row in p._cellvalues:
                    for cell in row:
                        for q in (cell if isinstance(cell, list) else [cell]):
                            if hasattr(q, "text"):
                                textes.append(q.text)
    garde_cp1252(textes)

    os.makedirs(os.path.dirname(sortie), exist_ok=True)
    doc = SimpleDocTemplate(sortie, pagesize=A4, leftMargin=17 * mm, rightMargin=17 * mm, topMargin=12 * mm, bottomMargin=12 * mm,
                            title="Bulletin de paie %s" % b["statement_id"], author="dareskro - paie/bulletin_officiel.py",
                            subject="Bulletin de paie, période %s" % b["period"], creator="reportlab (invariant)", invariant=1)
    doc.build(story)
    pdf_sha = sha256_fichier(sortie)
    with open(sortie + ".sha256", "w", encoding="utf-8") as f:
        f.write("%s  %s\n" % (pdf_sha, os.path.basename(sortie)))
    temoin = {
        "pdf": os.path.relpath(sortie, ROOT), "pdf_sha256": pdf_sha,
        "statement": os.path.relpath(chemin_bulletin, ROOT), "statement_sha256": b["sha256"], "statement_id": b["statement_id"],
        "employer_file": os.path.relpath(chemin_employeur, ROOT), "example_data": exemple, "real_rates_entered": taux_reels,
        "currency": b.get("currency"), "gross": str(totaux["brut"]), "net_before_tax": str(totaux["net"]),
        "tax_withheld": str(totaux["impot"]), "net_paid": str(totaux["paye"]), "to_urssaf": str(totaux["urssaf"]), "employer_cost": str(totaux["cout"]),
        "checks": "sha256 of the canonical JSON = file's sha256; each line = base x rate; gross = sum of lines; net = gross - employee contributions; paid = net - tax; cost = gross + employer contributions",
    }
    with open(os.path.splitext(sortie)[0] + ".temoin.json", "w", encoding="utf-8") as f:
        json.dump(temoin, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if "--bureau" in args:
        bureau = os.path.expanduser("~/Desktop")
        shutil.copy(sortie, os.path.join(bureau, os.path.basename(sortie)))
    print("bulletin   %s  (%s)" % (os.path.relpath(chemin_bulletin, ROOT), b["sha256"]))
    print("employeur  %s%s" % (os.path.relpath(chemin_employeur, ROOT), "  [DONNÉES D'EXEMPLE]" if exemple else ""))
    print("contrôles  lignes = base x taux, brut = somme, net, impôt, net payé, coût : OK")
    print("brut %s  net %s  impôt %s  net payé %s  URSSAF %s  coût %s  %s" % (
        totaux["brut"], totaux["net"], totaux["impot"], totaux["paye"], totaux["urssaf"], totaux["cout"], b.get("currency")))
    print("pdf        %s  sha256 %s" % (os.path.relpath(sortie, ROOT), pdf_sha))
    if "--bureau" in args:
        print("copie      ~/Desktop/%s" % os.path.basename(sortie))


if __name__ == "__main__":
    main()
