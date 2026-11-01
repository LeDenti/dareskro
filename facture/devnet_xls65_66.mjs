#!/usr/bin/env node
/**
 * Invoice advance with the ledger's own lending objects — XLS-65 Single Asset Vault + XLS-66 Lending
 * Protocol — on DEVNET only (both amendments are enabled there; on mainnet they are voted but not enabled,
 * see README for the validator count measured on 01/11/2026). Nothing here runs on mainnet.
 *
 * WHAT IT MAPS. The pool is a Vault (XLS-65): lenders deposit XRP and receive shares (an MPT the ledger
 * mints). dareskro is a Loan Broker (XLS-66) on that vault: its DebtMaximum is the concentration cap, held by
 * the LEDGER, not by a signer. An advance is a Loan: the supplier is the borrower, the invoice's fingerprint
 * is the loan's Data; the ledger moves the principal from the vault to the supplier. Repayment is LoanPay;
 * a missed due date lets the broker declare the default with LoanManage, and the ledger realises the loss
 * (first-loss cover of the broker, then the vault's shares). Compared with version 1 (the 2-of-3 account):
 * what a signer refused there, the ledger refuses here; what the ledger could not do there (write off a
 * loss, hold a cap) it does here.
 *
 * WHAT RUNS (devnet, faucet accounts, every step with its hash; report in compte_rendu_devnet.json):
 *   0. the amendments are checked with `feature` on the node; if either is missing the script stops and says so
 *   1. four accounts: dareskro (vault owner and broker), two lenders, the supplier (borrower), a stranger
 *   2. VaultCreate (XRP, public, CLOSED-ENDED: LendingProtocolV1_1 on devnet only lets a broker attach to a vault with a
 *      subscription phase, an investment phase and a redemption phase; Data = the pool's charter hash) → VaultDeposit
 *      80 + 80 by the lenders during the subscription phase; a deposit during the investment phase is refused (measured)
 *   3. LoanBrokerSet: DebtMaximum = 48 XRP (30 % of 160), ManagementFeeRate, CoverRateMinimum; the broker
 *      deposits its first-loss cover (LoanBrokerCoverDeposit)
 *   4. LoanSet #1: 45 XRP to the supplier, Data = sha256 of invoice F-001, one payment due in PaymentInterval
 *      seconds — signed by the broker then counter-signed by the borrower (xrpl.js signLoanSetByCounterparty);
 *      the stranger tries LoanPay on it → refused by the ledger (measured code)
 *   5. LoanSet #2: 9 XRP would carry the broker's debt to 54 > DebtMaximum → REFUSED BY THE LEDGER (measured code).
 *      Nobody can override it with a second signature: the cap is in the object.
 *   6. LoanPay #1 by the supplier: tfLoanFullPayment is refused on a one-payment loan (tecKILLED, "last payment cannot be a
 *      full payment"), the regular payment of the scheduled amount succeeds: the vault is whole again, with the interest
 *   7. LoanSet #3: 36 XRP, due date + grace allowed to pass, nothing paid → LoanManage tfLoanDefault by the
 *      broker: the ledger writes the default and realises the loss against the cover and the vault
 *   8. the redemption phase: the lenders withdraw what is left (VaultWithdraw), the loss shared pro rata, read from the ledger
 *
 * Anything the node refuses with a code we did not expect is printed as is and kept in the report: this is a
 * measurement of a protocol that is weeks old, not a product.
 *
 * Usage: node devnet_xls65_66.mjs [--interval 90] [--grace 60] [--sub 40] [--gap 420]   (≈ 9 minutes)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, xrpToDrops, dropsToXrp, convertStringToHex, signLoanSetByCounterparty } from "xrpl";
import { sha256, canonique } from "./facture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const INTERVAL_S = arg("--interval", 90);
const GRACE_S = arg("--grace", 60);   // rippled: kDefaultGracePeriod 60 ≤ grace ≤ interval; kMinPaymentInterval 60
const SUB_S = arg("--sub", 40);        // subscription phase length (deposits), from the vault's creation
const GAP_S = arg("--gap", 420);       // investment phase length; rippled: kMinInvestmentPeriod 180 s
const RIPPLE_EPOCH = 946684800;
const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const DEVNET = process.env.XRPL_DEVNET || "wss://s.devnet.rippletest.net:51233";
const EXPLORER = "https://devnet.xrpl.org";
const explorer = (h) => `${EXPLORER}/transactions/${h}`;
const xrp = (d) => dropsToXrp(String(d ?? 0)); // optional ledger fields are omitted when zero
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => convertStringToHex(s);
const memo = (type, data) => ({ Memo: { MemoType: hex(type), MemoData: hex(data) } });

const c = new Client(DEVNET);
const report = { network: DEVNET, date: new Date().toISOString(), steps: [], refusals: [] };
const note = (x) => { report.steps.push(x); return x; };

async function onLedger(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { if (!c.isConnected()) await c.connect(); return await fn(); }
    catch (err) { if (i >= tries - 1) throw err; log(`ledger hiccup (${String(err?.message ?? err).slice(0, 80)}), retry in 5 s`); try { await c.disconnect(); } catch {} await sleep(5000); }
  }
}
/** Submit a signed blob; tes/tec are waited for, tef/tem come back from the door. `expect` = a code or "any" (record whatever comes). */
async function soumettre(blob, label, expect = "tesSUCCESS") {
  const first = await onLedger(() => c.submit(blob));
  const pre = first.result.engine_result;
  if (!(pre.startsWith("tes") || pre.startsWith("tec") || pre.startsWith("ter"))) {
    log(`${label}: ${pre}  (${first.result.engine_result_message})`);
    const out = { label, result: pre, message: first.result.engine_result_message, atDoor: true };
    if (expect !== "any" && pre !== expect) throw new Error(`${label} → ${pre}, expected ${expect}`);
    return out;
  }
  // wait for validation of that very hash
  const hash = first.result.tx_json.hash;
  const lastLedger = first.result.tx_json.LastLedgerSequence;
  for (;;) {
    await sleep(2500);
    try {
      const r = await onLedger(() => c.request({ command: "tx", transaction: hash }));
      if (r.result.validated) {
        const code = r.result.meta.TransactionResult;
        log(`${label}: ${code}  ${explorer(hash)}`);
        const out = { label, result: code, hash, ledger: r.result.ledger_index, close: r.result.close_time_iso, explorer: explorer(hash), meta: r.result.meta, tx: r.result.tx_json };
        if (expect !== "any" && code !== expect) throw new Error(`${label} → ${code}, expected ${expect}`);
        return out;
      }
    } catch (e) { if (e?.data?.error !== "txnNotFound") throw e; }
    const li = await onLedger(() => c.getLedgerIndex());
    if (li > lastLedger) throw new Error(`${label}: dropped (preliminary ${pre})`);
  }
}
async function envoyer(wallet, tx, label, expect = "tesSUCCESS") {
  const prepared = await onLedger(() => c.autofill(tx));
  return soumettre(wallet.sign(prepared).tx_blob, label, expect);
}
const created = (meta, type) => meta.AffectedNodes.find((n) => n.CreatedNode?.LedgerEntryType === type)?.CreatedNode;
const entry = async (index) => (await onLedger(() => c.request({ command: "ledger_entry", index, ledger_index: "validated" }))).result.node;
const solde = async (a) => Number(await onLedger(() => c.getXrpBalance(a)));

