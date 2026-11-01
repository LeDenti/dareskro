#!/usr/bin/env node
/** Prints the README's measurement tables (markdown) from the run reports, so no hash is ever retyped by hand.
 *  node tableaux.mjs testnet | ecran | devnet */
import { readFileSync, existsSync } from "node:fs";
const which = process.argv[2] ?? "testnet";
const T = "https://testnet.xrpl.org/transactions/", D = "https://devnet.xrpl.org/transactions/";
const lnk = (h, base = T) => (h ? `[${h.slice(0, 8)}…](${base}${h})` : "—");
const utc = (c) => (c ? c.slice(11, 19) : "");
if (which === "testnet") {
  const r = JSON.parse(readFileSync("compte_rendu.json", "utf8"));
  console.log("| Heure UTC | Étape | Résultat | Preuve |\n|---|---|---|---|");
  for (const s of r.steps) console.log(`| ${utc(s.close)} | ${s.label.replace(/\|/g, "/")} | \`${s.result}\` | ${s.hash ? lnk(s.hash) : `*refusé à la porte : ${s.message ?? "pas de registre, pas de frais"}*`} |`);
} else if (which === "ecran") {
  const e = JSON.parse(readFileSync("etat.json", "utf8"));
  const rows = [];
  for (const s of [...e.pool.creation, ...e.pool.apports]) rows.push([s.close, s.label, s.result, s.hash]);
  for (const f of e.factures) {
    rows.push([f.jeton.close, `${f.id} : jeton de la facture (MPTokenIssuanceCreate) ${f.jeton.issuanceId}`, f.jeton.result, f.jeton.hash]);
    if (f.analyse) rows.push([null, `${f.id} : analyse de l'IA ancrée (sha256 ${f.analyse.sha256.slice(0, 12)}…), recommande « ${f.analyse.recommandation} »`, "tesSUCCESS", f.analyse.ancrage]);
    if (f.politique) rows.push([f.politique.date, `${f.id} : politique de risque — ${f.politique.ok ? "ACCEPTE" : "REFUSE : " + f.politique.raisons.join(" ; ")}`, f.politique.ok ? "signe" : "ne signe pas", null]);
    for (const t of f.tentatives ?? []) rows.push([t.close, t.signataires ? `${f.id} : tentative d'avance signée ${t.signataires.join(" + ")} seulement` : `${f.id} : EscrowFinish avant l'échéance`, t.result, t.hash]);
    for (const [k, lab] of [["authorize", "le pool accepte le jeton (2/3)"], ["cession", "créance cédée (1 jeton fournisseur → pool)"], ["avance", "AVANCE"], ["escrow", "le client verrouille le remboursement (EscrowCreate)"], ["encaissement", "encaissement"], ["solde", "solde au fournisseur"], ["eteinte", "jeton rendu : créance éteinte"], ["defaut", "défaut constaté"], ["rachat", "rachat par le fournisseur"]])
      if (f[k]) rows.push([f[k].close, `${f.id} : ${lab}${k === "avance" ? ` ${f.dossier.avance.montant} XRP, signée ${f.avance.signataires.join(" + ")}${f.avance.horsPolitique ? " — PASSAGE OUTRE la politique" : ""}` : ""}`, f[k].result, f[k].hash]);
  }
  console.log("| Heure UTC | Étape | Résultat | Preuve |\n|---|---|---|---|");
  for (const [c, l, r, h] of rows) console.log(`| ${utc(c ?? "")} | ${l} | \`${r}\` | ${h ? lnk(h) : "*aucune transaction*"} |`);
} else if (which === "devnet") {
  if (!existsSync("compte_rendu_devnet.json")) { console.log("(pas encore de compte_rendu_devnet.json)"); process.exit(0); }
  const r = JSON.parse(readFileSync("compte_rendu_devnet.json", "utf8"));
  console.log("| Heure UTC | Étape | Résultat | Preuve |\n|---|---|---|---|");
  for (const s of r.steps) console.log(`| ${utc(s.close)} | ${s.label.replace(/\|/g, "/")} | \`${s.result}\` | ${s.hash ? lnk(s.hash, D) : `*${s.message ?? "refusé à la porte"}*`} |`);
}
