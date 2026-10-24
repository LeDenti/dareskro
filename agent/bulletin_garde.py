#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""De la preuve au bulletin : l'agent lit, le code calcule, rien n'est verse.

Construit pendant le hackathon XRPL de New York (24-25/10/2026).

ETAGES, dans l'ordre, et qui fait quoi :

  1. lire les preuves      le planning (qualifications) et le badge (faits)
  2. croiser               le badge couvre-t-il la plage planifiee ?
  3. calculer              officine.garde, deterministe, rejouable au centime
  4. empreinter            SHA-256 du bulletin canonique, c'est elle qui ira
                           dans le memo du sequestre, jamais le bulletin
  5. ecrire                app/public/bulletin.json pour la page de signature

Le bulletin sort en statut PROPOSITION. La validation humaine se fait dans la
page, par une personne nommee, AVANT que le patron signe sur son Ledger.
Aucune IA ne touche au calcul : un modele non deterministe qui produit un
bulletin de paie est inauditable. Elle n'a sa place qu'a l'etage 1, pour lire
des preuves eparpillees ; ici les preuves sont deja structurees, le code suffit.
"""
import csv
import datetime
import hashlib
import json
import os
import sys
from decimal import Decimal

ICI = os.path.dirname(os.path.abspath(__file__))
# Le moteur de calcul officine.garde est ANTERIEUR au hackathon (dossier sources/paie,
# hors du depot public). Sans lui, ce script ne calcule pas : agent/sortie/bulletin.json
# est sa sortie, gardee dans le depot pour que la suite de la chaine se lise et se rejoue.
sys.path.insert(0, os.path.join(ICI, "..", "sources", "paie"))
try:
    from officine import garde  # noqa: E402
except ImportError:
    sys.exit("officine.garde (le moteur de paie, travail anterieur au hackathon) n'est pas "
             "dans ce depot : voir README, section « What existed before ». "
             "La sortie du moteur est dans agent/sortie/bulletin.json.")

PREUVES = os.path.join(ICI, "preuves")
SORTIES = [
    os.path.join(ICI, "sortie", "bulletin.json"),
    os.path.join(ICI, "..", "app", "public", "bulletin.json"),
]
# Les parametres de la convention, ACHETES par l'agent au service de regles sur
# Mastercard AP4M (ap4m/agent.mjs). Sans achat, le calcul se rabat sur la valeur
# du planning et le dit ; avec --exige-achat, il refuse.
REGLES_ACHETEES = os.path.join(ICI, "sortie", "regles_achetees.json")
TOLERANCE_MIN = 15
# La monnaie du bulletin : le salaire est en dollars pour la demo (--devise EUR pour l'euro).
DEVISE = "EUR" if "--devise" in sys.argv and sys.argv[sys.argv.index("--devise") + 1].upper() == "EUR" else "USD"


def regles_du_marche():
    """Les regles payees, si l'agent les a achetees. Sinon None."""
    if not os.path.exists(REGLES_ACHETEES):
        return None
    with open(REGLES_ACHETEES, encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------ 1. lire

def lis_planning(chemin):
    plan = {}
    for ligne in open(chemin, encoding="utf-8"):
        ligne = ligne.strip()
        if not ligne or ligne.startswith("#") or ":" not in ligne:
            continue
        cle, val = ligne.split(":", 1)
        plan[cle.strip()] = val.strip()
    return plan


def lis_badge(chemin):
    with open(chemin, encoding="utf-8") as f:
        return [dict(r) for r in csv.DictReader(f)]


# --------------------------------------------------------- 2. croiser

def croise(plan, pointages):
    """La plage planifiee est-elle couverte par le badge ? Rien d'autre.

    Le badge dit « present de 08:56 a 21:03 ». Il ne dit pas « garde »,
    ni « dimanche », ni « volets ouverts » : ca, c'est le planning. On retient
    les heures PLANIFIEES si le badge les couvre (a 15 min pres), et on signale
    tout le reste comme anomalie a trancher par un humain.
    """
    debut_s, fin_s = plan["plage"].split("-")
    jour = plan["date"]
    debut = datetime.datetime.fromisoformat("%sT%s:00+01:00" % (jour, debut_s))
    fin = datetime.datetime.fromisoformat("%sT%s:00+01:00" % (jour, fin_s))
    miens = [p for p in pointages if p["badge"] == plan["badge"]]
    entrees = [datetime.datetime.fromisoformat(p["instant"])
               for p in miens if p["sens"] == "entree"]
    sorties = [datetime.datetime.fromisoformat(p["instant"])
               for p in miens if p["sens"] == "sortie"]
    anomalies = []
    if not entrees or not sorties:
        anomalies.append("badge incomplet : pas d'entree ou pas de sortie")
        return None, anomalies
    arrivee, depart = min(entrees), max(sorties)
    tol = datetime.timedelta(minutes=TOLERANCE_MIN)
    if arrivee > debut + tol:
        anomalies.append("arrivee a %s pour une plage a %s"
                         % (arrivee.strftime("%H:%M"), debut_s))
    if depart < fin - tol:
        anomalies.append("depart a %s pour une plage jusqu'a %s"
                         % (depart.strftime("%H:%M"), fin_s))
    if arrivee < debut - tol:
        anomalies.append("present %d min avant la plage : a trancher, non paye"
                         % int((debut - arrivee).total_seconds() // 60))
    if depart > fin + tol:
        anomalies.append("present %d min apres la plage : a trancher, non paye"
                         % int((depart - fin).total_seconds() // 60))
    heures_planifiees = Decimal((fin - debut).total_seconds()) / Decimal(3600)
    presence = {
        "arrivee": arrivee.isoformat(),
        "depart": depart.isoformat(),
        "heures_badgees": str((Decimal((depart - arrivee).total_seconds())
                               / Decimal(3600)).quantize(Decimal("0.01"))),
        "heures_retenues": str(heures_planifiees.quantize(Decimal("0.01"))),
        "regle": "heures planifiees, couvertes par le badge a %d min pres"
                 % TOLERANCE_MIN,
    }
    return presence, anomalies


# ------------------------------------------------------- 4. empreinter

def canonique(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def empreinte(bulletin):
    sans = {k: v for k, v in bulletin.items()
            if k not in ("sha256", "status", "validation")}
    return hashlib.sha256(canonique(sans)).hexdigest()


# ------------------------------------------------------------- main

def main():
    plan = lis_planning(os.path.join(PREUVES, "planning_2026-10-25.txt"))
    pointages = lis_badge(os.path.join(PREUVES, "badge_2026-10-25.csv"))
    presence, anomalies = croise(plan, pointages)
    if presence is None:
        print("REFUS : %s" % "; ".join(anomalies))
        sys.exit(1)

    dimanche = "dimanche" in plan["type"]
    volets_ouverts = "volets ouverts" in plan["type"]

    achat = regles_du_marche()
    if achat is None and "--exige-achat" in sys.argv:
        print("REFUS : pas de regles achetees (ap4m/agent.mjs d'abord). "
              "Le calcul ne tourne pas sur des parametres non sources.")
        sys.exit(2)
    if achat:
        valeur_point = achat["rules"]["point_value_eur"]
        rules_source = {
            "how": "purchased by the agent over x402 on Mastercard AP4M",
            "provider": achat["provider"],
            "paid_rlusd": achat["paid_rlusd"],
            "channel_cap_rlusd": achat["channel"]["cap_rlusd"],
            "redemption_tx": achat["redemption_tx"],
            "redemption_explorer": achat["redemption_explorer"],
            "receipt_url": achat.get("receipt_url"),
            "purchased_at": achat["purchased_at"],
            "agreement": achat["rules"]["agreement"],
            "valid_from": achat["rules"]["valid_from"],
        }
    else:
        valeur_point = plan["valeur_point"]
        rules_source = {"how": "local fallback: point value from the schedule file, "
                               "not purchased"}

    r = garde(Decimal(presence["heures_retenues"]), valeur_point,
              int(plan["coefficient"]), int(plan["anciennete_annees"]),
              dimanche=dimanche, volets_ouverts=volets_ouverts,
              heures_deja_faites=int(plan["heures_semaine_avant"]))

    bulletin = {
        "statement_id": "garde-%s-coef%s" % (plan["date"], plan["coefficient"]),
        "employee": {"label": plan["salarie"], "badge": plan["badge"]},
        "period": plan["date"][:7],
        "evidence": {
            "schedule": {"date": plan["date"], "slot": plan["plage"],
                         "type": plan["type"],
                         "week_hours_before": plan["heures_semaine_avant"]},
            "badge": presence,
            "anomalies": anomalies,
        },
        "parameters": {
            "coefficient": r["coefficient"], "point_value_eur": r["valeur_point"],
            "hourly_rate_eur": r["taux_horaire"], "shutters": r["volets"],
            "seniority_years": plan["anciennete_annees"],
        },
        "lines": [{"item": l["poste"], "detail": l["detail"],
                   "amount": l["montant"]} for l in r["lignes"]],
        "total": r["total_euros"],
        "currency": DEVISE,
        "rest_hours_outside_escrow": r["repos_compensateur_heures"],
        "rest_note": r["note_repos"],
        "sources": [
            "convention pharmacie d'officine IDCC 1996, art. 11 "
            "(anciennete : 15 % au-dela de 15 ans)",
            "art. 7 -> accord du 23/03/2000 revise le 09/04/2008, art. 4 "
            "(garde dimanche : 1,5 point par heure, repos d'egale duree)",
            "valeur du point 5,277 EUR, accord du 19/01/2026, A CONFIRMER",
        ],
        "rules_source": rules_source,
        "computed_by": "officine.garde — deterministic, replayable to the cent",
        "computed_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="seconds"),
        "status": "PROPOSITION",
    }
    bulletin["sha256"] = empreinte(bulletin)

    for chemin in SORTIES:
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(bulletin, f, indent=2, ensure_ascii=False)

    print("preuves    planning %s, badge %s -> %s h retenues"
          % (plan["plage"], presence["heures_badgees"],
             presence["heures_retenues"]))
    for a in anomalies:
        print("anomalie   %s" % a)
    for l in bulletin["lines"]:
        print("  %-26s %10s %s" % (l["item"], l["amount"], DEVISE))
    print("  %-26s %10s %s   (+ %s h de repos, hors sequestre)"
          % ("TOTAL", bulletin["total"], DEVISE, bulletin["rest_hours_outside_escrow"]))
    print("regles     %s" % rules_source["how"])
    print("sha256     %s" % bulletin["sha256"])
    print("statut     %s — a valider par une personne nommee avant signature"
          % bulletin["status"])
    print("ecrit      %s" % ", ".join(os.path.relpath(c, ICI) for c in SORTIES))


if __name__ == "__main__":
    main()