// ── 0. the amendments
await c.connect();
const si = await c.request({ command: "server_info" });
const feats = Object.values((await c.request({ command: "feature" })).result.features);
const f = (n) => feats.find((x) => x.name === n);
report.node = { url: DEVNET, build: si.result.info.build_version, ledger: si.result.info.validated_ledger?.seq, SingleAssetVault: f("SingleAssetVault")?.enabled, LendingProtocol: f("LendingProtocol")?.enabled };
log(`devnet ${DEVNET} — rippled ${report.node.build}, ledger ${report.node.ledger}`);
log(`SingleAssetVault enabled: ${report.node.SingleAssetVault} — LendingProtocol enabled: ${report.node.LendingProtocol}`);
if (!report.node.SingleAssetVault || !report.node.LendingProtocol) { log("STOP: an amendment is missing on this node; nothing else is attempted."); writeFileSync(path.join(HERE, "compte_rendu_devnet.json"), JSON.stringify(report, null, 2)); process.exit(2); }

// ── 1. accounts
log("1. quatre comptes du robinet devnet : dareskro (coffre + courtier), prêteur A, prêteur B, fournisseur, un étranger…");
const comptes = [];
for (let i = 0; i < 5; i++) { comptes.push((await onLedger(() => c.fundWallet())).wallet); await sleep(1500); } // the faucet answers 429 to parallel calls
const [dareskro, preteurA, preteurB, fournisseur, etranger] = comptes;
report.accounts = { dareskro: dareskro.classicAddress, preteurA: preteurA.classicAddress, preteurB: preteurB.classicAddress, fournisseur: fournisseur.classicAddress, etranger: etranger.classicAddress };
for (const [k, v] of Object.entries(report.accounts)) log(`${k.padEnd(12)} ${v}`);

