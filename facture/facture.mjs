/**
 * The invoice file (dossier de facture) and its fingerprint.
 *
 * A dossier is plain JSON: supplier, final client (the debtor), amount, issue and due dates,
 * the documents behind it (name + SHA-256 of each file), the advance asked. It is canonicalised
 * (sorted keys, no spaces, UTF-8 — the same bytes as Python's json.dumps(sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False), as agent/bulletin_garde.py and paie/ancrer.mjs do)
 * and hashed with SHA-256. That hash is what goes on the ledger: in the invoice token's metadata,
 * in the memos of every payment about this invoice, in the AI's anchored analysis. The dossier
 * itself (names, documents) never does.
 *
 * Amounts are strings in the pool's unit (XRP on testnet, standing in for euros: no euro token on
 * XRPL can be escrowed, measured 08/09 and 27/10/2026 — see README).
 */
import { createHash } from "node:crypto";

export const VERSION = "dareskro/facture/1";

/** JSON.stringify with sorted keys and no spaces. */
export function canonique(v) {
  return JSON.stringify(trier(v));
}
function trier(v) {
  if (Array.isArray(v)) return v.map(trier);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, trier(v[k])]));
  return v;
}
export const sha256 = (s) => createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");

/** The dossier's fingerprint: SHA-256 of its canonical JSON, without any `sha256` field it may already carry. */
export function empreinte(dossier) {
  const { sha256: _ignored, ...sans } = dossier;
  return sha256(canonique(sans));
}

/**
 * Build a dossier from its parts and seal it with its fingerprint.
 * @param {{ id: string, fournisseur: {nom: string, adresse: string}, client: {nom: string, adresse: string},
 *           montant: string, unite?: string, emission: string, echeance: string,
 *           pieces: Array<{nom: string, sha256: string}>, tauxAvance: number, fraisPct: number, pool: string }} p
 */
export function dossierFacture(p) {
  for (const k of ["id", "fournisseur", "client", "montant", "emission", "echeance", "pieces", "pool"]) {
    if (p[k] === undefined || p[k] === null || p[k] === "") throw new Error(`dossier: champ manquant ${k}`);
  }
  if (!/^\d+(\.\d+)?$/.test(String(p.montant)) || Number(p.montant) <= 0) throw new Error(`dossier: montant invalide ${p.montant}`);
  if (!(new Date(p.echeance) > new Date(p.emission))) throw new Error("dossier: l'échéance doit suivre l'émission");
  for (const piece of p.pieces) if (!/^[0-9a-f]{64}$/.test(piece.sha256)) throw new Error(`dossier: pièce ${piece.nom} sans SHA-256 valide`);
  const tauxAvance = p.tauxAvance ?? 0.9;
  const fraisPct = p.fraisPct ?? 2;
  const montant = Number(p.montant);
  const avance = arrondi(montant * tauxAvance);
  const frais = arrondi(montant * fraisPct / 100);
  const d = {
    version: VERSION,
    id: p.id,
    fournisseur: { nom: p.fournisseur.nom, adresse: p.fournisseur.adresse },
    client: { nom: p.client.nom, adresse: p.client.adresse },
    montant: String(p.montant),
    unite: p.unite ?? "XRP",
    emission: p.emission,
    echeance: p.echeance,
    pieces: p.pieces.map((x) => ({ nom: x.nom, sha256: x.sha256 })),
    avance: { taux: tauxAvance, montant: String(avance) },
    frais: { pct: fraisPct, montant: String(frais) },
    solde_fournisseur: String(arrondi(montant - avance - frais)),
    pool: p.pool,
  };
  return { ...d, sha256: empreinte(d) };
}

/** Six decimals: the XRP drop. */
export function arrondi(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** What goes in the invoice token's metadata (≤ 1024 bytes on the ledger): the id, the fingerprint, the amount, the due date. Never a name. */
export function metadonneesJeton(dossier) {
  return canonique({ t: "dareskro/facture", id: dossier.id, sha256: dossier.sha256, montant: dossier.montant, unite: dossier.unite, echeance: dossier.echeance });
}

/** Re-check a dossier against its own fingerprint. */
export function verifierDossier(dossier) {
  const h = empreinte(dossier);
  return { ok: h === dossier.sha256, calcule: h, declare: dossier.sha256 };
}
