// The EMPLOYER's x402 facilitator (there is no public Concordium facilitator, by design).
// It co-signs as fee sponsor ONLY a payment that matches an open human approval:
// sender = the agent, payee on the allow-list, token = hh-EURD, amount = the approved net,
// rate-limited. Every refusal is written to the Article 12 record and anchored.
// The Concordium scheme then enforces its own 9 rules (V1 sponsored format, sponsor = us,
// exact amount, expiry <= 10 min, sender signature, one operation, ...).
//   node x402/facilitateur.mjs   -> http://localhost:4021  (POST /verify, POST /settle, GET /supported)
import http from 'node:http';
import { AccountAddress } from '@concordium/web-sdk';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactConcordiumScheme } from '@x402/concordium/exact/facilitator';
import { toConcordiumFacilitatorSigner } from '@x402/concordium';
import { CHAINE, GRPC, COMPTES, JETON } from '../config.mjs';
import { client, signataire } from '../chaine.mjs';
import { ecrire, ancrer } from '../journal/journal.mjs';
import { DESTINATAIRES, DEBIT_MAX_PAR_HEURE, CCD_MIN_SPONSOR, approbationOuverte, expediteur as lireExpediteur } from './regles.mjs';

export const PORT = 4021;
const sponsor = signataire('proprietaire');
const facilitateur = new x402Facilitator().register(CHAINE, new ExactConcordiumScheme({
  signer: toConcordiumFacilitatorSigner(COMPTES.proprietaire, sponsor.signer,
                                        { host: GRPC.hote, port: GRPC.port, useTls: true, network: CHAINE }),
}));
const reglements = [];

async function garde(payload, req) {
  const motifs = [];
  const expediteur = lireExpediteur(payload);
  if (expediteur !== COMPTES.agent) motifs.push(`sender ${expediteur} is not the payroll agent`);
  if (!DESTINATAIRES.includes(req.payTo)) motifs.push(`payee ${req.payTo} not on the allow-list`);
  if (req.asset !== JETON.id) motifs.push(`asset ${req.asset} is not ${JETON.id}`);
  const ouverte = approbationOuverte();
  if (!ouverte) motifs.push('no open human approval');
  else if (req.amount !== ouverte.montant) motifs.push(`amount ${req.amount} differs from the approved ${ouverte.montant}`);
  const uneHeure = Date.now() - 3600e3;
  if (reglements.filter((t) => t > uneHeure).length >= DEBIT_MAX_PAR_HEURE) motifs.push('rate limit reached');
  const info = await client.getAccountInfo(AccountAddress.fromBase58(COMPTES.proprietaire));
  const ccd = Number(info.accountAmount.microCcdAmount) / 1e6;
  if (ccd < CCD_MIN_SPONSOR) motifs.push(`sponsor balance low: ${ccd} CCD`);
  return { motifs, ouverte };
}

async function refuser(motifs, payload, req) {
  const r = ecrire('refusal', {
    task: { what: 'co-sign an agent payment as fee sponsor', given_by: 'x402 resource server' },
    inputs: { sender: lireExpediteur(payload), payee: req?.payTo ?? null, asset: req?.asset ?? null, amount: req?.amount ?? null },
    decision: { status: 'REFUSED', reasons: motifs },
  });
  try { await ancrer(r.fichier, { par: 'proprietaire' }); } catch (e) { console.error('anchor failed', e.message); }
  return { isValid: false, invalidReason: 'employer_rails', invalidMessage: motifs.join('; ') };
}

const lireCorps = (req) => new Promise((ok, ko) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ko(e); } }); });
const repondre = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/supported') return repondre(res, 200, facilitateur.getSupported());
    if (req.method !== 'POST' || !['/verify', '/settle'].includes(req.url)) return repondre(res, 404, { error: 'not found' });
    const { paymentPayload, paymentRequirements } = await lireCorps(req);
    const { motifs } = await garde(paymentPayload, paymentRequirements);
    if (motifs.length) {
      const refus = await refuser(motifs, paymentPayload, paymentRequirements);
      console.log('REFUSED', refus.invalidMessage);
      return repondre(res, 200, req.url === '/verify' ? refus
        : { success: false, errorReason: 'employer_rails', errorMessage: refus.invalidMessage, transaction: '', network: CHAINE });
    }
    if (req.url === '/verify') return repondre(res, 200, await facilitateur.verify(paymentPayload, paymentRequirements));
    const r = await facilitateur.settle(paymentPayload, paymentRequirements);
    if (r.success) reglements.push(Date.now());
    console.log('SETTLED', r.success, r.transaction ?? r.errorReason);
    return repondre(res, 200, r);
  } catch (e) { console.error(e); repondre(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`employer facilitator on http://localhost:${PORT}, sponsor ${COMPTES.proprietaire}`));
