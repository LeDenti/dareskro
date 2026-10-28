/**
 * Price list and split of a wedding-photo order. Pure functions, euro cents,
 * no model, no ledger: the agency, the photographers and the lab must be able
 * to recompute every payout to the cent from the order alone.
 *
 *   CATALOGUE   what the guest pays per photo: a file, or a print by size
 *   COUT_LABO   what the lab gets per print (its cost + margin), plus one
 *               postage per order that has prints — the lab pays the carrier
 *   PART        how the rest splits: the agency and the photographer who took
 *               the photo, half each, per photo
 *
 * Every line is rounded to the cent and then added (the payslip lesson: it
 * must add up on paper). The split is exact by construction: the agency takes
 * the rounding residue, never the photographer or the lab.
 */

export const CATALOGUE = {
  fichier: 800,            // the full-resolution file, 8.00 €
  "10x15": 250,
  "20x30": 900,
  "30x45": 1900,
};
export const COUT_LABO = { "10x15": 120, "20x30": 450, "30x45": 950 };   // print cost paid to the lab
export const PORT = 490;                                                 // postage per order with prints
export const DEGRESSIF = { aPartirDe: 10, fichier: 600 };                // 10 files or more: 6.00 € each
export const PART = { agence: 50, photographe: 50 };                     // percent of the margin, per photo

const tailles = Object.keys(COUT_LABO);

/** @param {{ photo: string, auteur: string, format: "fichier"|"10x15"|"20x30"|"30x45" }[]} lignes */
export function commande(lignes) {
  if (!Array.isArray(lignes) || lignes.length === 0) throw new Error("commande vide");
  const nbFichiers = lignes.filter((l) => l.format === "fichier").length;
  const prixFichier = nbFichiers >= DEGRESSIF.aPartirDe ? DEGRESSIF.fichier : CATALOGUE.fichier;
  const parts = { agence: 0, labo: 0 };            // photographers are keyed by name below
  const photographes = {};
  const detail = [];
  let total = 0;
  for (const l of lignes) {
    if (!l.photo || !l.auteur) throw new Error("chaque ligne a une photo et un auteur");
    if (!(l.format in CATALOGUE)) throw new Error(`format inconnu ${l.format}`);
    const prix = l.format === "fichier" ? prixFichier : CATALOGUE[l.format];
    const labo = l.format === "fichier" ? 0 : COUT_LABO[l.format];
    const marge = prix - labo;
    const photographe = Math.floor((marge * PART.photographe) / 100);   // rounded down: the residue goes to the agency
    const agence = marge - photographe;
    detail.push({ ...l, prix, labo, agence, photographe });
    total += prix;
    parts.agence += agence;
    parts.labo += labo;
    photographes[l.auteur] = (photographes[l.auteur] ?? 0) + photographe;
  }
  const port = tailles.some((t) => lignes.some((l) => l.format === t)) ? PORT : 0;
  total += port;
  parts.labo += port;
  const somme = parts.agence + parts.labo + Object.values(photographes).reduce((a, b) => a + b, 0);
  if (somme !== total) throw new Error(`la répartition (${somme}) ne fait pas le total (${total})`);
  return { total, port, nbFichiers, prixFichier, parts: { ...parts, photographes }, detail };
}

export const euros = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";

/** The payees of an order, flattened: one escrow each. */
export function beneficiaires(cmd) {
  const out = [{ role: "agence", nom: "agence", cents: cmd.parts.agence }];
  for (const [nom, cents] of Object.entries(cmd.parts.photographes)) if (cents > 0) out.push({ role: "photographe", nom, cents });
  if (cmd.parts.labo > 0) out.push({ role: "labo", nom: "labo", cents: cmd.parts.labo });
  return out;
}

// --- self-check: node tarif.mjs
if (process.argv[1] && process.argv[1].endsWith("tarif.mjs")) {
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log("ok ", what); };
  const f = (n, auteur = "Léa") => Array.from({ length: n }, (_, i) => ({ photo: `IMG_${i}`, auteur, format: "fichier" }));
  let c = commande(f(1));
  eq([c.total, c.port, c.parts.agence, c.parts.photographes["Léa"], c.parts.labo], [800, 0, 400, 400, 0], "1 fichier : 8 € = 4 + 4, pas de port");
  c = commande(f(10));
  eq([c.total, c.prixFichier], [6000, 600], "10 fichiers : dégressif 6 €");
  c = commande([{ photo: "a", auteur: "Marc", format: "20x30" }]);
  eq([c.total, c.port, c.parts.labo, c.parts.agence, c.parts.photographes["Marc"]], [1390, 490, 940, 225, 225], "1 tirage 20x30 : 9 + 4,90 port ; labo 4,50 + 4,90 ; marge 4,50 = 2,25 + 2,25");
  c = commande([{ photo: "a", auteur: "Marc", format: "10x15" }]);
  eq([c.parts.agence, c.parts.photographes["Marc"]], [65, 65], "10x15 : marge 1,30 = 0,65 + 0,65");
  c = commande([{ photo: "a", auteur: "Marc", format: "30x45" }]);
  eq([c.parts.agence, c.parts.photographes["Marc"]], [475, 475], "30x45 : marge 9,50 = 4,75 + 4,75");
  c = commande([...f(2, "Léa"), { photo: "x", auteur: "Marc", format: "fichier" }, { photo: "y", auteur: "Marc", format: "20x30" }, { photo: "z", auteur: "Marc", format: "20x30" }]);
  eq(c.total, 3 * 800 + 2 * 900 + 490, "la commande de la démo : 3 fichiers + 2 tirages 20x30 + port = 46,90 €");
  eq(beneficiaires(c).map((b) => [b.nom, b.cents]), [["agence", 1650], ["Léa", 800], ["Marc", 850], ["labo", 1390]], "quatre bénéficiaires, la somme fait le total");
  let threw = false; try { commande([{ photo: "a", auteur: "x", format: "A4" }]); } catch { threw = true; }
  eq(threw, true, "format inconnu : refusé");
  console.log("tarif.mjs : toutes les règles tiennent");
}
