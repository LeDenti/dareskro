#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The last mile, off-chain: a SEPA credit transfer order (ISO 20022 pain.001) from the statement.

WHY. In France an employee's pay goes through a payslip and a bank transfer (C. trav.
L3241-1). The ledger locks the net paid in an escrow and releases it at the date; the
employee's bank account still has to be credited in euros. This script writes the order a
bank's web portal or payroll software would upload: one SEPA credit transfer, purpose SALA,
for the net paid of the statement, to the employee's IBAN, executed on the payment date.

NOT EXECUTED. The file is written to disk and nothing else: no bank API, no upload. It is
a proof of concept of the format, deterministic (same statement + same employer file ->
byte-identical XML), with its SHA-256 next to it. Sending it to the bank is a human act.

URSSAF AND DGFiP. They are not paid by credit transfer. The contributions and the income
tax withheld at source are declared in the DSN, and the DSN triggers their SEPA direct
debit (télépaiement) on the employer's account at the due date. On the ledger the Check
and the tax escrow exist and are measured; in the euro world those two legs are a DSN, not
a pain.001. With --administrations and the IBANs in the employer file, the script writes
two more transfers anyway, as a proof of concept of three legs in one file, and says so.

CHECKS. Currency EUR (the SEPA scheme is euro only: refuse the USD demo statement); the
statement's sha256 against its canonical form; IBAN mod-97; BIC shape; SEPA character set
(Latin basic, accents transliterated); remittance text 140 characters at most; message
and payment identifiers 35 at most; control sums; the XML parses back.

USAGE.  .venv/bin/python paie/ordre_sepa.py [paie/sortie/bulletin_eur.json] [--employeur FILE]
            [--sortie FILE.xml] [--administrations]
