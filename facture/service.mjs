#!/usr/bin/env node
/**
 * Invoice-advance service — the pool's back office, in front of the desk (app/, case "Invoice advance").
 *
 *   node service.mjs            http://127.0.0.1:8783        (FACTURE_PORT, XRPL_WSS)
 *
 * Testnet only. It holds the TEST keys of the three signers (AI, risk policy, operator) and of the
 * test counterparts (supplier, two final clients, two lenders) in facture/cles/*.testnet.json, mode
 * 0600, gitignored, asked from the faucet by POST /init. In production none of these keys lives here:
 * the operator signs on a device, the policy runs on its own machine, the AI on its own; the service
 * would only assemble the multisigned blob. The state (facture/etat.json) is public: addresses,
 * dossiers, hashes, results — never a seed.
 *
 * ROUTES (JSON; CORS open for the desk)
 *   GET  /etat                          pool, limits, signers, invoices with their steps
 *   POST /init                          keys + pool (SignerListSet 2/3, master disabled) + 80+80 XRP capital; idempotent
 *   POST /factures                      { client: "client1"|"client2", montant, dueS }  → dossier sealed, invoice token issued
 *   POST /factures/<id>/proposer        the AI: evidence from the ledger, memo, hash anchored (AccountSet)
 *   POST /factures/<id>/politique       the risk policy: deterministic verdict with reasons (no transaction)
 *   POST /factures/<id>/avancer         { signataires: ["ia","politique","operateur"] } → the pool accepts the token, the
 *                                       supplier assigns it, the advance is paid — or the ledger's refusal (1 signer:
 *                                       tefBAD_QUORUM). The policy's signature is given ONLY if its verdict is ok (409 otherwise)
 *   POST /factures/<id>/verrouiller     the client locks the repayment: EscrowCreate in XRP to the pool, FinishAfter = due
 *   POST /factures/<id>/encaisser       the operator cashes the escrow (tecNO_PERMISSION before the due date)
 *   POST /factures/<id>/rembourser      the client pays by an ordinary Payment
 *   POST /factures/<id>/solder          pool → supplier balance (policy + operator), token back to the issuer
 *   POST /factures/<id>/defaut          the default written by the pool (AI + operator), nothing else possible on the ledger
 *   POST /factures/<id>/rachat          the supplier buys the receivable back (recourse), token back to the issuer
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dossierFacture, sha256 } from "./facture.mjs";
import { LIMITES, evaluer } from "./politique.mjs";
import { analyser, conserverAnalyse } from "./analyse.mjs";
import { Registre, TESTNET, Wallet, compteUrl, explorer, log, memo, sleep, xrpToDrops } from "./registre.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FACTURE_PORT || 8783);
const ETAT = path.join(HERE, "etat.json");
const CLES = path.join(HERE, "cles");
const PIECES = path.join(HERE, "sortie", "pieces");
const ROLES = ["ia", "politique", "operateur", "fournisseur", "client1", "client2", "preteurA", "preteurB"];
const NOMS = { client1: "Pharmacie du Port (test)", client2: "Clinique des Pins (test)", fournisseur: "Atelier Nord (test)" };

const R = new Registre(TESTNET);
const etat = existsSync(ETAT) ? JSON.parse(readFileSync(ETAT, "utf8")) : { reseau: TESTNET, limites: LIMITES, pool: null, comptes: {}, factures: [] };
const save = () => writeFileSync(ETAT, JSON.stringify(etat, null, 2) + "\n");
const strip = ({ meta, tx, ...rest }) => rest;

// ── keys: 0600 files, never printed
function lireCle(role) {
  const f = path.join(CLES, `${role}.testnet.json`);
  if (!existsSync(f)) return null;
  const mode = statSync(f).mode & 0o777;
  if (mode & 0o077) throw new Error(`${f} is readable by others (mode ${mode.toString(8)}): chmod 600`);
  return Wallet.fromSeed(JSON.parse(readFileSync(f, "utf8")).seed);
}
function ecrireCle(role, wallet) {
  mkdirSync(CLES, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(CLES, `${role}.testnet.json`), JSON.stringify({ seed: wallet.seed, address: wallet.classicAddress, network: "testnet", role, created: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}
const cles = {};
for (const r of ROLES) { const w = lireCle(r); if (w) cles[r] = w; }
const poolWallet = () => ({ classicAddress: etat.pool.adresse }); // the pool has no usable key: master disabled

const capital = () => String(etat.pool?.capital ?? 0);
const encours = () => { const e = {}; for (const f of etat.factures) if (f.avance?.hash && !f.solde?.hash && !f.rachat?.hash) e[f.dossier.client.adresse] = String(Number(e[f.dossier.client.adresse] ?? 0) + Number(f.dossier.avance.montant)); return e; };
const facture = (id) => etat.factures.find((f) => f.id === id);
const sig = (noms) => noms.map((n) => { if (!cles[n] || !["ia", "politique", "operateur"].includes(n)) throw httpError(400, `unknown signer ${n}`); return cles[n]; });
const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

// ── actions
async function init() {
  if (etat.pool) return etat;
  for (const r of ROLES) if (!cles[r]) { cles[r] = await R.faucet(); ecrireCle(r, cles[r]); log(`${r}: ${cles[r].classicAddress} (faucet)`); await sleep(1500); }
  etat.comptes = Object.fromEntries(ROLES.map((r) => [r, cles[r].classicAddress]));
  const { pool, steps } = await R.creerPool({ payeur: cles.operateur, reserveXrp: "3", signataires: [cles.ia, cles.politique, cles.operateur], memos: [memo("dareskro/pool", "ouverture du pool d'avances sur facture (pupitre)")] });
  const apports = [];
  for (const [k, w] of [["preteurA", cles.preteurA], ["preteurB", cles.preteurB]]) apports.push(strip(await R.envoyer(w, { TransactionType: "Payment", Account: w.classicAddress, Destination: pool.classicAddress, Amount: xrpToDrops(80), Memos: [memo("dareskro/apport", `${k} : 80 XRP de capital`)] }, `${k} apporte 80 XRP`)));
  etat.pool = { adresse: pool.classicAddress, url: compteUrl(pool.classicAddress), capital: 160, creation: steps.map(strip), apports, signataires: { ia: cles.ia.classicAddress, politique: cles.politique.classicAddress, operateur: cles.operateur.classicAddress } };
  save();
  return etat;
}
async function creer({ client, montant, dueS }) {
  if (!etat.pool) throw httpError(409, "no pool: POST /init first");
  if (!cles[client]) throw httpError(400, "client must be client1 or client2");
  if (!/^\d+(\.\d+)?$/.test(String(montant))) throw httpError(400, "montant: a number in XRP");
  const n = etat.factures.length + 1;
  const id = `P-2026-${String(n).padStart(3, "0")}`;
  mkdirSync(PIECES, { recursive: true });
  const chemin = path.join(PIECES, `${id}.txt`);
  writeFileSync(chemin, `FACTURE ${id} — Fournisseur : ${NOMS.fournisseur} — Client : ${NOMS[client]}\nMontant : ${montant} XRP (tient lieu d'euros sur testnet). Émise le ${new Date().toISOString().slice(0, 10)}. Pièce de test créée par le pupitre.\n`);
  const piece = { nom: `${id}.txt`, chemin, sha256: sha256(readFileSync(chemin)) };
  const echeance = new Date(Math.ceil((Date.now() + Number(dueS || 180) * 1000) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const dossier = dossierFacture({ id, fournisseur: { nom: NOMS.fournisseur, adresse: cles.fournisseur.classicAddress }, client: { nom: NOMS[client], adresse: cles[client].classicAddress }, montant: String(montant), emission: new Date().toISOString().slice(0, 10), echeance, pieces: [piece], pool: etat.pool.adresse });
  const jeton = await R.emettreJetonFacture(cles.fournisseur, dossier);
  const f = { id, client, dossier, piece: { nom: piece.nom, sha256: piece.sha256 }, jeton: { issuanceId: jeton.issuanceId, metadata: jeton.metadata, ...strip(jeton) }, cree: new Date().toISOString() };
  etat.factures.push(f); save();
  return f;
}
async function proposer(f) {
  const piece = { nom: f.piece.nom, chemin: path.join(PIECES, f.piece.nom) };
  const a = await analyser({ registre: R, dossier: f.dossier, pieces: [piece], pool: etat.pool.adresse, encours: encours(), capital: capital() });
  const anc = await R.ancrerAnalyse(cles.ia, a);
  a.ancrage = anc.hash;
  const fichier = conserverAnalyse(a);
  f.analyse = { sha256: a.sha256, facture_sha256: a.facture_sha256, ancrage: anc.hash, ancrageUrl: explorer(anc.hash), ledger: anc.ledger, recommandation: a.recommandation, faits: a.faits, reserves: a.reserves, fichier: path.relative(HERE, fichier) };
  save(); return f;
}
function politique(f) {
  const v = evaluer(f.dossier, { capital: capital(), encours: encours() }, f.analyse ? { sha256: f.analyse.sha256, facture_sha256: f.analyse.facture_sha256, ancrage: f.analyse.ancrage } : undefined);
  f.politique = { ...v, date: new Date().toISOString(), signe: v.ok };
  save(); return f;
}
async function avancer(f, noms) {
  if (f.avance?.hash) throw httpError(409, "already advanced");
  if (noms.includes("politique") && !f.politique?.ok) throw httpError(409, "the risk policy does not sign: " + (f.politique ? f.politique.raisons.join(" ; ") : "no verdict yet"), { raisons: f.politique?.raisons });
  const signers = sig(noms);
  const pool = poolWallet();
  f.tentatives = f.tentatives ?? [];
  if (signers.length < 2) {
    const r = await R.avancer({ pool, signers, dossier: f.dossier, analyseSha256: f.analyse?.sha256, expect: "tefBAD_QUORUM" });
    f.tentatives.push({ signataires: noms, ...strip(r) }); save();
    return f;
  }
  if (!f.cession?.hash) {
    const c = await R.cederCreance({ pool, signers, fournisseur: cles.fournisseur, issuanceId: f.jeton.issuanceId, dossier: f.dossier });
    f.authorize = strip(c.authorize); f.cession = strip(c.cession);
  }
  const r = await R.avancer({ pool, signers, dossier: f.dossier, analyseSha256: f.analyse?.sha256 });
  f.avance = { signataires: noms, horsPolitique: !noms.includes("politique"), ...strip(r) };
  save(); return f;
}
async function verrouiller(f) {
  if (new Date(f.dossier.echeance) <= new Date()) throw httpError(409, "due date already passed: an escrow needs a future FinishAfter");
  const r = await R.verrouillerRemboursement({ debiteur: cles[f.client], pool: poolWallet(), dossier: f.dossier, graceS: 600 });
  f.escrow = { owner: cles[f.client].classicAddress, sequence: r.tx.Sequence, finishAfter: r.finishAfter, ...strip(r) };
  save(); return f;
}
async function encaisser(f) {
  if (!f.escrow) throw httpError(409, "nothing locked");
  const early = new Date(f.dossier.echeance) > new Date();
  const r = await R.encaisser({ qui: cles.operateur, owner: f.escrow.owner, sequence: f.escrow.sequence, dossier: f.dossier, expect: early ? "tecNO_PERMISSION" : "tesSUCCESS" });
  f.tentatives = f.tentatives ?? [];
  if (early) f.tentatives.push({ encaissementAvantEcheance: true, ...strip(r) }); else f.encaissement = strip(r);
  save(); return f;
}
async function rembourser(f) {
  const r = await R.envoyer(cles[f.client], { TransactionType: "Payment", Account: cles[f.client].classicAddress, Destination: etat.pool.adresse, Amount: xrpToDrops(f.dossier.montant), Memos: [memo("dareskro/remboursement", `facture ${f.id}, due le ${f.dossier.echeance}`), memo("dareskro/facture-sha256", f.dossier.sha256)] }, `${f.id} le client paie le pool (Payment ordinaire)`);
  f.encaissement = strip(r); save(); return f;
}
async function solder(f) {
  if (!f.encaissement) throw httpError(409, "nothing received yet");
  const signers = [cles.politique, cles.operateur];
  const r = await R.multisigner({ TransactionType: "Payment", Account: etat.pool.adresse, Destination: cles.fournisseur.classicAddress, Amount: xrpToDrops(f.dossier.solde_fournisseur), Memos: [memo("dareskro/solde", `facture ${f.id} encaissée : solde au fournisseur après avance ${f.dossier.avance.montant} et frais ${f.dossier.frais.montant}`), memo("dareskro/facture-sha256", f.dossier.sha256)] }, signers, `${f.id} solde ${f.dossier.solde_fournisseur} XRP au fournisseur`);
  const e = await R.eteindreCreance({ pool: poolWallet(), signers, fournisseur: cles.fournisseur, issuanceId: f.jeton.issuanceId, dossier: f.dossier, motif: "payée par le client" });
  f.solde = strip(r); f.eteinte = strip(e); save(); return f;
}
async function defaut(f) {
  if (new Date(f.dossier.echeance) > new Date()) throw httpError(409, "not due yet");
  const r = await R.constaterDefaut({ pool: poolWallet(), signers: [cles.ia, cles.operateur], dossier: f.dossier, texte: `facture ${f.id} due le ${f.dossier.echeance} : rien reçu du client ${f.dossier.client.adresse} ; avance ${f.dossier.avance.montant} XRP non couverte ; recours contractuel contre le fournisseur` });
  f.defaut = strip(r); save(); return f;
}
async function rachat(f) {
  const r = await R.envoyer(cles.fournisseur, { TransactionType: "Payment", Account: cles.fournisseur.classicAddress, Destination: etat.pool.adresse, Amount: xrpToDrops(f.dossier.avance.montant), Memos: [memo("dareskro/rachat", `facture ${f.id} : rachat de la créance par le fournisseur (recours)`), memo("dareskro/facture-sha256", f.dossier.sha256)] }, `${f.id} le fournisseur rachète la créance`);
  const e = await R.eteindreCreance({ pool: poolWallet(), signers: [cles.politique, cles.operateur], fournisseur: cles.fournisseur, issuanceId: f.jeton.issuanceId, dossier: f.dossier, motif: "rachetée par le fournisseur après défaut du client" });
  f.rachat = strip(r); f.eteinte = strip(e); save(); return f;
}
async function vue() {
  const soldes = {};
  if (etat.pool) for (const [k, a] of Object.entries({ pool: etat.pool.adresse, ...etat.comptes })) soldes[k] = await R.soldeXrp(a);
  return { ...etat, encours: encours(), soldes, maintenant: new Date().toISOString(), explorer: process.env.XRPL_EXPLORER || "https://testnet.xrpl.org" };
}

// ── http
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" }); res.end(JSON.stringify(body, null, 2)); };
const body = (req) => new Promise((resolve, reject) => { let s = ""; req.on("data", (d) => { s += d; }); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(httpError(400, "bad JSON")); } }); });
let chain = Promise.resolve(); // one ledger action at a time: the signers' sequences must not race
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (req.method === "GET" && url.pathname === "/etat") return json(res, 200, await vue());
    if (req.method === "GET" && url.pathname === "/") return json(res, 200, { service: "dareskro facture", routes: ["GET /etat", "POST /init", "POST /factures", "POST /factures/<id>/<action>"] });
    if (req.method === "POST" && url.pathname === "/init") return json(res, 200, await serial(init));
    if (req.method === "POST" && url.pathname === "/factures") { const b = await body(req); return json(res, 201, await serial(() => creer(b))); }
    const m = url.pathname.match(/^\/factures\/([^/]+)\/(proposer|politique|avancer|verrouiller|encaisser|rembourser|solder|defaut|rachat)$/);
    if (req.method === "POST" && m) {
      const f = facture(m[1]); if (!f) return json(res, 404, { error: "unknown invoice" });
      const b = await body(req);
      const actions = { proposer, politique: async (x) => politique(x), avancer: (x) => avancer(x, b.signataires ?? ["ia", "politique"]), verrouiller, encaisser, rembourser, solder, defaut, rachat };
      return json(res, 200, await serial(() => actions[m[2]](f)));
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    log(`error ${req.method} ${url.pathname}: ${e.message}`);
    json(res, e.status ?? 500, { error: e.message, ...(e.extra ?? {}) });
  }
}).listen(PORT, "127.0.0.1", async () => {
  await R.connect();
  log(`facture service on http://127.0.0.1:${PORT} — ${TESTNET} — keys in ${path.relative(HERE, CLES)}/ (0600) — pool ${etat.pool?.adresse ?? "not created yet (POST /init)"}`);
});
