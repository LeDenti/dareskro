#!/usr/bin/env node
/**
 * Rental security deposit, live on the XRP Ledger testnet.
 *
 * WHY NOT AN ESCROW. A deposit is held in euros, and on 27/10/2026 neither
 * euro token on XRPL (EURØP, Schuman) nor RLUSD carries the issuer flag that
 * allows EscrowCreate on a trust-line token (lsfAllowTrustLineLocking, bit
 * 0x40000000, measured on mainnet: absent on both). An escrow is also all or
 * nothing, and a deposit is usually returned in part. So the primitive here is
 * not EscrowCreate but a dedicated ACCOUNT per lease, controlled by a 2-of-3
 * signer list — landlord, tenant, arbiter (dareskro) — holding the euro token.
 * It needs no issuer flag, it pays any split, and nobody moves the money alone:
 * the arbiter cannot, the landlord cannot, the account's own key is disabled.
 *
 * WHAT RUNS (every step is a real testnet transaction, hashes printed):
 *   0. a test euro issuer stands in for EURØP (the mainnet token is not on testnet)
 *   1. landlord, tenant, arbiter get accounts; landlord and tenant open their
 *      trust line to the euro (the "inscription" signature — a payee without a
 *      trust line cannot be paid, measured 07/09/2026)
 *   2. the tenant creates the deposit account with the reserve (≈1.5 XRP) —
 *      trust line, SignerListSet quorum 2 (three signers, weight 1), master key
 *      disabled; memos: lease id + SHA-256 of the entry inventory
 *   3. the tenant pays the deposit: 1 month of rent (art. 22 cap, computed by
 *      bail.mjs), memo = entry inventory hash
 *   4. negatives: the arbiter alone → tefBAD_QUORUM; the landlord alone →
 *      tefBAD_QUORUM; the account's old master key → tefMASTER_DISABLED
 *   5. case A, keys handed back, inventory matches: landlord + tenant sign one
 *      Payment, the whole deposit returns to the tenant; memo = exit inventory
 *      hash. Deadline printed: 1 month.
 *   6. case B (second lease, same shape), inventory does not match, a 180 €
 *      deduction with a quote on file: the arbiter signs with the landlord
 *      (180 € to him, memo = quote hash) and with the tenant (1 020 € back).
 *      Deadline printed: 2 months; the late penalty is shown on a simulated
 *      late date (10 % of rent per month started).
 *
 * The amounts the ledger moves are the ones bail.mjs computed. The dates and
 * the penalty are computed and written in memos; the ledger cannot enforce a
 * calendar on a multisig account — the arbiter's job is to sign on time, and
 * the memo is the public trace of who was late.
 *
 * No seed is written to disk: the four wallets are faucet accounts that live
 * for this run. The public report goes to compte_rendu.json.
 *
 * Usage: node demo_depot_garantie.mjs        (≈ 3 minutes on testnet)
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, multisign, xrpToDrops } from "xrpl";
import { decompte, echeanceRestitution, euros, majorationRetard, plafondDepot, verifieRetenue } from "./bail.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, "compte_rendu.json");
const TESTNET = process.env.XRPL_TESTNET || "wss://testnet.xrpl-labs.com";
const CURRENCY = "EUR";               // test stand-in for EURØP (4555524F50… on mainnet)
const RESERVE_XRP = "3";              // 1 XRP base + 0.2 per object (trust line, signer list) + fees; the rest comes back

const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const account = (a) => `https://testnet.xrpl.org/accounts/${a}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memo = (type, data) => ({ Memo: { MemoType: hex(type), MemoData: hex(data) } });
const eur = (issuer, cents) => ({ currency: CURRENCY, issuer, value: (cents / 100).toString() });

const c = new Client(TESTNET);
const report = { network: TESTNET, date: new Date().toISOString(), steps: [] };
const note = (step, extra) => { report.steps.push({ step, ...extra }); };

/** The testnet websocket drops now and then: reconnect and retry a ledger call a few times. */
async function onLedger(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      if (!c.isConnected()) await c.connect();
      return await fn();
    } catch (err) {
      if (i >= tries - 1) throw err;
      log(`ledger hiccup (${String(err?.message ?? err).split("\n")[0].slice(0, 80)}), retrying in 5 s…`);
      try { await c.disconnect(); } catch { /* already closed */ }
      await sleep(5000);
    }
  }
}

