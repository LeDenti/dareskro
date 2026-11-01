/**
 * The proposer — "the AI" seat of the pool's signer list.
 *
 * Its job: gather the evidence about an invoice, write an analysis memo, hash it, anchor the hash on the
 * ledger BEFORE anyone signs, and only then sign the advance it recommends. The memo is the thing a
 * lender, an auditor or a judge reads later; its hash in a validated ledger dates it and freezes it.
 *
 * What is measured here and what is a stand-in. The evidence it gathers is real and read from the
 * ledger: the supplier's and the debtor's account age (the ledger of their first transaction), their
 * transaction count, their balance, and whether the debtor already repaid this pool before (memos
 * `dareskro/remboursement` / `dareskro/encaissement` in its history). The dossier's documents are
 * checked by hash against the files given. The *wording* of the analysis is produced by this script,
 * deterministically, from those facts: no language model is called in this prototype. In production the
 * same seat is held by a model that reads the PDF, the client's accounts, the e-mails, and writes the
 * memo; what does not change is the contract: evidence listed with its source, a recommendation, a
 * hash anchored before the signature, and no power to pay alone (the policy and the human are the two
 * other signers).
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonique, sha256 } from "./facture.mjs";
import { memoTexte } from "./registre.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOSSIER_ANALYSES = path.join(HERE, "sortie", "analyses");

/** What the ledger says about an address: age, activity, balance, past repayments to this pool. */
export async function preuvesCompte(registre, addr, pool) {
  const out = { adresse: addr, source: `account_info + account_tx sur ${registre.url}` };
  try {
    const info = await registre.infos(addr);
    out.solde_xrp = Number(info.Balance) / 1e6;
    out.sequence = info.Sequence;
    const r = await registre.onLedger((c) => c.request({ command: "account_tx", account: addr, limit: 200, forward: true }));
    const txs = r.result.transactions;
    out.transactions = txs.length;
    out.premier_registre = txs[0]?.ledger_index ?? null;
    out.premiere_date = txs[0]?.close_time_iso ?? null;
    out.remboursements_a_ce_pool = txs.filter((t) => {
      const j = t.tx_json ?? t.tx ?? {};
      return (j.TransactionType === "EscrowCreate" || j.TransactionType === "Payment") && j.Destination === pool && j.Memos && memoTexte(j.Memos, "dareskro/remboursement");
    }).length;
  } catch (e) {
    out.erreur = e?.data?.error ?? e.message;
  }
  return out;
}

/**
 * Build the analysis memo. `pieces` = [{ nom, chemin }] the files behind the dossier (checked by hash).
 * `encours` = what the debtor already owes the pool. Returns the memo (not yet anchored).
 */
export async function analyser({ registre, dossier, pieces = [], pool, encours = {}, capital }) {
  const verifPieces = dossier.pieces.map((p) => {
    const f = pieces.find((x) => x.nom === p.nom);
    if (!f || !existsSync(f.chemin)) return { nom: p.nom, sha256: p.sha256, fichier: "absent", conforme: false };
    const h = sha256(readFileSync(f.chemin));
    return { nom: p.nom, sha256: p.sha256, fichier: path.basename(f.chemin), conforme: h === p.sha256 };
  });
  const fournisseur = await preuvesCompte(registre, dossier.fournisseur.adresse, pool);
  const client = await preuvesCompte(registre, dossier.client.adresse, pool);
  const dejaDu = Number(encours[dossier.client.adresse] ?? 0);
  const faits = [];
  faits.push(`facture ${dossier.id} : ${dossier.montant} ${dossier.unite}, émise le ${dossier.emission}, due le ${dossier.echeance}`);
  faits.push(`avance demandée ${dossier.avance.montant} (${dossier.avance.taux * 100} %), frais ${dossier.frais.montant}, solde au fournisseur après encaissement ${dossier.solde_fournisseur}`);
  faits.push(verifPieces.every((p) => p.conforme) ? `${verifPieces.length} pièce(s) conforme(s) à leur empreinte` : `pièces NON conformes : ${verifPieces.filter((p) => !p.conforme).map((p) => p.nom).join(", ")}`);
  faits.push(client.erreur ? `client ${client.adresse} : compte introuvable (${client.erreur})` : `client ${client.adresse} : ${client.transactions} transaction(s) depuis ${client.premiere_date ?? "?"}, solde ${client.solde_xrp} XRP, ${client.remboursements_a_ce_pool} remboursement(s) antérieur(s) à ce pool`);
  faits.push(fournisseur.erreur ? `fournisseur ${fournisseur.adresse} : compte introuvable` : `fournisseur ${fournisseur.adresse} : ${fournisseur.transactions} transaction(s), solde ${fournisseur.solde_xrp} XRP`);
  faits.push(`encours actuel de ce client auprès du pool : ${dejaDu} ${dossier.unite} sur un capital de ${capital}`);
  const reserves = [];
  if (!verifPieces.every((p) => p.conforme)) reserves.push("pièces non conformes");
  if (client.erreur) reserves.push("client sans compte sur le registre");
  if (!client.erreur && client.solde_xrp < Number(dossier.montant)) reserves.push(`le solde du client (${client.solde_xrp}) est sous le montant de la facture : paiement à l'échéance non couvert aujourd'hui`);
  if (!client.erreur && client.remboursements_a_ce_pool === 0) reserves.push("premier dossier de ce client : aucun historique de remboursement");
  const recommandation = reserves.some((r) => r.startsWith("pièces") || r.startsWith("client sans")) ? "refuser" : "avancer";
  const memo = {
    version: "dareskro/analyse/1",
    role: "proposeur (siège IA du pool) — stand-in déterministe, aucun modèle de langage appelé dans ce prototype",
    facture_id: dossier.id,
    facture_sha256: dossier.sha256,
    pool,
    date: new Date().toISOString(),
    preuves: { pieces: verifPieces, fournisseur, client },
    faits,
    reserves,
    recommandation,
    proposition: recommandation === "avancer" ? { avance: dossier.avance.montant, unite: dossier.unite, a: dossier.fournisseur.adresse, echeance: dossier.echeance } : null,
    note: "La politique de risque (politique.mjs) et l'opérateur humain sont les deux autres signataires : cette analyse ne paie rien seule.",
  };
  return { ...memo, sha256: sha256(canonique(memo)) };
}

/** Write the memo where the pool keeps them (public, no name in it beyond what the dossier carries). */
export function conserverAnalyse(analyse) {
  mkdirSync(DOSSIER_ANALYSES, { recursive: true });
  const f = path.join(DOSSIER_ANALYSES, `${analyse.facture_id}.json`);
  writeFileSync(f, JSON.stringify(analyse, null, 2) + "\n");
  return f;
}
