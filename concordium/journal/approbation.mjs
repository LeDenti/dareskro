// The human act. The employer, whose Concordium account is identity-verified, approves the
// proposed statement. Three things happen, all signed by the employer (who pays his own fees):
//   1. a `human_approval` entry in the Article 12 record, anchored with register_data;
//   2. the exact net, in hh-EURD, moves from the employer's reserve to the agent, with a memo
//      naming the statement and the approval hash: the agent never holds more than this;
//   3. nothing else: the agent pays the employee itself, through x402 (x402/agent_paie.mjs).
// In January 2027 step 2 becomes a Simple Lock (recipient = employee, token = hh-EURD,
// expiry = pay date, send right = agent), and the funds no longer leave the employer's account.
//   node journal/approbation.mjs              -> shows the pending proposal, does nothing
//   node journal/approbation.mjs --approuve   -> approves it
import { readFileSync, writeFileSync } from 'node:fs';
import { lire, ecrire, ancrer } from './journal.mjs';
import { soumettre } from '../chaine.mjs';
import { transfert } from '../jeton.mjs';
import { COMPTES } from '../config.mjs';

// Resumable: an approval written but not anchored, or anchored but not funded (network cut),
// is completed instead of being written twice.
const tout = lire();
const inachevee = [...tout].reverse().find((d) => d.entree.type === 'human_approval' && (!d.ancre || !d.versement));
let a;
if (inachevee) {
  a = { fichier: inachevee.fichier, hash: inachevee.hash, entree: inachevee.entree };
  console.log(`resuming approval ${a.hash.slice(0, 16)}... of ${a.entree.inputs.statement_id} (anchor ${inachevee.ancre ? 'done' : 'missing'}, transfer ${inachevee.versement ? 'done' : 'missing'})`);
  if (!process.argv.includes('--approuve')) { console.log('re-run with --approuve to complete it'); process.exit(0); }
} else {
  const deja = new Set(tout.filter((d) => d.entree.type === 'human_approval').map((d) => d.entree.inputs.proposal));
  const prop = [...tout].reverse().find((d) => d.entree.type === 'proposal' && !deja.has(d.hash));
  if (!prop) { console.log('no pending proposal'); process.exit(0); }
  const p = prop.entree;
  console.log(`pending: ${p.inputs.statement_id}, period ${p.task.period}, net ${p.decision.net} (${p.decision.currency})`);
  if (!process.argv.includes('--approuve')) { console.log('re-run with --approuve to approve'); process.exit(0); }
  a = ecrire('human_approval', {
    task: { what: 'approve the pay statement before any payment', given_by: 'the employer' },
    inputs: { proposal: prop.hash, statement_id: p.inputs.statement_id, statement_sha256: p.inputs.statement_sha256 },
    human_intervention: { by_account: COMPTES.proprietaire,
      identity: 'Concordium account created from a verified identity (identity provider); no personal data on chain' },
    decision: { status: 'APPROVED', net: p.decision.net, currency: p.decision.currency, settle_in: 'hh-EURD',
                recipient: COMPTES.salarie },
  });
}

let doc = JSON.parse(readFileSync(a.fichier, 'utf8'));
if (!doc.ancre) {
  const ra = await ancrer(a.fichier, { par: 'proprietaire' });
  console.log('approval anchored', ra.hash, ra.lien);
  doc = JSON.parse(readFileSync(a.fichier, 'utf8'));
}
if (!doc.versement) {
  const memo = `${a.entree.inputs.statement_id}|art12:${a.hash.slice(0, 16)}`;
  const rv = await soumettre(transfert('agent', a.entree.decision.net, memo), { par: 'proprietaire' });
  doc.versement = { tx: rv.hash, lien: rv.lien, montant: a.entree.decision.net, memo };
  writeFileSync(a.fichier, JSON.stringify(doc, null, 2) + '\n');
  console.log('net moved to the agent', rv.hash, rv.lien);
}
