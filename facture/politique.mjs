#!/usr/bin/env node
/**
 * The risk policy — the second signer of the pool, and the only one that never "thinks".
 *
 * Deterministic code, no network, no model: given the dossier, the pool's state (capital, what each
 * debtor already owes) and the limits, it answers yes or no with the reasons, and the same inputs
 * always give the same answer. In the pool's 2-of-3 signer list it holds its own key; it signs an
 * advance only when `evaluer` says ok. It is distinct from the AI on purpose: the AI gathers evidence
 * and proposes (its analysis is hashed and anchored), the policy caps, the human decides what neither
 * of them may. A refusal here is a refusal by a SIGNER: the ledger knows nothing of these limits
 * (measured: with two other signatures the same payment goes through — see README).
 *
 * Limits (defaults in LIMITES; a real pool writes its own in a file and publishes their hash):
 *   partDebiteurMax     share of the pool's capital one debtor may owe, new advance included (concentration cap)
 *   plafondDebiteur     absolute cap per debtor, in the pool's unit
 *   tauxAvanceMax       advance / invoice amount
 *   echeanceMaxJours    an invoice due further away is refused
 *   montantMin          below it the fees are not worth a transaction
 *   exigerAnalyse       the AI's analysis must exist, name the same dossier hash and be anchored on the ledger
 *
 * `node politique.mjs` runs the self-checks.
 */
import { empreinte } from "./facture.mjs";

export const LIMITES = Object.freeze({
  partDebiteurMax: 0.30,
  plafondDebiteur: "100",
  tauxAvanceMax: 0.90,
  echeanceMaxJours: 90,
  montantMin: "1",
  exigerAnalyse: true,
});

/**
 * @param {object} dossier  the sealed dossier (facture.mjs)
 * @param {{ capital: string|number, encours: Record<string, string|number>, maintenant?: string }} etat
 *        capital = what the pool was funded with; encours = per debtor address, what is advanced and not yet repaid
 * @param {{ sha256?: string, facture_sha256?: string, ancrage?: string } | undefined} analyse  the AI's memo (its own hash, the dossier hash it names, the anchoring tx)
 * @param {typeof LIMITES} limites
 * @returns {{ ok: boolean, raisons: string[], calcul: object }}
 */
export function evaluer(dossier, etat, analyse, limites = LIMITES) {
  const raisons = [];
  const now = etat.maintenant ? new Date(etat.maintenant) : new Date();
  const montant = Number(dossier.montant);
  const avance = Number(dossier.avance?.montant ?? 0);
  const capital = Number(etat.capital);
  const dejaDu = Number(etat.encours?.[dossier.client?.adresse] ?? 0);
  const apres = dejaDu + avance;
  const partApres = capital > 0 ? apres / capital : Infinity;
  const jours = (new Date(dossier.echeance) - now) / 86400000;

  const v = (() => { const h = empreinte(dossier); return h === dossier.sha256 ? null : `dossier altéré : empreinte ${h.slice(0, 12)}… ≠ ${String(dossier.sha256).slice(0, 12)}…`; })();
  if (v) raisons.push(v);
  if (!(montant > 0)) raisons.push("montant nul");
  if (montant < Number(limites.montantMin)) raisons.push(`montant ${montant} < minimum ${limites.montantMin}`);
  if (!(avance > 0)) raisons.push("avance nulle");
  if (avance > montant * limites.tauxAvanceMax + 1e-9) raisons.push(`avance ${avance} > ${limites.tauxAvanceMax * 100} % de la facture (${montant})`);
  if (!(jours > 0)) raisons.push(`échéance ${dossier.echeance} déjà passée`);
  if (jours > limites.echeanceMaxJours) raisons.push(`échéance à ${Math.ceil(jours)} j > ${limites.echeanceMaxJours} j`);
  if (apres > Number(limites.plafondDebiteur) + 1e-9) raisons.push(`plafond par débiteur : ${dejaDu} déjà dû + ${avance} = ${apres} > ${limites.plafondDebiteur}`);
  if (partApres > limites.partDebiteurMax + 1e-9) raisons.push(`plafond de concentration : ce débiteur aurait ${(partApres * 100).toFixed(1)} % du capital (${apres} / ${capital}) > ${limites.partDebiteurMax * 100} %`);
  if (limites.exigerAnalyse) {
    if (!analyse) raisons.push("aucune analyse de l'IA");
    else {
      if (analyse.facture_sha256 !== dossier.sha256) raisons.push("l'analyse de l'IA ne porte pas sur ce dossier");
      if (!analyse.ancrage) raisons.push("l'analyse de l'IA n'est pas ancrée sur le registre");
    }
  }
  return {
    ok: raisons.length === 0,
    raisons,
    calcul: { montant, avance, capital, dejaDu, apres, partApres: Number(partApres.toFixed(4)), joursAvantEcheance: Number(jours.toFixed(2)), limites },
  };
}

