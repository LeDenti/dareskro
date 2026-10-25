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
from decimal import Decimal, ROUND_HALF_UP


def pct(t):
    """A rate as a percentage for a label: 0.10 -> '10', 0.075 -> '7.5' (never '1E+1')."""
    v = Decimal(t) * 100
    return str(v.quantize(Decimal("1")) if v == v.to_integral_value() else v.normalize())

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

    # Les taux des indemnites de CDD et des cotisations : achetes avec les regles,
    # sinon les taux legaux (10 % et 10 %) et des taux agreges indicatifs, et on le dit.
    regles = achat["rules"] if achat else {}
    cdd_regles = regles.get("fixed_term") or {}
    cot_regles = regles.get("contributions") or {}
    taux_fin_contrat = Decimal(cdd_regles.get("end_of_contract_bonus", "0.10"))
    taux_conges = Decimal(cdd_regles.get("paid_leave_allowance", "0.10"))
    taux_salarial = Decimal(cot_regles.get("employee_rate", "0.22"))
    taux_patronal = Decimal(cot_regles.get("employer_rate", "0.42"))
    taux_source = ("purchased with the rules (fixed_term, contributions)"
                   if cdd_regles and cot_regles else
                   "legal 10 % + 10 % and indicative aggregated contribution rates, not purchased")

    r = garde(Decimal(presence["heures_retenues"]), valeur_point,
              int(plan["coefficient"]), int(plan["anciennete_annees"]),
              dimanche=dimanche, volets_ouverts=volets_ouverts,
              heures_deja_faites=int(plan["heures_semaine_avant"]))

    # --- 3b. le contrat d'un jour : deux indemnites sur le brut de la garde, chacune
    # arrondie au centime (ROUND_HALF_UP), puis les cotisations sur le brut total.
    cent = Decimal("0.01")
    lignes = [{"item": l["poste"], "detail": l["detail"], "amount": l["montant"]}
              for l in r["lignes"]]
    # Each line is printed rounded to the cent, so the shift gross is the sum of the lines as
    # printed, not the rounding of their exact sum: the statement adds up on paper, to the cent.
    brut_garde = sum((Decimal(l["montant"]) for l in r["lignes"]), Decimal("0")).quantize(cent, ROUND_HALF_UP)
    cdd = plan.get("contrat", "").lower().startswith("cdd")
    if cdd:
        fin_contrat = (brut_garde * taux_fin_contrat).quantize(cent, ROUND_HALF_UP)
        conges = ((brut_garde + fin_contrat) * taux_conges).quantize(cent, ROUND_HALF_UP)
        lignes.append({"item": "indemnite de fin de contrat",
                       "detail": "%s %% du brut de la garde (CDD, L1243-8)" % pct(taux_fin_contrat),
                       "amount": str(fin_contrat)})
        lignes.append({"item": "indemnite compensatrice de conges payes",
                       "detail": "%s %% du brut, indemnite de fin de contrat incluse (L1242-16)" % pct(taux_conges),
                       "amount": str(conges)})
        brut = brut_garde + fin_contrat + conges
        contrat = {"type": plan["contrat"], "fixed_term": True,
                   "end_of_contract_bonus_rate": str(taux_fin_contrat),
                   "paid_leave_rate": str(taux_conges),
                   "leave_basis": cdd_regles.get("leave_basis", "gross including the end-of-contract bonus")}
    else:
        brut = brut_garde
        contrat = {"type": plan.get("contrat", "CDI"), "fixed_term": False}
    cot_salariales = (brut * taux_salarial).quantize(cent, ROUND_HALF_UP)
    cot_patronales = (brut * taux_patronal).quantize(cent, ROUND_HALF_UP)
    net = brut - cot_salariales
    # --- 3c. le prelevement a la source : le taux personnalise du salarie, transmis par la
    # DGFiP via la DSN (ici dans le planning), applique au net (assiette simplifiee : la DSN
    # calcule le net imposable exact). Retenu par l'employeur, reverse a la DGFiP le 15.
    taux_pas = (Decimal(plan.get("taux_pas", "0")) / 100).quantize(Decimal("0.0001"))
    impot_retenu = (net * taux_pas).quantize(cent, ROUND_HALF_UP)
    net_paye = net - impot_retenu
    # Exigibilite : le 15 du mois suivant la paie (employeurs de moins de 50 salaries).
    annee, mois = int(plan["date"][:4]), int(plan["date"][5:7])
    echeance_urssaf = "%04d-%02d-15" % ((annee + 1, 1) if mois == 12 else (annee, mois + 1))

    bulletin = {
        # Opaque on purpose: the id goes in an on-chain memo, and a readable id
        # ("garde-2026-10-25-coef600") would tell the public the day and the coefficient.
        "statement_id": "stmt-%s" % hashlib.sha256(
            ("%s|%s|%s" % (plan["badge"], plan["date"], plan["coefficient"])).encode("utf-8")
        ).hexdigest()[:12],
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
        "contract": contrat,
        "lines": lignes,
        "total": str(brut),
        "gross": str(brut),
        "currency": DEVISE,
        # Les cotisations : un second sequestre, vers l'URSSAF, libere a la date d'exigibilite.
        "contributions": {
            "recipient": cot_regles.get("recipient", "URSSAF"),
            "due": echeance_urssaf,
            "basis": cot_regles.get("basis", "aggregated indicative rates; the DSN computes line by line"),
            "employee": {"rate": str(taux_salarial), "amount": str(cot_salariales)},
            "employer": {"rate": str(taux_patronal), "amount": str(cot_patronales)},
            "total_to_urssaf": str(cot_salariales + cot_patronales),
            "rates_source": taux_source,
        },
        "net_to_pay": str(net),
        # L'impot sur le revenu, retenu a la source : un troisieme versement, vers la DGFiP.
        "withholding": {
            "recipient": "DGFiP",
            "due": echeance_urssaf,
            "basis": "personalised rate transmitted by DGFiP through the DSN, applied to the net to pay "
                     "(simplified basis: the DSN computes the exact taxable net)",
            "rate": str(taux_pas),
            "amount": str(impot_retenu),
        },
        "net_paid": str(net_paye),
        "employer_cost": str(brut + cot_patronales),
        "rest_hours_outside_escrow": r["repos_compensateur_heures"],
        "rest_note": r["note_repos"],
        "sources": [
            "convention pharmacie d'officine IDCC 1996, art. 11 "
            "(anciennete : 15 % au-dela de 15 ans)",
            "art. 7 -> accord du 23/03/2000 revise le 09/04/2008, art. 4 "
            "(garde dimanche : 1,5 point par heure, repos d'egale duree)",
            "valeur du point 5,277 EUR, accord du 19/01/2026, A CONFIRMER",
            "Code du travail L1243-8 (indemnite de fin de contrat, 10 % du brut) "
            "et L1242-16 (indemnite compensatrice de conges payes, 10 %, "
            "indemnite de fin de contrat incluse dans l'assiette)",
            "cotisations : taux agreges indicatifs (bareme URSSAF 2026), "
            "la DSN calcule ligne par ligne ; exigibilite le 15 du mois suivant",
            "prelevement a la source (CGI art. 204 A et suivants) : taux personnalise "
            "transmis par la DGFiP, retenu par l'employeur, reverse le 15 du mois suivant",
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
          % ("BRUT", bulletin["total"], DEVISE, bulletin["rest_hours_outside_escrow"]))
    c = bulletin["contributions"]
    print("  %-26s %10s %s   (%s %% du brut)" % ("cotisations salariales", "-" + c["employee"]["amount"], DEVISE, pct(Decimal(c["employee"]["rate"]))))
    print("  %-26s %10s %s" % ("NET AVANT IMPOT", bulletin["net_to_pay"], DEVISE))
    w = bulletin["withholding"]
    print("  %-26s %10s %s   (taux personnalise %s %%, DGFiP via DSN)" % ("prelevement a la source", "-" + w["amount"], DEVISE, (Decimal(w["rate"]) * 100).normalize()))
    print("  %-26s %10s %s   -> sequestre 1, le salarie, a la date de paie" % ("NET PAYE", bulletin["net_paid"], DEVISE))
    print("  %-26s %10s %s   -> escrow vers la DGFiP, exigible le %s" % ("A LA DGFIP", w["amount"], DEVISE, w["due"]))
    print("  %-26s %10s %s   (%s %% du brut)" % ("cotisations patronales", c["employer"]["amount"], DEVISE, pct(Decimal(c["employer"]["rate"]))))
    print("  %-26s %10s %s   -> Check XRPL que %s encaisse elle-meme, exigible le %s" % ("A L'URSSAF", c["total_to_urssaf"], DEVISE, c["recipient"], c["due"]))
    print("  %-26s %10s %s" % ("COUT EMPLOYEUR", bulletin["employer_cost"], DEVISE))
    print("taux       %s" % c["rates_source"])
    print("regles     %s" % rules_source["how"])
    print("sha256     %s" % bulletin["sha256"])
    print("statut     %s — a valider par une personne nommee avant signature"
          % bulletin["status"])
    print("ecrit      %s" % ", ".join(os.path.relpath(c, ICI) for c in SORTIES))


if __name__ == "__main__":
    main()
