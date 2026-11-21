// Build the agent card through the registry's own builder (it injects every on-chain
// identifier), then write the EXACT bytes it hashed: the served file must hash to the
// value pinned on chain. Two passes: v1 before the NFT exists, v2 with the badge.
//   node carte/construire.mjs 1            -> carte/agent-card.v1.json (no token yet)
//   node carte/construire.mjs 2 <token_id> -> carte/agent-card.v2.json (badge included)
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ICI, COMPTES, SOLANA, carteUrl } from '../config.mjs';
import { outil } from '../mcp.mjs';

const version = Number(process.argv[2] || 1);
const tokenId = process.argv[3] ?? null;
if (version > 1 && tokenId === null) throw new Error('v2 needs the token_id minted by register');

const secret = Uint8Array.from(JSON.parse(readFileSync(SOLANA.fichier_cle, 'utf8')));
const solanaPub = bs58.encode(nacl.sign.keyPair.fromSecretKey(secret).publicKey);

const entree = {
  name: 'dareskro payroll agent',
  description:
    'The payroll agent of a pharmacy in Marseille. It reads the schedule and the badge clock, '
    + 'computes the on-call pay statement with deterministic code, waits for a named human to '
    + 'approve it, then pays the employee. On Concordium its owner is a verified human, it pays '
    + 'in hh-EURD over x402 with sponsored fees, and every decision leaves an EU AI Act Article 12 '
    + 'record anchored by hash (register_data). Its existing Solana key is bound through CIS-8.',
  agent_uri: carteUrl(version),
  owner_account: COMPTES.proprietaire,
  agent_wallet: COMPTES.agent,
  token_id: tokenId,
  version: `0.${version}.0`,
  provider: { organization: 'dareskro', url: 'https://github.com/LeDenti/dareskro' },
  documentation_url: 'https://github.com/LeDenti/dareskro/tree/main/concordium',
  external_reference: { kind: 'Cis8', namespace: SOLANA.namespace, identifier: solanaPub },
  skills: [
    { id: 'payroll.compute', name: 'Compute an on-call pay statement',
      description: 'Deterministic computation from schedule and badge evidence; no model touches the amounts.',
      tags: ['payroll', 'deterministic'] },
    { id: 'payroll.approve-request', name: 'Ask a named human to approve',
      description: 'The statement leaves as a PROPOSAL; nothing is paid before a human approves it.',
      tags: ['human-in-the-loop'] },
    { id: 'pay.x402', name: 'Pay over x402 in hh-EURD',
      description: 'Pays the approved net to an allow-listed recipient, fees sponsored by the agent account.',
      tags: ['x402', 'plt', 'sponsored'] },
    { id: 'record.article12', name: 'Keep an Article 12 record',
      description: 'Hash of each decision record plus a random nonce anchored with register_data; the record stays off chain.',
      tags: ['ai-act', 'audit'] },
    { id: 'escrow.release', name: 'Release a payroll escrow on Solana',
      description: 'The same agent key releases the dareskro escrow on Solana devnet (program 6NoVNiHv...).',
      tags: ['solana', 'escrow'] },
  ],
};

const r = await outil('build_agent_card', entree);
const brut = r.agent_card_json;
const sha = createHash('sha256').update(Buffer.from(brut, 'utf8')).digest('hex');
const annonce = r.sha256 ?? r.metadata_hash_hex ?? r.hash;
if (annonce && annonce !== sha) throw new Error(`hash mismatch: builder ${annonce}, bytes ${sha}`);
const fichier = join(ICI, 'carte', `agent-card.v${version}.json`);
writeFileSync(fichier, brut);
console.log(JSON.stringify({ fichier, agent_uri: entree.agent_uri, sha256: sha, solana: solanaPub,
                             cles_rendues: Object.keys(r) }, null, 2));