// ── 2. the vault = the pool
const charte = { t: "dareskro/pool-charter/1", objet: "avances sur facture", plafond_concentration_pct: 30, taux_avance_max_pct: 90, echeance_max_jours: 90 };
const charteSha = sha256(canonique(charte));
const subscriptionDate = rippleNow() + SUB_S;
const redemptionDate = subscriptionDate + GAP_S;
const vc = note(await envoyer(dareskro, { TransactionType: "VaultCreate", Account: dareskro.classicAddress, Asset: { currency: "XRP" }, WithdrawalPolicy: 1, Data: hex(`dareskro/pool-charter-sha256:${charteSha}`),
  VaultKind: 1 /* closed-ended */, SubscriptionDate: subscriptionDate, RedemptionDate: redemptionDate,
  Memos: [memo("dareskro/pool", "coffre XLS-65 : avances sur facture")] }, `VaultCreate (XRP, public, fermé : souscription ${SUB_S} s puis investissement ${GAP_S} s, Data = empreinte de la charte du pool)`));
report.phases = { subscriptionDate, redemptionDate, subscriptionIso: new Date((subscriptionDate + RIPPLE_EPOCH) * 1000).toISOString(), redemptionIso: new Date((redemptionDate + RIPPLE_EPOCH) * 1000).toISOString() };
log(`phases : souscription jusqu'à ${report.phases.subscriptionIso}, investissement jusqu'à ${report.phases.redemptionIso}, puis rachat`);
const vaultNode = created(vc.meta, "Vault");
const vaultId = vaultNode.LedgerIndex;
const vaultAccount = vaultNode.NewFields.Account;
const shareId = vaultNode.NewFields.ShareMPTID;
report.vault = { id: vaultId, pseudoAccount: vaultAccount, shareMPTID: shareId, charteSha256: charteSha };
log(`coffre ${vaultId} — pseudo-compte ${vaultAccount} — parts MPT ${shareId}`);
for (const [k, w] of [["prêteur A", preteurA], ["prêteur B", preteurB]]) {
  note(await envoyer(w, { TransactionType: "VaultDeposit", Account: w.classicAddress, VaultID: vaultId, Amount: xrpToDrops(80) }, `${k} dépose 80 XRP dans le coffre (VaultDeposit)`));
}
let v = await entry(vaultId);
log(`coffre : AssetsTotal ${xrp(v.AssetsTotal)} XRP, AssetsAvailable ${xrp(v.AssetsAvailable)} XRP`);
report.vault.apres_depots = { AssetsTotal: v.AssetsTotal, AssetsAvailable: v.AssetsAvailable };

// ── 3. the broker = dareskro, with the cap in the object
const DEBT_MAX_XRP = 48; // 30 % of 160: the concentration cap, now held by the ledger
const bs = note(await envoyer(dareskro, { TransactionType: "LoanBrokerSet", Account: dareskro.classicAddress, VaultID: vaultId, DebtMaximum: String(xrpToDrops(DEBT_MAX_XRP)),
  ManagementFeeRate: 200 /* 2 % of interest, in 1/10000 */, CoverRateMinimum: 1000 /* 10 % first-loss cover */, CoverRateLiquidation: 500,
  Data: hex(`dareskro/pool-charter-sha256:${charteSha}`) }, `LoanBrokerSet : dareskro courtier, DebtMaximum ${DEBT_MAX_XRP} XRP imposé par le registre`));
