/**
 * Rules of the French residential lease that touch the security deposit
 * (loi n° 89-462 du 6 juillet 1989, art. 22). Pure functions, no ledger, no
 * model: a deposit dispute is argued years later and must replay to the cent.
 *
 *   plafondDepot        how much may be asked: 1 month of rent (excluding
 *                       charges) unfurnished, 2 months furnished, nothing in a
 *                       "bail mobilité"
 *   echeanceRestitution when it must be given back: 1 month after the keys are
 *                       handed over if the exit inventory matches the entry one,
 *                       2 months otherwise
 *   majorationRetard    what a late landlord owes on top: 10 % of the monthly
 *                       rent per month started, of right, no formal notice
 *                       (Cass. 3e civ., 12 février 2026, n° 24-21.258)
 *   verifieRetenue      a deduction must be a sum actually owed, justified by a
 *                       document (its SHA-256 goes on the ledger), never above
 *                       the deposit; in a co-owned building the landlord may hold
 *                       up to 20 % until the yearly accounts are closed
 *
 * Amounts are in euro cents (integers): no floating point in a legal sum.
 * Dates are ISO "YYYY-MM-DD" strings, computed in UTC, month to month the
 * way a French "délai de mois" runs (same day of the next month, clamped to the
 * month's last day).
 */

const DIX_POUR_CENT = 10n;

