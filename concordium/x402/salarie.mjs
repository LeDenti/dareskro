// The employee's side: a tiny service that answers 402 Payment Required for an approved
// on-call shift, priced at the approved net in hh-EURD, payable to the employee's account,
// and hands back a signed-off receipt once the employer's facilitator has settled it.
// It is also the COLLECTOR: it deals only with an accountable agent. The caller must present
// its Concordium badge (header x-agent-badge); the badge is checked before the invoice is
// issued, and again before settlement, once the paying account is known.
//   node x402/salarie.mjs   -> http://localhost:4022/garde/<statement_id>
import http from 'node:http';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { ExactConcordiumScheme } from '@x402/concordium/exact/server';
import { CHAINE, COMPTES, JETON } from '../config.mjs';
import { approbationOuverte, expediteur } from './regles.mjs';
import { verifierPayeur } from './collecteur.mjs';

export const PORT = 4022;
const ouverte = approbationOuverte();
if (!ouverte) { console.error('no open human approval: nothing to invoice'); process.exit(1); }
const chemin = `/garde/${ouverte.statement_id}`;

const serveur = new x402ResourceServer(new HTTPFacilitatorClient({ url: 'http://localhost:4021' }))
  .register(CHAINE, new ExactConcordiumScheme());
const routes = { [`GET ${chemin}`]: {
  accepts: { scheme: 'exact', network: CHAINE, payTo: COMPTES.salarie,
             price: { amount: ouverte.montant, asset: JETON.id } },
  description: `On-call shift ${ouverte.statement_id}, net approved by the employer`,
  mimeType: 'application/json',
} };
const http402 = new x402HTTPResourceServer(serveur, routes);
await http402.initialize();

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const adapter = {
    getHeader: (n) => req.headers[n.toLowerCase()], getMethod: () => req.method, getPath: () => url.pathname,
    getUrl: () => url.href, getAcceptHeader: () => req.headers.accept ?? '', getUserAgent: () => req.headers['user-agent'] ?? '',
  };
  const badge = req.headers['x-agent-badge'] ?? null;
  const refuser = (v) => { console.log('REFUSED', v.motifs.join(' | '));
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent_not_accountable', reasons: v.motifs })); };
  const avant = await verifierPayeur({ badge });
  if (!avant.accepte) return refuser(avant);
  const ctx = { adapter, path: url.pathname, method: req.method };
  const r = await http402.processHTTPRequest(ctx);
  if (r.type === 'payment-error') {
    res.writeHead(r.response.status, r.response.headers); return res.end(JSON.stringify(r.response.body ?? {}));
  }
  if (r.type === 'no-payment-required') { res.writeHead(404); return res.end(); }
  const payeur = expediteur(r.paymentPayload);
  const v = payeur ? await verifierPayeur({ badge, payeur })
                   : { accepte: false, motifs: ['payer account not found in the payment'] };
  if (!v.accepte) return refuser(v);
  console.log('ACCEPTED agent', v.token_id, 'owner', v.proprietaire);
  const s = await http402.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions);
  if (!s.success) { res.writeHead(s.response.status, s.response.headers); return res.end(JSON.stringify(s.response.body ?? {})); }
  res.writeHead(200, { 'content-type': 'application/json', ...s.headers });
  res.end(JSON.stringify({ receipt: { statement_id: ouverte.statement_id, paid: ouverte.net, token: JETON.id,
                                      to: COMPTES.salarie, transaction: s.transaction } }));
}).listen(PORT, () => console.log(`employee service on http://localhost:${PORT}${chemin} (${ouverte.net} ${JETON.id})`));