/** Single-signed, expected to succeed. */
async function send(wallet, tx, label) {
  const r = await onLedger(async () => {
    const prepared = await c.autofill(tx);
    const { tx_blob } = wallet.sign(prepared);
    return c.submitAndWait(tx_blob);
  });
  const code = r.result.meta.TransactionResult;
  log(`${label}: ${code}  ${explorer(r.result.hash)}`);
  note(label, { result: code, hash: r.result.hash });
  if (code !== "tesSUCCESS") throw new Error(`${label} → ${code}`);
  return r;
}

/** Multisigned by the given signers; `expect` lets a negative case assert its refusal without throwing. */
async function multisend(tx, signers, label, expect = "tesSUCCESS") {
  const prepared = await onLedger(() => c.autofill({ ...tx }, signers.length));
  const blobs = signers.map((w) => w.sign(prepared, true).tx_blob);
  const blob = multisign(blobs);
  if (expect.startsWith("tes")) {
    const r = await onLedger(() => c.submitAndWait(blob));
    const code = r.result.meta.TransactionResult;
    log(`${label}: ${code}  ${explorer(r.result.hash)}`);
    note(label, { result: code, hash: r.result.hash, signers: signers.map((w) => w.classicAddress) });
    if (code !== expect) throw new Error(`${label} → ${code}, expected ${expect}`);
    return r;
  }
  // tef/tem results are refused at the door: never in a ledger, no fee burnt, nothing to wait for
  const r = await onLedger(() => c.submit(blob));
  const code = r.result.engine_result;
  log(`${label}: ${code}  (${r.result.engine_result_message})`);
  note(label, { result: code, signers: signers.map((w) => w.classicAddress) });
  if (code !== expect) throw new Error(`${label} → ${code}, expected ${expect}`);
  return r;
}

async function balanceEur(addr, issuer) {
  const r = await onLedger(() => c.request({ command: "account_lines", account: addr, peer: issuer }));
  const l = r.result.lines.find((x) => x.currency === CURRENCY);
  return l ? Number(l.balance) : 0;
}

/**
 * One lease, start to finish. `sortie` says how it ends.
 * @param {{ id: string, loyerHorsChargesCents: number, meuble: boolean, remiseClesIso: string,
 *           conforme: boolean, restitutionIso: string, retenues: Array<{montantCents:number, motif:string, piece:string}> }} bail
 */