// ───────────── self-checks ─────────────
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { dossierFacture } = await import("./facture.mjs");
  const base = { fournisseur: { nom: "F", adresse: "rF" }, client: { nom: "C", adresse: "rC" }, emission: "2026-11-01", echeance: "2026-12-01",
    pieces: [{ nom: "facture.pdf", sha256: "a".repeat(64) }], pool: "rPool" };
  const analyseOk = (d) => ({ sha256: "b".repeat(64), facture_sha256: d.sha256, ancrage: "C".repeat(64) });
  const etat = { capital: "160", encours: {}, maintenant: "2026-11-01T00:00:00Z" };
  let n = 0;
  const check = (nom, cond) => { n++; if (!cond) { console.error(`ÉCHEC ${n}: ${nom}`); process.exit(1); } console.log(`ok ${n}: ${nom}`); };

  const d1 = dossierFacture({ ...base, id: "F1", montant: "50" });
  check("50 sur un pool de 160, encours 0 : accepté", evaluer(d1, etat, analyseOk(d1)).ok);
  check("avance = 90 %, frais 2 %, solde 4", d1.avance.montant === "45" && d1.frais.montant === "1" && d1.solde_fournisseur === "4");
  const d2 = dossierFacture({ ...base, id: "F2", montant: "10" });
  const r2 = evaluer(d2, { ...etat, encours: { rC: "45" } }, analyseOk(d2));
  check("45 déjà dû + 9 = 54 > 30 % de 160 : refusé pour concentration", !r2.ok && r2.raisons.some((x) => x.startsWith("plafond de concentration")));
  check("et pour rien d'autre", r2.raisons.length === 1);
  const r2b = evaluer(d2, { ...etat, encours: { rAutre: "45" } }, analyseOk(d2));
  check("le même encours chez un autre débiteur ne compte pas", r2b.ok);
  const d3 = dossierFacture({ ...base, id: "F3", montant: "200" });
  const r3 = evaluer(d3, { ...etat, capital: "1000" }, analyseOk(d3));
  check("180 d'avance > plafond absolu 100 : refusé", !r3.ok && r3.raisons.some((x) => x.startsWith("plafond par débiteur")));
  const d4 = dossierFacture({ ...base, id: "F4", montant: "50", tauxAvance: 0.95 });
  check("avance à 95 % : refusée", evaluer(d4, etat, analyseOk(d4)).raisons.some((x) => x.includes("90 %")));
  const d5 = dossierFacture({ ...base, id: "F5", montant: "50", echeance: "2027-03-01" });
  check("échéance à 120 j : refusée", evaluer(d5, etat, analyseOk(d5)).raisons.some((x) => x.includes("> 90 j")));
  check("échéance passée : refusée", evaluer(d1, { ...etat, maintenant: "2026-12-02T00:00:00Z" }, analyseOk(d1)).raisons.some((x) => x.includes("déjà passée")));
  check("sans analyse de l'IA : refusé", evaluer(d1, etat, undefined).raisons.includes("aucune analyse de l'IA"));
  check("analyse d'un autre dossier : refusée", evaluer(d1, etat, analyseOk(d2)).raisons.some((x) => x.includes("ne porte pas")));
  check("analyse non ancrée : refusée", evaluer(d1, etat, { ...analyseOk(d1), ancrage: undefined }).raisons.some((x) => x.includes("pas ancrée")));
  const altere = { ...d1, montant: "500" };
  check("dossier altéré après scellement : refusé", evaluer(altere, etat, analyseOk(d1)).raisons.some((x) => x.startsWith("dossier altéré")));
  check("déterminisme : deux appels, même réponse", JSON.stringify(evaluer(d2, { ...etat, encours: { rC: "45" } }, analyseOk(d2))) === JSON.stringify(r2));
  console.log(`\n${n} auto-vérifications passées — la politique de risque est du code, pas un avis.`);
}