/** @param {string} iso */
function parse(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`date attendue au format YYYY-MM-DD, reçu ${iso}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
const iso = (d) => d.toISOString().slice(0, 10);

/** Same day of the month, n months later; 31 janvier + 1 mois = 28/29 février. */
export function ajouteMois(dateIso, n) {
  const d = parse(dateIso);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return iso(target);
}

/**
 * @param {{ loyerHorsChargesCents: number, meuble: boolean, mobilite?: boolean }} bail
 * @returns {number} the highest deposit the landlord may ask, in cents
 */
export function plafondDepot({ loyerHorsChargesCents, meuble, mobilite = false }) {
  if (!Number.isInteger(loyerHorsChargesCents) || loyerHorsChargesCents <= 0) throw new Error("loyer hors charges en centimes entiers > 0");
  if (mobilite) return 0;                       // art. 25-13: no deposit in a bail mobilité
  return meuble ? 2 * loyerHorsChargesCents : loyerHorsChargesCents;
}

/**
 * @param {{ remiseClesIso: string, conforme: boolean }} sortie
 * @returns {{ echeanceIso: string, delaiMois: 1|2 }}
 */
export function echeanceRestitution({ remiseClesIso, conforme }) {
  const delaiMois = conforme ? 1 : 2;
  return { echeanceIso: ajouteMois(remiseClesIso, delaiMois), delaiMois };
}

/**
 * Months started past the deadline, and the penalty: 10 % of the monthly rent
 * (excluding charges) per month started. Returned 0 when on time.
 * @returns {{ moisCommences: number, majorationCents: number }}
 */
export function majorationRetard({ loyerHorsChargesCents, echeanceIso, restitutionIso }) {
  if (parse(restitutionIso) <= parse(echeanceIso)) return { moisCommences: 0, majorationCents: 0 };
  let n = 0;
  while (parse(ajouteMois(echeanceIso, n)) < parse(restitutionIso)) n++;
  const majorationCents = Number((BigInt(loyerHorsChargesCents) * DIX_POUR_CENT * BigInt(n)) / 100n);
  return { moisCommences: n, majorationCents };
}

/**
 * @param {{ montantCents: number, motif: string, justificatifSha256: string }} retenue
 * @param {{ depotCents: number, copropriete?: boolean, comptesArretes?: boolean }} ctx
 * @returns {{ ok: true } | { ok: false, raison: string }}
 */
export function verifieRetenue(retenue, { depotCents, copropriete = false, comptesArretes = true }) {
  const { montantCents, motif, justificatifSha256 } = retenue;
  if (!Number.isInteger(montantCents) || montantCents <= 0) return { ok: false, raison: "montant en centimes entiers > 0" };
  if (montantCents > depotCents) return { ok: false, raison: "une retenue ne peut dépasser le dépôt" };
  if (!motif || motif.trim().length < 3) return { ok: false, raison: "motif requis" };
  if (!/^[0-9a-f]{64}$/i.test(justificatifSha256 || "")) return { ok: false, raison: "justificatif requis : SHA-256 (64 hex) de la pièce (devis, facture, constat)" };
  if (copropriete && !comptesArretes && montantCents > Math.floor(depotCents * 0.2)) {
    return { ok: false, raison: "en copropriété, avant l'arrêté des comptes, la provision est plafonnée à 20 % du dépôt" };
  }
  return { ok: true };
}

/** Full picture of a restitution, ready to print or to put in a memo. */
export function decompte({ depotCents, loyerHorsChargesCents, remiseClesIso, conforme, restitutionIso, retenues = [] }) {
  const { echeanceIso, delaiMois } = echeanceRestitution({ remiseClesIso, conforme });
  const retenuCents = retenues.reduce((s, r) => s + r.montantCents, 0);
  if (retenuCents > depotCents) throw new Error("les retenues dépassent le dépôt");
  const { moisCommences, majorationCents } = majorationRetard({ loyerHorsChargesCents, echeanceIso, restitutionIso });
  return {
    depotCents, echeanceIso, delaiMois, restitutionIso,
    retenuCents, auLocataireCents: depotCents - retenuCents + majorationCents, auBailleurCents: retenuCents,
    moisCommences, majorationCents,
  };
}

export const euros = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";

// --- self-check: node bail.mjs
if (process.argv[1] && process.argv[1].endsWith("bail.mjs")) {
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log("ok ", what); };
  eq(plafondDepot({ loyerHorsChargesCents: 120000, meuble: false }), 120000, "plafond vide = 1 mois");
  eq(plafondDepot({ loyerHorsChargesCents: 120000, meuble: true }), 240000, "plafond meublé = 2 mois");
  eq(plafondDepot({ loyerHorsChargesCents: 120000, meuble: true, mobilite: true }), 0, "bail mobilité = 0");
  eq(ajouteMois("2026-01-31", 1), "2026-02-28", "31 janvier + 1 mois = 28 février");
  eq(ajouteMois("2024-01-31", 1), "2024-02-29", "année bissextile");
  eq(echeanceRestitution({ remiseClesIso: "2026-10-27", conforme: true }), { echeanceIso: "2026-11-27", delaiMois: 1 }, "conforme → 1 mois");
  eq(echeanceRestitution({ remiseClesIso: "2026-10-27", conforme: false }), { echeanceIso: "2026-12-27", delaiMois: 2 }, "non conforme → 2 mois");
  eq(majorationRetard({ loyerHorsChargesCents: 120000, echeanceIso: "2026-11-27", restitutionIso: "2026-11-27" }), { moisCommences: 0, majorationCents: 0 }, "à l'heure : 0");
  eq(majorationRetard({ loyerHorsChargesCents: 120000, echeanceIso: "2026-11-27", restitutionIso: "2026-11-28" }), { moisCommences: 1, majorationCents: 12000 }, "1 jour de retard = 1 mois commencé = 10 %");
  eq(majorationRetard({ loyerHorsChargesCents: 120000, echeanceIso: "2026-11-27", restitutionIso: "2027-01-10" }), { moisCommences: 2, majorationCents: 24000 }, "44 jours = 2 mois commencés = 20 %");
  eq(verifieRetenue({ montantCents: 18000, motif: "trou mur salon", justificatifSha256: "a".repeat(64) }, { depotCents: 120000 }), { ok: true }, "retenue justifiée");
  eq(verifieRetenue({ montantCents: 18000, motif: "trou mur salon", justificatifSha256: "" }, { depotCents: 120000 }).ok, false, "sans pièce : refusée");
  eq(verifieRetenue({ montantCents: 50000, motif: "charges", justificatifSha256: "b".repeat(64) }, { depotCents: 120000, copropriete: true, comptesArretes: false }).ok, false, "copro > 20 % avant arrêté : refusée");
  const d = decompte({ depotCents: 120000, loyerHorsChargesCents: 120000, remiseClesIso: "2026-10-27", conforme: false, restitutionIso: "2026-12-27", retenues: [{ montantCents: 18000 }] });
  eq([d.auLocataireCents, d.auBailleurCents, d.majorationCents], [102000, 18000, 0], "décompte 1 200 − 180");
  console.log("bail.mjs : toutes les règles tiennent");
}