async function bailComplet({ issuer, bailleur, locataire, arbitre }, bail) {
  log(`\n═══ bail ${bail.id} — loyer ${euros(bail.loyerHorsChargesCents)} HC, ${bail.meuble ? "meublé" : "vide"} ═══`);
  const depotCents = plafondDepot(bail);
  log(`dépôt maximal légal (art. 22) : ${euros(depotCents)}`);

  // --- 2. the deposit account: born from the tenant's reserve, then handed to the three signers
  const compte = Wallet.generate();
  await send(locataire, { TransactionType: "Payment", Account: locataire.classicAddress, Destination: compte.classicAddress, Amount: xrpToDrops(RESERVE_XRP),
    Memos: [memo("dareskro/depot", `ouverture compte de dépôt bail ${bail.id}`)] }, `${bail.id} ouverture du compte de dépôt (réserve ${RESERVE_XRP} XRP, payée par le locataire)`);
  log(`compte de dépôt : ${compte.classicAddress}  ${account(compte.classicAddress)}`);

  await send(compte, { TransactionType: "TrustSet", Account: compte.classicAddress,
    LimitAmount: { currency: CURRENCY, issuer: issuer.classicAddress, value: (depotCents / 100).toString() } }, `${bail.id} trustline du compte vers l'euro`);

  const edlEntree = `état des lieux d'entrée — bail ${bail.id} — ${bail.edlEntree}`;
  await send(compte, { TransactionType: "SignerListSet", Account: compte.classicAddress, SignerQuorum: 2,
    SignerEntries: [bailleur, locataire, arbitre].map((w) => ({ SignerEntry: { Account: w.classicAddress, SignerWeight: 1 } })),
    Memos: [memo("dareskro/depot", `bail ${bail.id} : bailleur, locataire, arbitre — 2 signatures sur 3`), memo("dareskro/edl-entree-sha256", sha256(edlEntree))] },
    `${bail.id} SignerListSet 2-sur-3 (mémo : empreinte de l'état des lieux d'entrée)`);

  await send(compte, { TransactionType: "AccountSet", Account: compte.classicAddress, SetFlag: 4 /* asfDisableMaster */ },
    `${bail.id} clé maîtresse désactivée : seules 2 signatures sur 3 commandent le compte`);

  // --- 3. the deposit itself
  await send(locataire, { TransactionType: "Payment", Account: locataire.classicAddress, Destination: compte.classicAddress,
    Amount: eur(issuer.classicAddress, depotCents), Memos: [memo("dareskro/depot", `dépôt de garantie bail ${bail.id}`), memo("dareskro/edl-entree-sha256", sha256(edlEntree))] },
    `${bail.id} dépôt ${euros(depotCents)} versé par le locataire`);
  log(`solde du compte de dépôt : ${await balanceEur(compte.classicAddress, issuer.classicAddress)} ${CURRENCY}`);

  // --- 4. who cannot move it
  const tentative = (to, cents) => ({ TransactionType: "Payment", Account: compte.classicAddress, Destination: to, Amount: eur(issuer.classicAddress, cents) });
  await multisend(tentative(arbitre.classicAddress, depotCents), [arbitre], `${bail.id} l'arbitre seul tente de tout prendre`, "tefBAD_QUORUM");
  await multisend(tentative(bailleur.classicAddress, depotCents), [bailleur], `${bail.id} le bailleur seul tente de tout garder`, "tefBAD_QUORUM");
  {
    const prepared = await onLedger(() => c.autofill(tentative(bailleur.classicAddress, depotCents)));
    const r = await onLedger(() => c.submit(compte.sign(prepared).tx_blob));
    const code = r.result.engine_result;
    log(`${bail.id} l'ancienne clé du compte tente de payer : ${code}`);
    note(`${bail.id} ancienne clé maîtresse`, { result: code });
    if (code !== "tefMASTER_DISABLED") throw new Error(`master key → ${code}`);
  }

  // --- 5/6. the end of the lease: dates and amounts by bail.mjs, signatures by the parties
  const edlSortie = `état des lieux de sortie — bail ${bail.id} — ${bail.edlSortie}`;
  const { echeanceIso, delaiMois } = echeanceRestitution(bail);
  log(`remise des clés le ${bail.remiseClesIso}, état des lieux ${bail.conforme ? "conforme" : "NON conforme"} → restitution due au plus tard le ${echeanceIso} (${delaiMois} mois)`);

  const retenues = [];
  for (const r of bail.retenues) {
    const ret = { montantCents: r.montantCents, motif: r.motif, justificatifSha256: sha256(r.piece) };
    const v = verifieRetenue(ret, { depotCents });
    if (!v.ok) throw new Error(`retenue refusée : ${v.raison}`);
    retenues.push(ret);
  }
  const d = decompte({ ...bail, depotCents, retenues });
  log(`décompte : au locataire ${euros(d.auLocataireCents)}, au bailleur ${euros(d.auBailleurCents)}` + (d.majorationCents ? `, dont majoration de retard ${euros(d.majorationCents)} (${d.moisCommences} mois commencé·s)` : ", sans retard"));
  note(`${bail.id} décompte`, d);

  if (retenues.length === 0) {
    await multisend({ TransactionType: "Payment", Account: compte.classicAddress, Destination: locataire.classicAddress, Amount: eur(issuer.classicAddress, depotCents),
      Memos: [memo("dareskro/restitution", `bail ${bail.id} : restitution intégrale, due le ${echeanceIso}`), memo("dareskro/edl-sortie-sha256", sha256(edlSortie))] },
      [bailleur, locataire], `${bail.id} restitution intégrale ${euros(depotCents)} — signée bailleur + locataire`);
  } else {
    for (const r of retenues) {
      await multisend({ TransactionType: "Payment", Account: compte.classicAddress, Destination: bailleur.classicAddress, Amount: eur(issuer.classicAddress, r.montantCents),
        Memos: [memo("dareskro/retenue", `bail ${bail.id} : ${r.motif}`), memo("dareskro/justificatif-sha256", r.justificatifSha256)] },
        [bailleur, arbitre], `${bail.id} retenue ${euros(r.montantCents)} au bailleur — signée bailleur + arbitre, pièce en mémo`);
    }
    await multisend({ TransactionType: "Payment", Account: compte.classicAddress, Destination: locataire.classicAddress, Amount: eur(issuer.classicAddress, depotCents - d.retenuCents),
      Memos: [memo("dareskro/restitution", `bail ${bail.id} : solde après retenues, due le ${echeanceIso}`), memo("dareskro/edl-sortie-sha256", sha256(edlSortie))] },
      [locataire, arbitre], `${bail.id} solde ${euros(depotCents - d.retenuCents)} au locataire — signé locataire + arbitre`);
  }
  log(`soldes : compte de dépôt ${await balanceEur(compte.classicAddress, issuer.classicAddress)} ${CURRENCY}, locataire ${await balanceEur(locataire.classicAddress, issuer.classicAddress)}, bailleur ${await balanceEur(bailleur.classicAddress, issuer.classicAddress)}`);
  log(`la réserve (${RESERVE_XRP} XRP moins les frais) reste sur le compte de dépôt ; AccountDelete 2-sur-3 la rend au locataire une fois le compte vieux de 256 ledgers`);

  if (bail.simuleRetard) {
    const m = majorationRetard({ loyerHorsChargesCents: bail.loyerHorsChargesCents, echeanceIso, restitutionIso: bail.simuleRetard });
    log(`si la restitution n'avait eu lieu que le ${bail.simuleRetard} : ${m.moisCommences} mois commencé·s, majoration ${euros(m.majorationCents)} due au locataire, de plein droit`);
    note(`${bail.id} retard simulé`, { restitutionIso: bail.simuleRetard, ...m });
  }
  return compte.classicAddress;
}