const brokerNode = created(bs.meta, "LoanBroker");
const brokerId = brokerNode.LedgerIndex;
report.broker = { id: brokerId, pseudoAccount: brokerNode.NewFields.Account, DebtMaximum: brokerNode.NewFields.DebtMaximum };
log(`courtier ${brokerId} — DebtMaximum ${brokerNode.NewFields.DebtMaximum} drops`);
note(await envoyer(dareskro, { TransactionType: "LoanBrokerCoverDeposit", Account: dareskro.classicAddress, LoanBrokerID: brokerId, Amount: xrpToDrops(10) }, "LoanBrokerCoverDeposit : 10 XRP de couverture première perte, apportés par dareskro"));

const attendre = async (rippleT, label, margeS = 6) => { const ms = (rippleT + RIPPLE_EPOCH + margeS) * 1000 - Date.now(); if (ms > 0) { log(`attente : ${label} (${Math.ceil(ms / 1000)} s)…`); await sleep(ms); } };
await attendre(subscriptionDate, "fin de la phase de souscription");
const late = note(await envoyer(preteurB, { TransactionType: "VaultDeposit", Account: preteurB.classicAddress, VaultID: vaultId, Amount: xrpToDrops(10) }, "prêteur B tente un dépôt pendant la phase d'investissement", "any"));
report.refusals.push({ what: "VaultDeposit in investment phase", code: late.result });

// ── a loan: broker signs, borrower counter-signs
async function preter({ id, principalXrp, factureSha, intervalS, graceS, expect = "tesSUCCESS", label }) {
  const tx = await onLedger(() => c.autofill({ TransactionType: "LoanSet", Account: dareskro.classicAddress, LoanBrokerID: brokerId, PrincipalRequested: String(xrpToDrops(principalXrp)),
    Counterparty: fournisseur.classicAddress, Data: hex(`dareskro/facture-sha256:${factureSha}`), PaymentTotal: 1, PaymentInterval: intervalS, GracePeriod: graceS, InterestRate: 200,
    Memos: [memo("dareskro/case", "avance-facture"), memo("dareskro/facture-sha256", factureSha), memo("dareskro/doc", `facture ${id}`)] }));
  const premiere = dareskro.sign(tx);
  const contre = signLoanSetByCounterparty(fournisseur, premiere.tx_blob);
  const r = await soumettre(contre.tx_blob, label ?? `${id} LoanSet ${principalXrp} XRP, signé courtier + contresigné fournisseur`, expect);
  const loan = r.meta ? created(r.meta, "Loan") : null;
  return { ...r, loanId: loan?.LedgerIndex, loan: loan?.NewFields };
}
const F = { "F-2026-001": sha256("facture F-2026-001 (devnet)"), "F-2026-002": sha256("facture F-2026-002 (devnet)"), "F-2026-003": sha256("facture F-2026-003 (devnet)") };
report.factures = F;

// ── 4. loan 1
const avantF1 = await solde(fournisseur.classicAddress);
const l1 = note(await preter({ id: "F-2026-001", principalXrp: 45, factureSha: F["F-2026-001"], intervalS: INTERVAL_S, graceS: GRACE_S }));
log(`prêt ${l1.loanId} — fournisseur ${avantF1} → ${await solde(fournisseur.classicAddress)} XRP ; échéance ${l1.loan?.NextPaymentDueDate} (ripple time), remboursement périodique ${l1.loan?.PeriodicPayment}`);
v = await entry(vaultId);
let b = await entry(brokerId);
log(`coffre AssetsAvailable ${xrp(v.AssetsAvailable)} XRP ; courtier DebtTotal ${b.DebtTotal ?? 0} / DebtMaximum ${b.DebtMaximum}`);
report.apres_pret1 = { vault: { AssetsTotal: v.AssetsTotal, AssetsAvailable: v.AssetsAvailable }, broker: { DebtTotal: b.DebtTotal, DebtMaximum: b.DebtMaximum }, loan: l1.loan };
const drops = (x) => String(Math.ceil(Number(x))); // the ledger keeps fractional drops in the loan (interest); a Payment amount must be whole drops
const paie = drops(l1.loan.PeriodicPayment || l1.loan.TotalValueOutstanding);
const str = note(await envoyer(etranger, { TransactionType: "LoanPay", Account: etranger.classicAddress, LoanID: l1.loanId, Amount: paie }, "un étranger tente LoanPay sur le prêt 1", "any"));
report.refusals.push({ what: "stranger LoanPay", code: str.result });

