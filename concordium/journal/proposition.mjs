// Entry 1 of a pay cycle: the agent computed a statement from evidence; it is only a PROPOSAL.
// Reads the real output of the payroll engine (agent/sortie/bulletin.json) and records
// fingerprints, never the personal content itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICI } from '../config.mjs';
import { ecrire, sha256, ancrer } from './journal.mjs';

const brut = readFileSync(join(ICI, '..', 'agent', 'sortie', 'bulletin.json'));
const b = JSON.parse(brut);
const net = b.net_paid; // after the withholding tax, which goes to the tax office, not the employee
const r = ecrire('proposal', {
  task: { what: 'compute the on-call pay statement', given_by: 'payroll schedule of the pharmacy', period: b.period },
  inputs: {
    statement_id: b.statement_id,
    statement_sha256: b.sha256,          // the engine's own canonical hash (also in the Solana/XRPL memos)
    statement_file_sha256: sha256(brut),
    evidence_sha256: sha256(Buffer.from(JSON.stringify(b.evidence ?? {}), 'utf8')),
    anomalies: (b.evidence?.anomalies ?? []).length,
  },
  decision: { status: 'PROPOSAL', net, currency: b.currency, computed_by: b.computed_by,
              note: 'nothing is paid before a named human approves' },
});
console.log(JSON.stringify({ fichier: r.fichier, hash: r.hash, net }, null, 2));

// --ancrer: anchor it (sent by the agent, fee sponsored by the employer: the agent holds no CCD)
if (process.argv.includes('--ancrer')) {
  const a = await ancrer(r.fichier, { par: 'agent', sponsor: 'proprietaire' });
  console.log('proposal anchored', a.hash, a.lien);
}