"""
import hashlib
import json
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
NS = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"
CENT = Decimal("0.01")


def canonique(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def empreinte(b):
    sans = {k: v for k, v in b.items() if k not in ("sha256", "status", "validation")}
    return hashlib.sha256(canonique(sans)).hexdigest()


def iban_ok(iban):
    s = re.sub(r"\s+", "", iban or "").upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", s):
        return False
    r = s[4:] + s[:4]
    n = "".join(str(int(ch, 36)) for ch in r)
    return int(n) % 97 == 1


def bic_ok(bic):
    return bool(re.fullmatch(r"[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?", (bic or "").upper()))


def sepa_text(s, n=70):
    """SEPA Latin character set: letters, digits, / - ? : ( ) . , ' + and space. Accents are transliterated."""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.replace("&", "+").replace("€", "EUR")
    s = re.sub(r"[^A-Za-z0-9/\-?:().,'+ ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n]


def montant(d):
    return str(Decimal(str(d)).quantize(CENT, ROUND_HALF_UP))


def sha256_fichier(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def el(parent, tag, text=None, **attrs):
    e = ET.SubElement(parent, tag, attrs)
    if text is not None:
        e.text = str(text)
    return e


def partie(parent, tag, nom, adresse=None):
    p = el(parent, tag)
    el(p, "Nm", sepa_text(nom))
    if adresse:
        a = el(p, "PstlAdr")
        el(a, "Ctry", "FR")
        for ligne in adresse[:2]:
            el(a, "AdrLine", sepa_text(ligne))
    return p


def virement(pmt, instr_id, e2e, amount, cdtr_nom, cdtr_iban, cdtr_bic, libelle, purpose="SALA"):
    tx = el(pmt, "CdtTrfTxInf")
    pid = el(tx, "PmtId")
    el(pid, "InstrId", sepa_text(instr_id, 35))
    el(pid, "EndToEndId", sepa_text(e2e, 35))
    el(el(tx, "Amt"), "InstdAmt", amount, Ccy="EUR")
    if cdtr_bic:
        el(el(el(tx, "CdtrAgt"), "FinInstnId"), "BIC", cdtr_bic.upper())
    partie(tx, "Cdtr", cdtr_nom)
    el(el(el(tx, "CdtrAcct"), "Id"), "IBAN", re.sub(r"\s+", "", cdtr_iban).upper())
    if purpose:
        el(el(tx, "Purp"), "Cd", purpose)
    el(el(tx, "RmtInf"), "Ustrd", sepa_text(libelle, 140))


def main():
    args = sys.argv[1:]

    def opt(k, d=None):
        return args[args.index(k) + 1] if k in args else d

    pos = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--") or args[i - 1] == "--administrations")]
    chemin_bulletin = pos[0] if pos else os.path.join(HERE, "sortie", "bulletin_eur.json")
    reel = os.path.join(HERE, "employeur.json")
    chemin_employeur = opt("--employeur", reel if os.path.exists(reel) else os.path.join(HERE, "employeur.exemple.json"))
    with open(chemin_bulletin, encoding="utf-8") as f:
        b = json.load(f)
    with open(chemin_employeur, encoding="utf-8") as f:
        e = json.load(f)
    exemple = bool(e.get("exemple"))
    sortie = opt("--sortie", os.path.join(HERE, "sortie", "" if exemple else "reel", "ordre_virement.pain001.xml"))

    if empreinte(b) != b.get("sha256"):
        sys.exit("REFUS : le sha256 du bulletin ne correspond pas à son contenu canonique")
    if b.get("currency") != "EUR":
        sys.exit("REFUS : bulletin libellé en %s ; un virement SEPA est en euros (paie/en_euros.py d'abord)" % b.get("currency"))
    emp, sal, pay = e["employeur"], e["salarie"], e["paiement"]
    for who, d in (("employeur", emp), ("salarié", sal)):
        if not iban_ok(d.get("iban")):
            sys.exit("REFUS : IBAN %s invalide (clé mod 97) : %s" % (who, d.get("iban")))
        if d.get("bic") and not bic_ok(d["bic"]):
            sys.exit("REFUS : BIC %s mal formé : %s" % (who, d["bic"]))

    net_paye = montant(b["net_paid"])
    sid = b["statement_id"]
    cre = b["computed_at"][:19]  # deterministic: the statement's own timestamp, not the clock
    msg_id = sepa_text("DARESKRO-%s" % sid, 35)
    legs = [{"leg": "net paid to the employee", "route": "SEPA credit transfer, purpose SALA, in this file",
             "amount_eur": net_paye, "execution_date": pay["date_paiement"], "creditor": "%s %s" % (sal.get("prenom", ""), sal.get("nom", ""))}]

    root = ET.Element("Document", {"xmlns": NS, "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"})
    doc = el(root, "CstmrCdtTrfInitn")
    hdr = el(doc, "GrpHdr")
    el(hdr, "MsgId", msg_id)
    el(hdr, "CreDtTm", cre)
    nb = el(hdr, "NbOfTxs", "1")
    ctrl = el(hdr, "CtrlSum", net_paye)
    ip = partie(hdr, "InitgPty", emp["raison_sociale"])
    if emp.get("siret"):
        othr = el(el(el(ip, "Id"), "OrgId"), "Othr")
        el(othr, "Id", re.sub(r"\s+", "", emp["siret"]))
        el(el(othr, "SchmeNm"), "Cd", "CUST")

    def bloc_paiement(pmt_id, date_exec, total, n, purpose_cat="SALA"):
        p = el(doc, "PmtInf")
        el(p, "PmtInfId", sepa_text(pmt_id, 35))
        el(p, "PmtMtd", "TRF")
        el(p, "BtchBookg", "false")
        el(p, "NbOfTxs", str(n))
        el(p, "CtrlSum", total)
        t = el(p, "PmtTpInf")
        el(el(t, "SvcLvl"), "Cd", "SEPA")
        if purpose_cat:
            el(el(t, "CtgyPurp"), "Cd", purpose_cat)
        el(p, "ReqdExctnDt", date_exec)
        partie(p, "Dbtr", emp["raison_sociale"], emp.get("adresse"))
        acct = el(p, "DbtrAcct")
        el(el(acct, "Id"), "IBAN", re.sub(r"\s+", "", emp["iban"]).upper())
        el(acct, "Ccy", "EUR")
        if emp.get("bic"):
            el(el(el(p, "DbtrAgt"), "FinInstnId"), "BIC", emp["bic"].upper())
        el(p, "ChrgBr", "SLEV")
        return p

    p1 = bloc_paiement("PAIE-%s-%s" % (b["period"], sid[-12:]), pay["date_paiement"], net_paye, 1)
    virement(p1, "%s-NET" % sid, sid, net_paye, "%s %s" % (sal.get("prenom", ""), sal.get("nom", "")), sal["iban"], sal.get("bic"),
             "SALAIRE %s GARDE %s BULLETIN %s SHA256 %s" % (b["period"], b["evidence"]["schedule"]["date"], sid, b["sha256"][:16]))

    total = Decimal(net_paye)
    n_total = 1
    if "--administrations" in args:
        adm = e.get("administrations") or {}
        c, w = b["contributions"], b["withholding"]
        for key, nom, amt, due, lib, purpose in (
                ("urssaf", c["recipient"], montant(c["total_to_urssaf"]), c["due"], "COTISATIONS %s SIRET %s BULLETIN %s" % (b["period"], re.sub(r"\s+", "", emp.get("siret", "")), sid), "SSBE"),
                ("dgfip", w["recipient"], montant(w["amount"]), w["due"], "PAS %s SIRET %s BULLETIN %s" % (b["period"], re.sub(r"\s+", "", emp.get("siret", "")), sid), "TAXS")):
            d = adm.get(key)
            if not d or not iban_ok(d.get("iban")):
                print("administrations : pas d'IBAN valide pour %s dans le fichier employeur — en réalité cette somme est prélevée par %s sur déclaration DSN, pas virée" % (nom, nom))
                legs.append({"leg": "%s" % nom, "route": "NOT in this file: declared in the DSN, collected by SEPA direct debit at the due date", "amount_eur": amt, "due": due})
                continue
            p = bloc_paiement("%s-%s-%s" % (key.upper(), b["period"], sid[-12:]), due, amt, 1, purpose_cat=None)
            virement(p, "%s-%s" % (sid, key.upper()), "%s-%s" % (sid, key.upper()), amt, d.get("nom", nom), d["iban"], d.get("bic"), lib, purpose=purpose)
            total += Decimal(amt)
            n_total += 1
            legs.append({"leg": nom, "route": "SEPA credit transfer in this file (proof of concept: in reality a DSN direct debit)", "amount_eur": amt, "execution_date": due})
    else:
        legs.append({"leg": b["contributions"]["recipient"], "route": "NOT in this file: declared in the DSN, collected by SEPA direct debit at the due date", "amount_eur": montant(b["contributions"]["total_to_urssaf"]), "due": b["contributions"]["due"]})
        legs.append({"leg": b["withholding"]["recipient"], "route": "NOT in this file: declared in the DSN (PASRAU), collected by SEPA direct debit at the due date", "amount_eur": montant(b["withholding"]["amount"]), "due": b["withholding"]["due"]})
    nb.text = str(n_total)
    ctrl.text = montant(total)

    ET.indent(root, space="  ")
    xml = ET.tostring(root, encoding="unicode")
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml + "\n"
    os.makedirs(os.path.dirname(sortie), exist_ok=True)
    with open(sortie, "w", encoding="utf-8") as f:
        f.write(xml)
    ET.fromstring(xml.encode("utf-8"))  # parses back
    sha = sha256_fichier(sortie)
    with open(sortie + ".sha256", "w", encoding="utf-8") as f:
        f.write("%s  %s\n" % (sha, os.path.basename(sortie)))
    temoin = {"file": os.path.relpath(sortie, ROOT), "file_sha256": sha, "format": "ISO 20022 pain.001.001.03, SEPA credit transfer",
              "executed": False, "statement": os.path.relpath(chemin_bulletin, ROOT), "statement_sha256": b["sha256"],
              "employer_file": os.path.relpath(chemin_employeur, ROOT), "example_data": exemple,
              "message_id": msg_id, "transfers": n_total, "control_sum_eur": montant(total), "legs": legs}
    with open(os.path.splitext(sortie)[0] + ".temoin.json", "w", encoding="utf-8") as f:
        json.dump(temoin, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("bulletin   %s  (%s)" % (os.path.relpath(chemin_bulletin, ROOT), b["sha256"]))
    print("employeur  %s%s" % (os.path.relpath(chemin_employeur, ROOT), "  [DONNÉES D'EXEMPLE]" if exemple else ""))
    print("ordre      %s  %d virement(s), total %s EUR, MsgId %s  — ÉCRIT, NON EXÉCUTÉ" % (os.path.relpath(sortie, ROOT), n_total, montant(total), msg_id))
    for l in legs:
        print("  %-28s %10s EUR  %s" % (l["leg"], l["amount_eur"], l["route"]))
    print("sha256     %s" % sha)


if __name__ == "__main__":
    main()