// ── 5. loan 2: over the cap → the ledger refuses
const l2 = note(await preter({ id: "F-2026-002", principalXrp: 9, factureSha: F["F-2026-002"], intervalS: INTERVAL_S, graceS: GRACE_S, expect: "any", label: "F-2026-002 LoanSet 9 XRP : 45 + 9 = 54 > DebtMaximum 48" }));
report.refusals.push({ what: "LoanSet over DebtMaximum", code: l2.result, message: l2.message });
log(`→ ${l2.result}: ${l2.result === "tesSUCCESS" ? "LE REGISTRE A ACCEPTÉ (inattendu)" : "le registre refuse lui-même ; aucune seconde signature ne peut passer outre"}`);

// ── 6. loan 1 repaid: a single-payment loan takes a REGULAR payment (tfLoanFullPayment is for paying off early, before the last scheduled payment)
const l1now = await entry(l1.loanId);
const full = note(await envoyer(fournisseur, { TransactionType: "LoanPay", Account: fournisseur.classicAddress, LoanID: l1.loanId, Amount: drops(l1now.TotalValueOutstanding), Flags: 0x20000 /* tfLoanFullPayment */ },
  `F-2026-001 LoanPay avec tfLoanFullPayment sur un prêt à une seule échéance`, "any"));
report.refusals.push({ what: "LoanPay tfLoanFullPayment on a one-payment loan", code: full.result, message: full.message });
const l1pay = note(await envoyer(fournisseur, { TransactionType: "LoanPay", Account: fournisseur.classicAddress, LoanID: l1.loanId, Amount: drops(l1now.PeriodicPayment),
  Memos: [memo("dareskro/remboursement", "facture F-2026-001 payée : le fournisseur solde le prêt"), memo("dareskro/facture-sha256", F["F-2026-001"])] }, `F-2026-001 LoanPay régulier ${dropsToXrp(drops(l1now.PeriodicPayment))} XRP (échéance unique, dû ${l1now.PeriodicPayment} drops)`, "any"));
report.refusals.push({ what: "LoanPay regular (the single scheduled payment) by borrower", code: l1pay.result, message: l1pay.message });
v = await entry(vaultId); b = await entry(brokerId);
let loan1;
try { loan1 = await entry(l1.loanId); } catch { loan1 = "deleted"; }
log(`après remboursement : coffre AssetsTotal ${xrp(v.AssetsTotal)} / disponible ${xrp(v.AssetsAvailable)} XRP ; courtier DebtTotal ${b.DebtTotal ?? 0} ; prêt 1 ${loan1 === "deleted" ? "supprimé" : `PaymentRemaining ${loan1.PaymentRemaining}, PrincipalOutstanding ${loan1.PrincipalOutstanding}`}`);
report.apres_remboursement1 = { vault: { AssetsTotal: v.AssetsTotal, AssetsAvailable: v.AssetsAvailable }, broker: { DebtTotal: b.DebtTotal }, loan1: loan1 === "deleted" ? "deleted" : { PaymentRemaining: loan1.PaymentRemaining, PrincipalOutstanding: loan1.PrincipalOutstanding, Flags: loan1.Flags } };

// ── 7. loan 3: nothing paid, default
const l3 = note(await preter({ id: "F-2026-003", principalXrp: 36, factureSha: F["F-2026-003"], intervalS: INTERVAL_S, graceS: GRACE_S }));
const due = l3.loan.NextPaymentDueDate; // ripple epoch seconds
const dueMs = (due + RIPPLE_EPOCH) * 1000;
log(`prêt 3 ${l3.loanId}, échéance ${new Date(dueMs).toISOString()} + grâce ${GRACE_S} s`);
const early = note(await envoyer(dareskro, { TransactionType: "LoanManage", Account: dareskro.classicAddress, LoanID: l3.loanId, Flags: 0x10000 /* tfLoanDefault */ }, "LoanManage défaut AVANT l'échéance", "any"));
report.refusals.push({ what: "LoanManage default before due", code: early.result, message: early.message });
const waitMs = dueMs + (GRACE_S + 12) * 1000 - Date.now();
if (waitMs > 0) { log(`attente de l'échéance + grâce (${Math.ceil(waitMs / 1000)} s)…`); await sleep(waitMs); }
const coverBefore = (await entry(brokerId)).CoverAvailable;
const def = note(await envoyer(dareskro, { TransactionType: "LoanManage", Account: dareskro.classicAddress, LoanID: l3.loanId, Flags: 0x10000,
  Memos: [memo("dareskro/defaut", "facture F-2026-003 : rien reçu à l'échéance + grâce")] }, "LoanManage tfLoanDefault après échéance + grâce", "any"));