// ───────────────────────────── run ─────────────────────────────
await c.connect();
log(`testnet ${TESTNET}`);

log("0. l'émetteur de l'euro de test (tient lieu d'EURØP), le bailleur, le locataire, l'arbitre : quatre comptes du robinet…");
const { wallet: issuer } = await onLedger(() => c.fundWallet());
const { wallet: bailleur } = await onLedger(() => c.fundWallet());
const { wallet: locataire } = await onLedger(() => c.fundWallet());
const { wallet: arbitre } = await onLedger(() => c.fundWallet());
report.accounts = { issuer: issuer.classicAddress, bailleur: bailleur.classicAddress, locataire: locataire.classicAddress, arbitre: arbitre.classicAddress };
log(`émetteur ${issuer.classicAddress}\nbailleur ${bailleur.classicAddress}\nlocataire ${locataire.classicAddress}\narbitre  ${arbitre.classicAddress}`);

// the euro must flow between holders: DefaultRipple on the issuer, like EURØP (Flags 0x80900000 carries it)
await send(issuer, { TransactionType: "AccountSet", Account: issuer.classicAddress, SetFlag: 8 /* asfDefaultRipple */ }, "émetteur : DefaultRipple");

// 1. inscription: each party opens its trust line to the euro, once. Without it, nobody can pay them (tecNO_LINE, measured 07/09/2026).
for (const [who, w] of [["bailleur", bailleur], ["locataire", locataire]]) {
  await send(w, { TransactionType: "TrustSet", Account: w.classicAddress, LimitAmount: { currency: CURRENCY, issuer: issuer.classicAddress, value: "100000" } }, `${who} : trustline vers l'euro (inscription)`);
}
// the tenant's euros arrive (stands for the SEPA transfer → EURØP leg done by a licensed partner)
await send(issuer, { TransactionType: "Payment", Account: issuer.classicAddress, Destination: locataire.classicAddress, Amount: eur(issuer.classicAddress, 300000) }, "locataire : 3 000 € reçus (virement SEPA simulé)");

const parties = { issuer, bailleur, locataire, arbitre };

const compteA = await bailComplet(parties, {
  id: "A", loyerHorsChargesCents: 120000, meuble: false,
  edlEntree: "entrée 01/11/2025, murs propres, parquet rayé chambre (préexistant), 3 clés", edlSortie: "sortie 27/10/2026, conforme à l'entrée, 3 clés rendues",
  remiseClesIso: "2026-10-27", conforme: true, restitutionIso: "2026-10-27", retenues: [],
});

const compteB = await bailComplet(parties, {
  id: "B", loyerHorsChargesCents: 120000, meuble: false,
  edlEntree: "entrée 01/11/2025, murs propres, 3 clés", edlSortie: "sortie 27/10/2026, trou 8 cm mur salon, 3 clés rendues",
  remiseClesIso: "2026-10-27", conforme: false, restitutionIso: "2026-10-27",
  retenues: [{ montantCents: 18000, motif: "rebouchage et peinture mur salon", piece: "devis n° 2026-1142, peintre X, 180,00 € TTC" }],
  simuleRetard: "2027-01-10",
});

report.deposits = { A: compteA, B: compteB };
writeFileSync(REPORT, JSON.stringify(report, null, 2));
log(`\ncompte rendu public : ${REPORT}`);
await c.disconnect();
