/**
 * The desk's view of the invoice-advance service (facture/service.mjs, 127.0.0.1:8783):
 * a pool account under a 2-of-3 signer list (AI proposer, deterministic risk policy, human operator),
 * invoices as one-unit tokens, advances and repayments as ordinary payments, the repayment lockable
 * in an XRP escrow. Testnet only: the service holds test keys; on mainnet the operator would sign on
 * a device and the two other seats would run on their own machines.
 */
const FACTURE_URL = (import.meta.env.VITE_FACTURE_URL as string | undefined) ?? "http://127.0.0.1:8783";

export type TxResult = { label?: string; result: string; hash?: string; ledger?: number; close?: string; explorer?: string; signers?: string[]; message?: string };

export type Dossier = {
  version: string; id: string;
  fournisseur: { nom: string; adresse: string }; client: { nom: string; adresse: string };
  montant: string; unite: string; emission: string; echeance: string;
  pieces: { nom: string; sha256: string }[];
  avance: { taux: number; montant: string }; frais: { pct: number; montant: string }; solde_fournisseur: string;
  pool: string; sha256: string;
};

export type Facture = {
  id: string; client: string; dossier: Dossier; cree: string;
  piece: { nom: string; sha256: string };
  jeton: { issuanceId: string; metadata: string } & TxResult;
  analyse?: { sha256: string; facture_sha256: string; ancrage: string; ancrageUrl: string; ledger?: number; recommandation: string; faits: string[]; reserves: string[]; fichier: string };
  politique?: { ok: boolean; raisons: string[]; calcul: Record<string, unknown>; date: string; signe: boolean };
  tentatives?: ({ signataires?: string[]; encaissementAvantEcheance?: boolean } & TxResult)[];
  authorize?: TxResult; cession?: TxResult;
  avance?: { signataires: string[]; horsPolitique: boolean } & TxResult;
  escrow?: { owner: string; sequence: number; finishAfter: number } & TxResult;
  encaissement?: TxResult; solde?: TxResult; eteinte?: TxResult; defaut?: TxResult; rachat?: TxResult;
};

export type Etat = {
  reseau: string; explorer: string; maintenant: string;
  limites: { partDebiteurMax: number; plafondDebiteur: string; tauxAvanceMax: number; echeanceMaxJours: number; montantMin: string; exigerAnalyse: boolean };
  pool: null | { adresse: string; url: string; capital: number; signataires: { ia: string; politique: string; operateur: string }; creation: TxResult[]; apports: TxResult[] };
  comptes: Record<string, string>;
  encours: Record<string, string>;
  soldes: Record<string, number | null>;
  factures: Facture[];
};

async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(FACTURE_URL + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  let j: unknown;
  try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
  if (!r.ok) { const e = j as { error?: string; raisons?: string[] }; throw new Error(e.error ?? `HTTP ${r.status}`); }
  return j as T;
}

export const alive = async () => { try { await call("GET", "/"); return true; } catch { return false; } };
export const etat = () => call<Etat>("GET", "/etat");
export const init = () => call<Etat>("POST", "/init");
export const creer = (b: { client: string; montant: string; dueS: number }) => call<Facture>("POST", "/factures", b);
export const action = (id: string, a: "proposer" | "politique" | "avancer" | "verrouiller" | "encaisser" | "rembourser" | "solder" | "defaut" | "rachat", body?: unknown) =>
  call<Facture>("POST", `/factures/${id}/${a}`, body ?? {});

export const statut = (f: Facture): string => {
  if (f.rachat) return "DEFAULT — receivable bought back by the supplier (recourse)";
  if (f.defaut) return "DEFAULT — written by the pool; nothing else the ledger can do against the client";
  if (f.solde) return "CLOSED — client paid, supplier got its balance, token back to the issuer";
  if (f.encaissement) return "REPAID — the pool received the invoice amount";
  if (f.escrow) return "ADVANCED — repayment locked in an XRP escrow until the due date";
  if (f.avance) return f.avance.horsPolitique ? "ADVANCED without the risk policy (AI + operator overrode it)" : "ADVANCED — signed AI + risk policy";
  if (f.politique && !f.politique.ok) return "REFUSED by the risk policy";
  if (f.politique?.ok) return "accepted by the risk policy — waiting for two signatures";
  if (f.analyse) return "analysed by the AI, anchored — waiting for the risk policy";
  return "created — invoice token issued, waiting for the AI";
};