report.refusals.push({ what: "LoanManage default after due+grace", code: def.result, message: def.message });
v = await entry(vaultId); b = await entry(brokerId);
let loan3;
try { loan3 = await entry(l3.loanId); } catch { loan3 = "deleted"; }
log(`après défaut : coffre AssetsTotal ${xrp(v.AssetsTotal)} / disponible ${xrp(v.AssetsAvailable)} XRP, LossUnrealized ${v.LossUnrealized ?? 0} ; courtier DebtTotal ${b.DebtTotal ?? 0}, couverture ${coverBefore} → ${b.CoverAvailable ?? 0}`);
report.apres_defaut = { vault: { AssetsTotal: v.AssetsTotal, AssetsAvailable: v.AssetsAvailable, LossUnrealized: v.LossUnrealized }, broker: { DebtTotal: b.DebtTotal, CoverAvailable: b.CoverAvailable, coverBefore }, loan3: loan3 === "deleted" ? "deleted" : { Flags: loan3.Flags, TotalValueOutstanding: loan3.TotalValueOutstanding } };

// ── 8. the redemption phase: the lenders take back what is left
const parts = {};
for (const [k, w] of [["A", preteurA], ["B", preteurB]]) {
  const r = await onLedger(() => c.request({ command: "account_objects", account: w.classicAddress, type: "mptoken" }));
  parts[k] = r.result.account_objects.find((o) => o.MPTokenIssuanceID === shareId)?.MPTAmount ?? "0";
  log(`prêteur ${k} : ${parts[k]} parts du coffre`);
}
report.parts = parts;
const tooSoon = note(await envoyer(preteurA, { TransactionType: "VaultWithdraw", Account: preteurA.classicAddress, VaultID: vaultId, Amount: { mpt_issuance_id: shareId, value: parts.A } }, "prêteur A tente un retrait pendant la phase d'investissement", "any"));
report.refusals.push({ what: "VaultWithdraw in investment phase", code: tooSoon.result });
await attendre(redemptionDate, "début de la phase de rachat");
report.retraits = {};
for (const [k, w] of [["A", preteurA], ["B", preteurB]]) {
  const avant = await solde(w.classicAddress);
  const r = note(await envoyer(w, { TransactionType: "VaultWithdraw", Account: w.classicAddress, VaultID: vaultId, Amount: { mpt_issuance_id: shareId, value: parts[k] } }, `prêteur ${k} retire ses ${parts[k]} parts (VaultWithdraw, phase de rachat)`, "any"));
  const apres = await solde(w.classicAddress);
  log(`prêteur ${k} : ${avant} → ${apres} XRP (avait déposé 80)`);
  report.retraits[k] = { code: r.result, avant, apres, hash: r.hash };
}
v = await entry(vaultId);
log(`coffre après rachats : AssetsTotal ${xrp(v.AssetsTotal)} XRP, LossUnrealized ${v.LossUnrealized ?? 0}`);
report.vault.final = { AssetsTotal: v.AssetsTotal, AssetsAvailable: v.AssetsAvailable, LossUnrealized: v.LossUnrealized };
log("qui détient quoi : les prêteurs détenaient des parts du coffre et reprennent l'actif au prorata, perte comprise ; le coffre est un pseudo-compte sans clé ; dareskro détient sa couverture et son rôle de courtier, jamais l'argent des prêteurs");
writeFileSync(path.join(HERE, "compte_rendu_devnet.json"), JSON.stringify(report, (k, val) => (k === "meta" ? undefined : val), 2) + "\n");
log(`compte rendu : ${path.join(HERE, "compte_rendu_devnet.json")}`);
await c.disconnect();
