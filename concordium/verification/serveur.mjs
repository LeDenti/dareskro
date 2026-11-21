// Owner check, server side, for the Concordium Wallet extension (Web3 ID verifiable presentation).
//  1. /api/demande: fresh 32-byte challenge + statement "age >= 18, from a testnet identity
//     provider"; the request's fingerprint is anchored on chain BEFORE the proof (register_data,
//     tag DKAVR), like the CCDVRA anchor of Verify and Access.
//  2. /api/verifier: the presentation is checked cryptographically against the chain (web-sdk
//     getPublicData + verifyPresentation): same challenge, same statement, credential Active.
//     The proving credential is mapped to its account, which must be the agent's owner.
//     Then an `owner_verification` entry is written in the Article 12 record and anchored.
//   node verification/serveur.mjs   -> http://localhost:4030
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Web3StatementBuilder, VerifiablePresentation, getPublicData, verifyPresentation, Transaction, DataBlob,
         CredentialRegistrationId } from '@concordium/web-sdk';
import { ICI, COMPTES } from '../config.mjs';
import { client, soumettre } from '../chaine.mjs';
import { ecrire, ancrer } from '../journal/journal.mjs';

const PORT = 4030;
const BADGE = existsSync(join(ICI, 'sortie', 'badge.txt')) ? readFileSync(join(ICI, 'sortie', 'badge.txt'), 'utf8').trim() : null;
const FOURNISSEURS = [0, 1, 2, 3];
const demandes = new Map();
const corps = (req) => new Promise((ok, ko) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ko(e); } }); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
// Key-order-insensitive comparison of the statements (the wallet may reorder fields).
const trie = (o) => Array.isArray(o) ? o.map(trie) : (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, trie(o[k])])) : o);
const egal = (a, b) => JSON.stringify(trie(a)) === JSON.stringify(trie(b));
const ACTIF = 0; // CredentialStatus.Active

http.createServer(async (req, res) => {
  try {
    const statique = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] }[req.url];
    if (req.method === 'GET' && statique) { res.writeHead(200, { 'content-type': statique[1] + '; charset=utf-8' }); return res.end(readFileSync(join(ICI, 'verification', 'public', statique[0]))); }

    if (req.method === 'POST' && req.url === '/api/demande') {
      const { account } = await corps(req);
      const challenge = randomBytes(32).toString('hex');
      const statements = new Web3StatementBuilder().addForIdentityCredentials(FOURNISSEURS, (b) => b.addMinimumAge(18)).getStatements();
      const empreinte = createHash('sha256').update(challenge + JSON.stringify(statements)).digest();
      const a = await soumettre(Transaction.registerData({ data: new DataBlob(Buffer.concat([Buffer.from('DKAVR', 'ascii'), Buffer.from([1]), empreinte])) }), { par: 'proprietaire' });
      const id = randomUUID();
      demandes.set(id, { challenge, statements, ancre: a.hash, compteAnnonce: account });
      console.log('request anchored', a.hash);
      return json(res, 200, { id, challenge, statements, ancre: a.hash });
    }

    if (req.method === 'POST' && req.url === '/api/verifier') {
      const { demande, presentation } = await corps(req);
      const d = demandes.get(demande); if (!d) throw new Error('unknown or used request');
      demandes.delete(demande);
      const vp = VerifiablePresentation.fromString(presentation);
      const publics = await getPublicData(client, 'Testnet', vp);
      const inactifs = publics.filter((p) => p.status !== ACTIF);
      const contexte = await client.getCryptographicParameters();
      const prouve = verifyPresentation(vp, contexte, publics.map((p) => p.inputs)); // throws if invalid
      // keep the presentation privately (it carries the proof, no personal data) so an auditor can re-verify it
      mkdirSync(join(ICI, 'journal', 'prive', 'preuves'), { recursive: true });
      writeFileSync(join(ICI, 'journal', 'prive', 'preuves', `${demande}.json`), JSON.stringify({ demande: d, presentation }, null, 2));
      console.log('proven statements', JSON.stringify(prouve.credentialStatements).slice(0, 400), '| status', publics.map((p) => p.status));
      const motifs = [];
      if (prouve.challenge !== d.challenge) motifs.push('challenge differs');
      if (!egal(prouve.credentialStatements?.map((s) => s.statement), d.statements.map((s) => s.statement))) motifs.push(`statement differs: proven ${JSON.stringify(prouve.credentialStatements?.map((s) => s.statement)).slice(0, 200)}`);
      if (inactifs.length) motifs.push('credential not active');
      const did = vp.verifiableCredential?.[0]?.credentialSubject?.id ?? '';
      const credId = did.split(':').pop();
      let compte = null;
      try { compte = (await client.getAccountInfo(CredentialRegistrationId.fromHexString(credId))).accountAddress.address; } catch { motifs.push('proving credential not found on chain'); }
      const proprietaire = compte === COMPTES.proprietaire;
      if (!proprietaire) motifs.push(`proving account ${compte} is not the agent owner`);
      const ok = motifs.length === 0;
      const e = ecrire(ok ? 'owner_verification' : 'refusal', {
        task: { what: 'prove that a verified adult owns the agent', given_by: 'dareskro registration policy' },
        inputs: { agent_badge: BADGE, statement: 'age >= 18 (dob range proof), identity providers 0-3 (testnet)',
                  request_anchor: d.ancre, proving_credential: did, proving_account: compte,
                  presentation_sha256: createHash('sha256').update(presentation).digest('hex') },
        decision: { status: ok ? 'VERIFIED' : 'NOT_VERIFIED', owner_matches: proprietaire, reasons: motifs,
                    personal_data_disclosed: 'none (zero-knowledge range proof)' },
      });
      const a = await ancrer(e.fichier, { par: 'proprietaire' });
      console.log(ok ? 'VERIFIED' : 'NOT VERIFIED', motifs.join('; '), 'record', a.hash);
      if (!ok) return json(res, 200, { error: motifs.join('; ') });
      return json(res, 200, { verified: true, compte, proprietaire, ancre: a.hash });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); json(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`owner check on http://localhost:${PORT}`));
