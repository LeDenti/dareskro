// Offline check of the x402 wiring, no key and no funds needed: a real Concordium facilitator
// built with a throwaway signing key answers /supported, the employee's resource server
// initializes against it, and an unpaid request gets a 402 with the right requirements
// (exact scheme, testnet, payee = employee, asset = hh-EURD, atomic amount, feePayer = employer).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { ExactConcordiumScheme as Fac } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as Srv } from '@x402/concordium/exact/server';
import { toConcordiumFacilitatorSigner } from '@x402/concordium';
import { CHAINE, GRPC, COMPTES, JETON } from '../config.mjs';
import { atomique } from '../x402/regles.mjs';

const fac = new x402Facilitator().register(CHAINE, new Fac({ signer: toConcordiumFacilitatorSigner(
  COMPTES.proprietaire, buildBasicAccountSigner(randomBytes(32).toString('hex')),
  { host: GRPC.hote, port: GRPC.port, useTls: true, network: CHAINE }) }));
const s1 = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(fac.getSupported())); }).listen(4031);

const montant = atomique('407.33');
const srv = new x402HTTPResourceServer(
  new x402ResourceServer(new HTTPFacilitatorClient({ url: 'http://localhost:4031' })).register(CHAINE, new Srv()),
  { 'GET /garde/test': { accepts: { scheme: 'exact', network: CHAINE, payTo: COMPTES.salarie, price: { amount: montant, asset: JETON.id } },
                         description: 'offline test', mimeType: 'application/json' } });
await srv.initialize();
const u = new URL('http://localhost/garde/test');
const r = await srv.processHTTPRequest({ path: u.pathname, method: 'GET', adapter: {
  getHeader: () => undefined, getMethod: () => 'GET', getPath: () => u.pathname, getUrl: () => u.href,
  getAcceptHeader: () => 'application/json', getUserAgent: () => 'test' } });
s1.close();
const corps = r.response?.body;
const hdr = r.response?.headers ?? {};
const brut = hdr['PAYMENT-REQUIRED'] ?? hdr['payment-required'];
const pr = brut ? JSON.parse(Buffer.from(brut, 'base64').toString('utf8')) : corps;
const acc = (pr?.accepts ?? [])[0] ?? {};
const verdict = { status: r.response?.status, scheme: acc.scheme, network: acc.network, payTo: acc.payTo,
  asset: acc.asset, amount: acc.amount, feePayer: acc.extra?.feePayer };
console.log(JSON.stringify(verdict, null, 2));
const ok = verdict.status === 402 && acc.payTo === COMPTES.salarie && acc.asset === JETON.id
  && acc.amount === montant && acc.extra?.feePayer === COMPTES.proprietaire && acc.network === CHAINE;
console.log(ok ? 'PASS: 402 carries the employer as fee payer and the exact approved amount' : 'FAIL');
process.exit(ok ? 0 : 1);
