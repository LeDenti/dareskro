#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rejeu de etude_trustline.py (07/09/2026) en gardant le HASH de chaque transaction.
Trois cas, memes conditions : A beneficiaire sans trustline + un TIERS finit ;
B sans trustline + le BENEFICIAIRE finit ; C trustline ouverte avant + un TIERS finit.
Testnet seulement. Sortie : JSON avec hashs + tableau."""
import datetime, json, sys, time
sys.path.insert(0, "/opt/dareskro_xrpl")
from xrpl.clients import JsonRpcClient
from xrpl.models.amounts import IssuedCurrencyAmount
from xrpl.models.requests import AccountLines, Tx
from xrpl.models.transactions import (AccountSet, AccountSetAsfFlag, EscrowCreate,
                                      EscrowFinish, Payment, TrustSet)
from xrpl.models.transactions.trust_set import TrustSetFlag
from xrpl.transaction import autofill_and_sign, submit, submit_and_wait
from xrpl.wallet import generate_faucet_wallet
import dareskro_xrpl as dx

DEVISE, MONTANT = "USD", "100"
EXPL = "https://testnet.xrpl.org/transactions/"

def envoie(client, tx, wallet):
    """Soumet et attend la validation sans lever sur un tec : renvoie (hash, resultat)."""
    signed = autofill_and_sign(tx, client, wallet)
    r = submit(signed, client)
    h = r.result.get("tx_json", {}).get("hash")
    for _ in range(40):
        time.sleep(1.5)
        t = client.request(Tx(transaction=h)).result
        if t.get("validated"):
            return h, t["meta"]["TransactionResult"], t.get("ledger_index")
    return h, "NON VALIDEE (%s)" % r.result.get("engine_result"), None

def solde(client, adresse, emetteur):
    r = client.request(AccountLines(account=adresse, peer=emetteur))
    for l in r.result.get("lines", []):
        if l["currency"] == DEVISE:
            return l["balance"]
    return None

def main():
    client = JsonRpcClient(dx.TESTNET)
    out = {"date_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "reseau": dx.TESTNET, "devise": DEVISE, "montant": MONTANT, "comptes": {}, "preparation": [], "cas": []}
    print("  comptes du robinet...")
    emetteur = generate_faucet_wallet(client, debug=False)
    donneur = generate_faucet_wallet(client, debug=False)
    tiers = generate_faucet_wallet(client, debug=False)
    benefs = {k: generate_faucet_wallet(client, debug=False) for k in ("A", "B", "C")}
    out["comptes"] = {"emetteur": emetteur.address, "donneur": donneur.address, "tiers": tiers.address,
                      **{"beneficiaire_" + k: w.address for k, w in benefs.items()}}
    for flag, nom in ((AccountSetAsfFlag.ASF_DEFAULT_RIPPLE, "DefaultRipple"),
                      (AccountSetAsfFlag.ASF_ALLOW_TRUSTLINE_LOCKING, "AllowTrustLineLocking")):
        h, res, li = envoie(client, AccountSet(account=emetteur.address, set_flag=flag), emetteur)
        out["preparation"].append({"tx": "AccountSet " + nom, "hash": h, "resultat": res})
    h, res, li = envoie(client, TrustSet(account=donneur.address, limit_amount=IssuedCurrencyAmount(
        currency=DEVISE, issuer=emetteur.address, value="1000000"), flags=TrustSetFlag.TF_CLEAR_NO_RIPPLE), donneur)
    out["preparation"].append({"tx": "TrustSet donneur", "hash": h, "resultat": res})
    h, res, li = envoie(client, Payment(account=emetteur.address, destination=donneur.address,
        amount=IssuedCurrencyAmount(currency=DEVISE, issuer=emetteur.address, value="5000")), emetteur)
    out["preparation"].append({"tx": "Payment emetteur -> donneur 5000", "hash": h, "resultat": res})
    h, res, li = envoie(client, TrustSet(account=benefs["C"].address, limit_amount=IssuedCurrencyAmount(
        currency=DEVISE, issuer=emetteur.address, value="1000000"), flags=TrustSetFlag.TF_CLEAR_NO_RIPPLE), benefs["C"])
    out["preparation"].append({"tx": "TrustSet beneficiaire C (avant)", "hash": h, "resultat": res})

    limite = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
    for cas in ("A", "B", "C"):
        b = benefs[cas]
        cond, ful, _ = dx.condition_et_fulfillment()
        hc, rc, lc = envoie(client, EscrowCreate(account=donneur.address, destination=b.address,
            amount=IssuedCurrencyAmount(currency=DEVISE, issuer=emetteur.address, value=MONTANT),
            condition=cond, cancel_after=dx.ripple_time(limite)), donneur)
        tcreate = client.request(Tx(transaction=hc)).result
        seq = tcreate.get("tx_json", tcreate).get("Sequence")
        signataire = b if cas == "B" else tiers
        avant = solde(client, b.address, emetteur.address)
        hf, rf, lf = envoie(client, EscrowFinish(account=signataire.address, owner=donneur.address,
            offer_sequence=seq, condition=cond, fulfillment=ful), signataire)
        apres = solde(client, b.address, emetteur.address)
        out["cas"].append({"cas": cas, "trustline_avant": cas == "C",
                           "signataire": "beneficiaire" if cas == "B" else "tiers",
                           "escrow_create": {"hash": hc, "resultat": rc, "sequence": seq},
                           "escrow_finish": {"hash": hf, "resultat": rf, "ledger": lf},
                           "solde_avant": avant, "solde_apres": apres})
        print("  cas %s : create %s %s | finish %s %s" % (cas, rc, hc, rf, hf))
    with open("/opt/dareskro_xrpl/etude_trustline_hashes.json", "w") as f:
        json.dump(out, f, indent=2)
    print("")
    print("  %-4s %-10s %-13s %-10s %-12s %s" % ("cas", "trustline", "signataire", "create", "finish", "lien finish"))
    for c in out["cas"]:
        print("  %-4s %-10s %-13s %-10s %-12s %s" % (c["cas"], "oui" if c["trustline_avant"] else "non", c["signataire"],
              c["escrow_create"]["resultat"], c["escrow_finish"]["resultat"], EXPL + c["escrow_finish"]["hash"]))
    print("  JSON : /opt/dareskro_xrpl/etude_trustline_hashes.json")

if __name__ == "__main__":
    main()
