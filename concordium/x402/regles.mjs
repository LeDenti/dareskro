// The rails, shared by the agent (soft, x402 spend controls) and the employer's facilitator
// (hard: it refuses to co-sign, and the agent holds no CCD to pay fees by itself).
// Until Protocol-Level Locks reach testnet, these lines ARE the lock.
import { COMPTES, JETON, CHAINE } from '../config.mjs';
import { lire } from '../journal/journal.mjs';

export const DESTINATAIRES = [COMPTES.salarie];   // allow-list of payees
export const DEBIT_MAX_PAR_HEURE = 3;              // settlements per hour, per agent
export const CCD_MIN_SPONSOR = 1;                  // alert under this sponsor balance

export const atomique = (dec) => {
  const [e, f = ''] = String(dec).split('.');
  return (BigInt(e) * 10n ** BigInt(JETON.decimales) + BigInt((f + '0'.repeat(JETON.decimales)).slice(0, JETON.decimales))).toString();
};

// The statement the agent may pay now: approved by the human, not yet paid.
export function approbationOuverte() {
  const tout = lire();
  const payes = new Set(tout.filter((d) => d.entree.type === 'payment').map((d) => d.entree.inputs.approval));
  const a = [...tout].reverse().find((d) => d.entree.type === 'human_approval' && !payes.has(d.hash));
  if (!a) return null;
  return { hash: a.hash, statement_id: a.entree.inputs.statement_id, net: a.entree.decision.net,
           montant: atomique(a.entree.decision.net), destinataire: a.entree.decision.recipient,
           reseau: CHAINE, actif: JETON.id };
}
