/**
 * Ledger helpers shared by the testnet run, the service and the desk: the pool account, multisigning,
 * the invoice token, the repayment escrow, the AI's anchoring. Every function returns what the ledger
 * answered (result code, hash); nothing here decides anything.
 */
import { Client, Wallet, multisign, xrpToDrops, dropsToXrp, convertStringToHex, convertHexToString, isoTimeToRippleTime } from "xrpl";
import { sha256, canonique, metadonneesJeton } from "./facture.mjs";

export const TESTNET = process.env.XRPL_WSS || process.env.XRPL_TESTNET || "wss://testnet.xrpl-labs.com";
export const EXPLORER = process.env.XRPL_EXPLORER || "https://testnet.xrpl.org";
export const explorer = (h) => `${EXPLORER}/transactions/${h}`;
export const compteUrl = (a) => `${EXPLORER}/accounts/${a}`;
export const hex = (s) => convertStringToHex(s);
export const memo = (type, data) => ({ Memo: { MemoType: hex(type), MemoData: hex(data) } });
export const memoTexte = (memos, type) => { const m = (memos || []).map((x) => x.Memo).find((x) => convertHexToString(x.MemoType) === type); return m ? convertHexToString(m.MemoData) : undefined; };
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { Wallet, xrpToDrops, dropsToXrp, isoTimeToRippleTime };

export class Registre {
  constructor(url = TESTNET) { this.url = url; this.c = new Client(url); }
  async connect() { if (!this.c.isConnected()) await this.c.connect(); return this; }
  async disconnect() { try { await this.c.disconnect(); } catch { /* closed */ } }

  /** The testnet websocket drops now and then: reconnect and retry a few times. */
  async onLedger(fn, tries = 5) {
    for (let i = 0; ; i++) {
      try { if (!this.c.isConnected()) await this.c.connect(); return await fn(this.c); }
      catch (err) {
        if (i >= tries - 1) throw err;
        log(`ledger hiccup (${String(err?.message ?? err).split("\n")[0].slice(0, 80)}), retrying in 5 s…`);
        try { await this.c.disconnect(); } catch { /* already closed */ }
        await sleep(5000);
      }
    }
  }
  async faucet() { const { wallet } = await this.onLedger((c) => c.fundWallet()); return wallet; }
  async soldeXrp(addr) { try { return await this.onLedger((c) => c.getXrpBalance(addr)); } catch (e) { if (e?.data?.error === "actNotFound") return null; throw e; } }
  async infos(addr) { const r = await this.onLedger((c) => c.request({ command: "account_info", account: addr, ledger_index: "validated" })); return r.result.account_data; }
  async tx(hash) { const r = await this.onLedger((c) => c.request({ command: "tx", transaction: hash })); return r.result; }

