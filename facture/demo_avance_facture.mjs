#!/usr/bin/env node
/**
 * Invoice advance (avance sur facture), live on the XRP Ledger testnet — the honest version, today.
 *
 * THE SHAPE. A supplier holds an invoice on a final client, due in 30-90 days, and wants the money now.
 * A pool advances 90 % of it; at the due date the client pays the pool; the pool keeps a fee and hands the
 * rest to the supplier. Advancing money against an invoice is a LENDING business (see README: agrément).
 * The ledger does not know what a loan is yet (XLS-65/66 are not on mainnet: see devnet_xls65_66.mjs),
 * so the pool is a plain ACCOUNT controlled by a 2-of-3 signer list, on the model of depot/:
 *   - the AI (analyse.mjs): gathers the evidence, writes and ANCHORS its analysis, proposes;
 *   - the risk policy (politique.mjs): deterministic code, per-debtor cap and concentration cap, refuses beyond;
 *   - the human operator.
 * The master key is disabled. Two signatures move money. Nobody holds the pool's money alone.
 *
 * WHAT RUNS (every step a real testnet transaction, hashes printed, report in compte_rendu.json):
 *   0. eight faucet accounts: two lenders, the supplier, two final clients, the AI, the policy, the operator
 *   1. the pool: funded 80 + 80 XRP by the lenders, SignerListSet quorum 2, master disabled
 *   2. F-2026-001 (client 1, 50 XRP, advance 45): the invoice becomes a one-unit MPT (XLS-33) issued by the
 *      supplier with the dossier's fingerprint in its metadata; the AI anchors its analysis; the policy says
 *      yes; the pool accepts the token (2/3), the supplier hands it over (the receivable is assigned);
 *      the advance is paid, signed AI + policy. The client locks the repayment in an XRP escrow to the pool,
 *      FinishAfter = due date. The operator tries to cash it early → tecNO_PERMISSION (the ledger holds the date).
 *   3. F-2026-002 (client 1 again, 10 XRP, advance 9): the AI proposes, the POLICY REFUSES — 45 + 9 = 54 would
 *      be 33.8 % of a 160 capital, above the 30 % concentration cap. The refusal comes from a SIGNER, not from
 *      the ledger, and the run proves it: the AI alone → tefBAD_QUORUM (the ledger only counts signatures);
 *      AI + operator overriding the policy → tesSUCCESS. Nothing in the ledger knows the cap. (Version 2 fixes that.)
 *   4. F-2026-003 (client 2, 40 XRP, advance 36): accepted; the client promises a transfer, locks nothing.
 *   5. the due dates. F-001: EscrowFinish → 50 XRP reach the pool; the pool pays the supplier its 4 XRP balance
 *      (50 − 45 − 1 of fee) and returns the token to its issuer: the receivable is extinguished. F-002: the
 *      client pays by an ordinary Payment. F-003: nothing arrives. DEFAULT: the pool writes it (AccountSet 2/3,
 *      memo), keeps the token as the trace of the assignment, and can do NOTHING on the ledger against the
 *      client — no transaction type lets a creditor take; the recourse is contractual: here the supplier buys the
 *      receivable back (an ordinary Payment of 36 XRP, which it also could have refused).
 *
 * Amounts are XRP standing in for euros: no euro token on XRPL can be escrowed (EURØP, RLUSD measured 08/09
 * and 27/10/2026), so the only repayment the ledger can hold to a date is in XRP. Said again in the README.
 * No seed is written to disk by this script: faucet accounts that live for the run.
 *
 * Usage: node demo_avance_facture.mjs [--due 150] [--grace 600]     (≈ 7 minutes on testnet)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dossierFacture, sha256 } from "./facture.mjs";
import { LIMITES, evaluer } from "./politique.mjs";
import { analyser, conserverAnalyse } from "./analyse.mjs";
import { Registre, TESTNET, compteUrl, dropsToXrp, log, memo, sleep, xrpToDrops } from "./registre.mjs";
import { readFileSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const DUE_S = arg("--due", 150);      // seconds until the due dates (30-90 days in production)
const GRACE_S = arg("--grace", 600);  // CancelAfter = due + grace: after it the client could take the escrow back
const CAPITAL_PAR_PRETEUR = 80;

const R = new Registre(TESTNET);
const report = { network: TESTNET, date: new Date().toISOString(), limites: LIMITES, steps: [], factures: {} };
const note = (x) => { const { meta, tx, ...rest } = x; report.steps.push(rest); return x; };
const piece = (id) => { const chemin = path.join(HERE, "pieces", `${id}.txt`); return { nom: `${id}.txt`, chemin, sha256: sha256(readFileSync(chemin)) }; };
const plusS = (s) => new Date(Math.ceil((Date.now() + s * 1000) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

await R.connect();
log(`testnet ${TESTNET}`);

// ── 0. the accounts
log("0. huit comptes du robinet : deux prêteurs, le fournisseur, deux clients finaux, l'IA, la politique de risque, l'opérateur…");
const comptes = [];
for (let i = 0; i < 8; i++) { comptes.push(await R.faucet()); await sleep(1500); } // the faucet answers 429 to parallel calls
const [preteurA, preteurB, fournisseur, client1, client2, ia, politique, operateur] = comptes;
const roles = { preteurA, preteurB, fournisseur, client1, client2, ia, politique, operateur };
report.accounts = Object.fromEntries(Object.entries(roles).map(([k, w]) => [k, w.classicAddress]));
for (const [k, w] of Object.entries(roles)) log(`${k.padEnd(12)} ${w.classicAddress}`);

// ── 1. the pool
log("\n1. le pool : un compte, trois signataires, deux signatures");
const { pool, steps } = await R.creerPool({ payeur: operateur, reserveXrp: "3", signataires: [ia, politique, operateur], memos: [memo("dareskro/pool", "ouverture du pool d'avances sur facture")] });
steps.forEach(note);
report.pool = pool.classicAddress;
log(`pool ${pool.classicAddress}  ${compteUrl(pool.classicAddress)}`);
for (const [k, w] of [["prêteur A", preteurA], ["prêteur B", preteurB]]) {
  note(await R.envoyer(w, { TransactionType: "Payment", Account: w.classicAddress, Destination: pool.classicAddress, Amount: xrpToDrops(CAPITAL_PAR_PRETEUR), Memos: [memo("dareskro/apport", `${k} : ${CAPITAL_PAR_PRETEUR} XRP de capital`)] }, `${k} apporte ${CAPITAL_PAR_PRETEUR} XRP au pool`));
}
const capital = String(2 * CAPITAL_PAR_PRETEUR);
const encours = {}; // per debtor address, advanced and not repaid
const etat = () => ({ capital, encours: { ...encours } });
log(`capital ${capital} XRP (la réserve de 3 XRP n'en fait pas partie) ; plafonds : ${LIMITES.partDebiteurMax * 100} % du capital par débiteur, ${LIMITES.plafondDebiteur} XRP absolu, avance ≤ ${LIMITES.tauxAvanceMax * 100} %, échéance ≤ ${LIMITES.echeanceMaxJours} j`);

// ── the life of one invoice, up to the decision
async function instruire({ id, client, clientNom, montant, dueS }) {
  const p = piece(id);
  const dossier = dossierFacture({ id, fournisseur: { nom: "Atelier Nord (test)", adresse: fournisseur.classicAddress }, client: { nom: clientNom, adresse: client.classicAddress },
    montant, emission: new Date().toISOString().slice(0, 10), echeance: plusS(dueS), pieces: [p], pool: pool.classicAddress });
  log(`\n═══ ${id} — ${clientNom}, ${montant} XRP, due le ${dossier.echeance}, avance demandée ${dossier.avance.montant} ═══`);
  log(`empreinte du dossier ${dossier.sha256}`);
  const jeton = note(await R.emettreJetonFacture(fournisseur, dossier));
  log(`jeton ${jeton.issuanceId} — métadonnées ${jeton.metadata}`);
  const analyse = await analyser({ registre: R, dossier, pieces: [p], pool: pool.classicAddress, encours, capital });
  log(`analyse de l'IA : ${analyse.recommandation} — ${analyse.faits.length} faits, réserves : ${analyse.reserves.join(" ; ") || "aucune"}`);
  const ancrage = note(await R.ancrerAnalyse(ia, analyse));
  analyse.ancrage = ancrage.hash;
  const fichier = conserverAnalyse(analyse);
  const verdict = evaluer(dossier, etat(), { sha256: analyse.sha256, facture_sha256: analyse.facture_sha256, ancrage: analyse.ancrage });
  log(`politique de risque : ${verdict.ok ? "ACCEPTE" : "REFUSE"}${verdict.raisons.length ? " — " + verdict.raisons.join(" ; ") : ""}`);
  report.factures[id] = { dossier, jeton: jeton.issuanceId, analyse: { sha256: analyse.sha256, ancrage: analyse.ancrage, fichier: path.relative(HERE, fichier), recommandation: analyse.recommandation }, politique: verdict };
  return { dossier, jeton, analyse, verdict };
}
async function avancer(f, signers, expect = "tesSUCCESS") {
  const { dossier, jeton, analyse } = f;
  if (expect === "tesSUCCESS") {
    const c = await R.cederCreance({ pool, signers, fournisseur, issuanceId: jeton.issuanceId, dossier });
    note(c.authorize); note(c.cession);
  }
  const r = note(await R.avancer({ pool, signers, dossier, analyseSha256: analyse.sha256, expect }));
  if (r.result === "tesSUCCESS") { encours[dossier.client.adresse] = String(Number(encours[dossier.client.adresse] ?? 0) + Number(dossier.avance.montant)); report.factures[dossier.id].avance = r.hash; }
  return r;
}

// ── 2. F-001: accepted, repayment locked in an escrow
const f1 = await instruire({ id: "F-2026-001", client: client1, clientNom: "Pharmacie du Port (test)", montant: "50", dueS: DUE_S });
if (!f1.verdict.ok) throw new Error("F-001 should pass");
await avancer(f1, [ia, politique]);
const esc1 = note(await R.verrouillerRemboursement({ debiteur: client1, pool, dossier: f1.dossier, graceS: GRACE_S }));
const esc1Seq = esc1.tx.Sequence;
report.factures["F-2026-001"].escrow = { hash: esc1.hash, owner: client1.classicAddress, sequence: esc1Seq, finishAfter: esc1.finishAfter };
note(await R.encaisser({ qui: operateur, owner: client1.classicAddress, sequence: esc1Seq, dossier: f1.dossier, expect: "tecNO_PERMISSION" }));
log("→ le registre tient la date : avant l'échéance, personne n'encaisse");

// ── 3. F-002: the policy refuses; the ledger would not have
const f2 = await instruire({ id: "F-2026-002", client: client1, clientNom: "Pharmacie du Port (test)", montant: "10", dueS: DUE_S });
if (f2.verdict.ok) throw new Error("F-002 should be refused by the policy");
log("→ la politique de risque ne signe pas. Le refus vient d'un signataire, pas du registre. Preuve :");
await avancer(f2, [ia], "tefBAD_QUORUM");
log("→ l'IA seule : tefBAD_QUORUM — le registre compte les signatures, rien d'autre");
report.factures["F-2026-002"].contreEpreuve = "IA + opérateur passent outre la politique";
await avancer(f2, [ia, operateur]);
log("→ IA + opérateur : tesSUCCESS — rien dans le registre ne connaît le plafond. C'est ce que la version XLS-66 change (DebtMaximum).");

// ── 4. F-003: accepted, nothing locked
const f3 = await instruire({ id: "F-2026-003", client: client2, clientNom: "Clinique des Pins (test)", montant: "40", dueS: Math.max(60, DUE_S - 60) });
if (!f3.verdict.ok) throw new Error("F-003 should pass");
await avancer(f3, [ia, politique]);
log("→ le client 2 dit qu'il paiera par virement ; rien n'est verrouillé");
log(`soldes : pool ${await R.soldeXrp(pool.classicAddress)} XRP, fournisseur ${await R.soldeXrp(fournisseur.classicAddress)} XRP ; encours ${JSON.stringify(encours)}`);

// ── 5. the due dates
const attendre = async (iso, label) => { const ms = new Date(iso) - Date.now() + 8000; if (ms > 0) { log(`attente de l'échéance ${label} (${Math.ceil(ms / 1000)} s)…`); await sleep(ms); } };
await attendre(f3.dossier.echeance, "F-003");
await attendre(f1.dossier.echeance, "F-001");
log("\n5. les échéances");
// F-001: the escrow pays the pool whether the client likes it or not
const enc = note(await R.encaisser({ qui: operateur, owner: client1.classicAddress, sequence: esc1Seq, dossier: f1.dossier }));
report.factures["F-2026-001"].encaissement = enc.hash;
encours[client1.classicAddress] = String(Number(encours[client1.classicAddress]) - Number(f1.dossier.avance.montant));
const solde = note(await R.multisigner({ TransactionType: "Payment", Account: pool.classicAddress, Destination: fournisseur.classicAddress, Amount: xrpToDrops(f1.dossier.solde_fournisseur),
  Memos: [memo("dareskro/solde", `facture F-2026-001 encaissée : solde au fournisseur après avance ${f1.dossier.avance.montant} et frais ${f1.dossier.frais.montant}`), memo("dareskro/facture-sha256", f1.dossier.sha256)] },
  [politique, operateur], `F-2026-001 solde ${f1.dossier.solde_fournisseur} XRP au fournisseur (frais ${f1.dossier.frais.montant} gardés par le pool), signé politique + opérateur`));
report.factures["F-2026-001"].solde = solde.hash;
report.factures["F-2026-001"].eteinte = note(await R.eteindreCreance({ pool, signers: [politique, operateur], fournisseur, issuanceId: f1.jeton.issuanceId, dossier: f1.dossier, motif: "payée par le client à l'échéance" })).hash;
// F-002: an ordinary payment by the client
const pay2 = note(await R.envoyer(client1, { TransactionType: "Payment", Account: client1.classicAddress, Destination: pool.classicAddress, Amount: xrpToDrops(f2.dossier.montant),
  Memos: [memo("dareskro/remboursement", `facture F-2026-002, due le ${f2.dossier.echeance}`), memo("dareskro/facture-sha256", f2.dossier.sha256)] }, "F-2026-002 le client paie le pool par un Payment ordinaire (rien ne l'y forçait)"));
report.factures["F-2026-002"].remboursement = pay2.hash;
encours[client1.classicAddress] = String(Number(encours[client1.classicAddress]) - Number(f2.dossier.avance.montant));
report.factures["F-2026-002"].solde = note(await R.multisigner({ TransactionType: "Payment", Account: pool.classicAddress, Destination: fournisseur.classicAddress, Amount: xrpToDrops(f2.dossier.solde_fournisseur),
  Memos: [memo("dareskro/solde", "facture F-2026-002 encaissée : solde au fournisseur"), memo("dareskro/facture-sha256", f2.dossier.sha256)] }, [politique, operateur], `F-2026-002 solde ${f2.dossier.solde_fournisseur} XRP au fournisseur`)).hash;
report.factures["F-2026-002"].eteinte = note(await R.eteindreCreance({ pool, signers: [politique, operateur], fournisseur, issuanceId: f2.jeton.issuanceId, dossier: f2.dossier, motif: "payée par le client" })).hash;
// F-003: nothing came
const recu = await R.onLedger((c) => c.request({ command: "account_tx", account: pool.classicAddress, limit: 100 }));
const dePuisClient2 = recu.result.transactions.filter((t) => (t.tx_json ?? t.tx).Account === client2.classicAddress);
log(`F-2026-003 : échéance ${f3.dossier.echeance} passée, transactions reçues du client 2 : ${dePuisClient2.length}`);
if (dePuisClient2.length) throw new Error("unexpected payment from client 2");
log("→ DÉFAUT. Ce que le pool peut faire sur le registre : l'écrire, garder le jeton de la créance. Ce qu'il ne peut pas : prélever le client — aucune transaction ne permet à un créancier de prendre ; rien n'est soumis ici.");
report.factures["F-2026-003"].defaut = note(await R.constaterDefaut({ pool, signers: [ia, operateur], dossier: f3.dossier, texte: `facture F-2026-003 due le ${f3.dossier.echeance} : rien reçu du client ${client2.classicAddress} ; avance ${f3.dossier.avance.montant} XRP non couverte ; recours contractuel contre le fournisseur` })).hash;
log("→ recours contractuel : le fournisseur rachète la créance (un Payment ordinaire, qu'il aurait aussi pu refuser)");
report.factures["F-2026-003"].rachat = note(await R.envoyer(fournisseur, { TransactionType: "Payment", Account: fournisseur.classicAddress, Destination: pool.classicAddress, Amount: xrpToDrops(f3.dossier.avance.montant),
  Memos: [memo("dareskro/rachat", `facture F-2026-003 : rachat de la créance par le fournisseur (recours)`), memo("dareskro/facture-sha256", f3.dossier.sha256)] }, `F-2026-003 le fournisseur rachète la créance : ${f3.dossier.avance.montant} XRP → pool`)).hash;
encours[client2.classicAddress] = "0";
report.factures["F-2026-003"].eteinte = note(await R.eteindreCreance({ pool, signers: [politique, operateur], fournisseur, issuanceId: f3.jeton.issuanceId, dossier: f3.dossier, motif: "rachetée par le fournisseur après défaut du client" })).hash;

// ── the end
const soldes = { pool: await R.soldeXrp(pool.classicAddress), fournisseur: await R.soldeXrp(fournisseur.classicAddress), client1: await R.soldeXrp(client1.classicAddress), client2: await R.soldeXrp(client2.classicAddress) };
report.soldesFinaux = soldes;
report.encoursFinal = encours;
log(`\nsoldes finaux : pool ${soldes.pool} XRP (capital 160 + frais 1,2 + réserve ≈ 3 − frais de réseau), fournisseur ${soldes.fournisseur}, client 1 ${soldes.client1}, client 2 ${soldes.client2}`);
log("qui détient quoi : les prêteurs ont apporté 160 ; le pool les tient sous 2 signatures sur 3 ; l'IA, la politique et l'opérateur ne détiennent rien ; dareskro n'a jamais eu la main seul");
mkdirSync(path.join(HERE, "sortie"), { recursive: true });
const REPORT = path.join(HERE, "compte_rendu.json");
writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
log(`compte rendu public : ${REPORT}`);
await R.disconnect();
