// The payroll agent pays the employee over x402, then records the payment (Article 12).
// Soft rails here (x402 spend controls + payee policy); hard rails at the employer's facilitator.
//   node x402/agent_paie.mjs
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { ExactConcordiumScheme } from '@x402/concordium/exact/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINE, JETON, EXPLORATEUR, ICI } from '../config.mjs';
import { signataire } from '../chaine.mjs';
import { ecrire, ancrer } from '../journal/journal.mjs';
import { DESTINATAIRES, approbationOuverte } from './regles.mjs';

const ouverte = approbationOuverte();
if (!ouverte) { console.log('no open human approval: the agent pays nothing'); process.exit(0); }
const agent = signataire('agent');
const coeur = x402Client.fromConfig({
  schemes: [{ network: CHAINE, client: new ExactConcordiumScheme({ accountAddress: agent.adresse, signer: agent.signer }) }],
  spendControls: { allowedAssets: [{ network: CHAINE, asset: JETON.id, maxAmountPerPayment: ouverte.montant }] },
  policies: [(v, reqs) => reqs.filter((r) => DESTINATAIRES.includes(r.payTo) && r.amount === ouverte.montant)],
});
const client = new x402HTTPClient(coeur);
const url = `http://localhost:4022/garde/${ouverte.statement_id}`;
// The agent's badge (written by registre/envoyer.mjs once the NFT is minted); --anonyme drops it.
const fBadge = join(ICI, 'sortie', 'badge.txt');
const badge = !process.argv.includes('--anonyme') && existsSync(fBadge) ? readFileSync(fBadge, 'utf8').trim() : null;
const entetes = badge ? { 'x-agent-badge': badge } : {};

const r1 = await fetch(url, { headers: entetes });
if (r1.status === 403) { console.log('refused by the collector:', JSON.stringify(await r1.json())); process.exit(1); }
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
const demande = client.getPaymentRequiredResponse((n) => r1.headers.get(n), await r1.json());
const paiement = await client.createPaymentPayload(demande);
const r2 = await fetch(url, { headers: { ...entetes, ...client.encodePaymentSignatureHeader(paiement) } });
const corps = await r2.json();
if (r2.status !== 200) throw new Error(`payment refused: ${r2.status} ${JSON.stringify(corps)}`);
const reglement = client.getPaymentSettleResponse((n) => r2.headers.get(n));
console.log('paid', ouverte.net, JETON.id, 'tx', reglement.transaction);

const p = ecrire('payment', {
  task: { what: 'pay the approved net to the employee', given_by: 'the human approval' },
  inputs: { approval: ouverte.hash, statement_id: ouverte.statement_id },
  decision: { status: 'PAID', amount: ouverte.net, token: JETON.id, recipient: corps.receipt.to,
              transaction: reglement.transaction, fees_sponsored_by: 'employer (x402 facilitator)' },
});
const ra = await ancrer(p.fichier, { par: 'agent', sponsor: 'proprietaire' });
console.log('payment recorded', ra.hash, ra.lien, `${EXPLORATEUR}`);