  /** Single-signed; `expect` lets a negative case assert its refusal (tec… after validation, tef/tem at the door). */
  async envoyer(wallet, tx, label, expect = "tesSUCCESS") {
    const prepared = await this.onLedger((c) => c.autofill(tx));
    const { tx_blob } = wallet.sign(prepared);
    return this.#soumettre(tx_blob, label, expect, [wallet.classicAddress]);
  }
  /** Multisigned by the given signers (weight 1 each; the pool's quorum is 2). */
  async multisigner(tx, signers, label, expect = "tesSUCCESS") {
    const prepared = await this.onLedger((c) => c.autofill({ ...tx }, signers.length));
    const blob = multisign(signers.map((w) => w.sign(prepared, true).tx_blob));
    return this.#soumettre(blob, label, expect, signers.map((w) => w.classicAddress));
  }
  async #soumettre(blob, label, expect, signers) {
    if (expect.startsWith("tes") || expect.startsWith("tec")) {
      const r = await this.onLedger((c) => c.submitAndWait(blob));
      const code = r.result.meta.TransactionResult;
      log(`${label}: ${code}  ${explorer(r.result.hash)}`);
      const out = { label, result: code, hash: r.result.hash, ledger: r.result.ledger_index, close: r.result.close_time_iso, signers, explorer: explorer(r.result.hash), meta: r.result.meta, tx: r.result.tx_json ?? r.result };
      if (code !== expect) throw new Error(`${label} → ${code}, expected ${expect}`);
      return out;
    }
    // tef/tem results are refused at the door: never in a ledger, no fee burnt, nothing to wait for
    const r = await this.onLedger((c) => c.submit(blob));
    const code = r.result.engine_result;
    log(`${label}: ${code}  (${r.result.engine_result_message})`);
    const out = { label, result: code, message: r.result.engine_result_message, signers };
    if (code !== expect) throw new Error(`${label} → ${code}, expected ${expect}`);
    return out;
  }

  /**
   * The pool: a fresh account funded by `payeur`, handed to three signers (quorum 2), its own key disabled.
   * Returns the pool wallet (its seed is useless once the master key is disabled, kept only for the run's record).
   */
  async creerPool({ payeur, reserveXrp, signataires, memos = [] }) {
    const pool = Wallet.generate();
    const steps = [];
    steps.push(await this.envoyer(payeur, { TransactionType: "Payment", Account: payeur.classicAddress, Destination: pool.classicAddress, Amount: xrpToDrops(reserveXrp), Memos: memos }, `ouverture du compte du pool (réserve ${reserveXrp} XRP)`));
    steps.push(await this.envoyer(pool, { TransactionType: "SignerListSet", Account: pool.classicAddress, SignerQuorum: 2,
      SignerEntries: signataires.map((w) => ({ SignerEntry: { Account: w.classicAddress, SignerWeight: 1 } })),
      Memos: [memo("dareskro/pool", "avance sur facture : IA, politique de risque, opérateur — 2 signatures sur 3")] }, "SignerListSet 2-sur-3 (IA, politique de risque, opérateur)"));
    steps.push(await this.envoyer(pool, { TransactionType: "AccountSet", Account: pool.classicAddress, SetFlag: 4 /* asfDisableMaster */ }, "clé maîtresse du pool désactivée"));
    return { pool, steps };
  }

  /** The invoice as a token (XLS-33 MPT): one unit, transferable, metadata = id + fingerprint + amount + due date. Issued by the supplier. */
  async emettreJetonFacture(fournisseur, dossier) {
    const meta = metadonneesJeton(dossier);
    if (Buffer.byteLength(meta) > 1024) throw new Error("metadata > 1024 bytes");
    const r = await this.envoyer(fournisseur, { TransactionType: "MPTokenIssuanceCreate", Account: fournisseur.classicAddress, AssetScale: 0, MaximumAmount: "1",
      Flags: 0x20 /* tfMPTCanTransfer */, MPTokenMetadata: hex(meta), Memos: [memo("dareskro/facture-sha256", dossier.sha256), memo("dareskro/doc", `facture ${dossier.id}`)] },
      `${dossier.id} jeton de la facture émis par le fournisseur (MPTokenIssuanceCreate)`);
    const id = r.meta.mpt_issuance_id;
    if (!id) throw new Error("no mpt_issuance_id in meta");
    return { ...r, issuanceId: id, metadata: meta };
  }
  /** The pool accepts to hold that token (multisigned), then the supplier hands it over: the receivable is assigned to the pool. */
  async cederCreance({ pool, signers, fournisseur, issuanceId, dossier }) {
    const a = await this.multisigner({ TransactionType: "MPTokenAuthorize", Account: pool.classicAddress, MPTokenIssuanceID: issuanceId }, signers, `${dossier.id} le pool accepte le jeton (MPTokenAuthorize, 2/3)`);
    const p = await this.envoyer(fournisseur, { TransactionType: "Payment", Account: fournisseur.classicAddress, Destination: pool.classicAddress, Amount: { mpt_issuance_id: issuanceId, value: "1" },
      Memos: [memo("dareskro/cession", `créance ${dossier.id} cédée au pool`), memo("dareskro/facture-sha256", dossier.sha256)] }, `${dossier.id} créance cédée : 1 jeton fournisseur → pool`);
    return { authorize: a, cession: p };
  }
  /** Back to its issuer: the receivable is extinguished (paid, or bought back). */
  async eteindreCreance({ pool, signers, fournisseur, issuanceId, dossier, motif }) {
    return this.multisigner({ TransactionType: "Payment", Account: pool.classicAddress, Destination: fournisseur.classicAddress, Amount: { mpt_issuance_id: issuanceId, value: "1" },
      Memos: [memo("dareskro/creance-eteinte", `${dossier.id} : ${motif}`), memo("dareskro/facture-sha256", dossier.sha256)] }, signers, `${dossier.id} jeton rendu à l'émetteur : créance éteinte (${motif})`);
  }

  /**
   * The AI's analysis, anchored: an AccountSet from the AI's own account, no setting changed, memos = the analysis hash,
   * the dossier hash, a label. The analysis JSON stays off-chain (facture/sortie/analyses/); anyone holding it can rehash it.
   */
  async ancrerAnalyse(ia, analyse) {
    const h = sha256(canonique(analyse));
    const r = await this.envoyer(ia, { TransactionType: "AccountSet", Account: ia.classicAddress,
      Memos: [memo("dareskro/analyse-sha256", h), memo("dareskro/facture-sha256", analyse.facture_sha256), memo("dareskro/doc", `analyse IA ${analyse.facture_id} : ${analyse.recommandation}`)] },
      `${analyse.facture_id} analyse de l'IA ancrée (AccountSet, mémo sha256 ${h.slice(0, 12)}…)`);
    return { ...r, analyse_sha256: h };
  }

  /** The advance itself: an ordinary Payment from the pool, multisigned. */
  async avancer({ pool, signers, dossier, analyseSha256, expect }) {
    return this.multisigner({ TransactionType: "Payment", Account: pool.classicAddress, Destination: dossier.fournisseur.adresse, Amount: xrpToDrops(dossier.avance.montant),
      Memos: [memo("dareskro/case", "avance-facture"), memo("dareskro/facture-sha256", dossier.sha256), ...(analyseSha256 ? [memo("dareskro/analyse-sha256", analyseSha256)] : []), memo("dareskro/echeance", dossier.echeance)] },
      signers, `${dossier.id} avance ${dossier.avance.montant} XRP pool → fournisseur, signée ${signers.length}/3`, expect);
  }

  /** The debtor locks the repayment in XRP: EscrowCreate to the pool, FinishAfter = due date, CancelAfter = due + grace. Only possible in XRP (no euro token is escrowable). */
  async verrouillerRemboursement({ debiteur, pool, dossier, graceS }) {
    const finishAfter = isoTimeToRippleTime(dossier.echeance);
    return { ...(await this.envoyer(debiteur, { TransactionType: "EscrowCreate", Account: debiteur.classicAddress, Destination: pool.classicAddress, Amount: xrpToDrops(dossier.montant),
      FinishAfter: finishAfter, CancelAfter: finishAfter + graceS,
      Memos: [memo("dareskro/remboursement", `facture ${dossier.id}, due le ${dossier.echeance}`), memo("dareskro/facture-sha256", dossier.sha256)] },
      `${dossier.id} remboursement verrouillé par le client : escrow ${dossier.montant} XRP → pool, libérable à l'échéance`)), finishAfter };
  }
  async encaisser({ qui, owner, sequence, dossier, expect = "tesSUCCESS" }) {
    return this.envoyer(qui, { TransactionType: "EscrowFinish", Account: qui.classicAddress, Owner: owner, OfferSequence: sequence,
      Memos: [memo("dareskro/encaissement", `facture ${dossier.id}`), memo("dareskro/facture-sha256", dossier.sha256)] },
      `${dossier.id} EscrowFinish par l'opérateur (${expect === "tesSUCCESS" ? "à l'échéance" : "avant l'échéance"})`, expect);
  }
  /** The default, written: a multisigned AccountSet from the pool, no setting changed, the fact in memos. */
  async constaterDefaut({ pool, signers, dossier, texte }) {
    return this.multisigner({ TransactionType: "AccountSet", Account: pool.classicAddress, Memos: [memo("dareskro/defaut", texte), memo("dareskro/facture-sha256", dossier.sha256)] },
      signers, `${dossier.id} défaut constaté par le pool (AccountSet 2/3, mémo)`);
  }
}
