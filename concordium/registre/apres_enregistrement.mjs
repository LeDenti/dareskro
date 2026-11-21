// After registre/envoyer.mjs has minted the agent NFT:
//   1. find our token (owned by the employer, card URI = ours) and write the badge;
//   2. setAgentWallet: route the agent's payments to the `agent` account. Two authorisations:
//      the agent account key signs the 162-byte canonical message (proof it controls the wallet),
//      the owner signs and submits the transaction. Without this, the wallet defaults to the
//      owner and the collector refuses the agent as payer;
//   3. pass 2 of the card (with the badge) and setAgentURI to pin its hash.
//      The v2 card must be served (pushed) before the badge checks green.
//   node registre/apres_enregistrement.mjs [--carte]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import nacl from 'tweetnacl';
import { Transaction, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy } from '@concordium/web-sdk';
import { ICI, COMPTES, carteUrl } from '../config.mjs';
import { outil } from '../mcp.mjs';
import { soumettre, json, signataire } from '../chaine.mjs';

const appel = (a) => Transaction.updateContract({ amount: CcdAmount.zero(),
  address: ContractAddress.create(a.contract_address.index, a.contract_address.subindex),
  receiveName: ReceiveName.fromString(a.receive_name), message: Parameter.fromHexString(a.parameter_hex) },
  Energy.create(a.suggested_energy));

// 1. our token
const liste = await outil('agents_by_owner', { owner_account: COMPTES.proprietaire });
const agents = (liste.agents ?? liste.items ?? liste ?? []).filter((a) => String(a.agent_uri ?? '').startsWith(carteUrl(1).replace(/v1\.json$/, '')));
if (!agents.length) throw new Error('no dareskro agent owned by the employer yet: run registre/envoyer.mjs first');
const nous = agents.sort((x, y) => Number(y.token_id) - Number(x.token_id))[0];
const tokenId = String(nous.token_id);
const badge = nous.token_address ?? (await outil('token_address', { contract_index: 12802, subindex: 0, token_id: tokenId })).token_address;
writeFileSync(join(ICI, 'sortie', 'badge.txt'), badge + '\n');
console.log('agent NFT', tokenId, 'badge', badge);

// 2. setAgentWallet = agent
if (nous.agent_wallet !== COMPTES.agent) {
  const delai = Date.now() + 15 * 60e3;
  const c = await outil('set_agent_wallet_canonical_bytes', { token_id: tokenId, new_wallet: COMPTES.agent, deadline_unix_ms: delai });
  const octets = Buffer.from(c.canonical_bytes_hex ?? c.bytes_hex ?? c.hex, 'hex');
  const graine = Buffer.from(signataire('agent').brute, 'hex');
  const sig = nacl.sign.detached(octets, nacl.sign.keyPair.fromSeed(graine).secretKey);
  const a = await outil('build_set_agent_wallet', { token_id: tokenId, new_wallet: COMPTES.agent, deadline_unix_ms: delai,
    signature_hex: Buffer.from(sig).toString('hex'), sender: COMPTES.proprietaire });
  const r = await soumettre(appel(a), { par: 'proprietaire' });
  console.log('setAgentWallet', r.hash, r.lien);
}

// 3. card v2 with the badge, then pin it
if (process.argv.includes('--carte')) {
  execFileSync('node', [join(ICI, 'carte', 'construire.mjs'), '2', tokenId], { stdio: 'inherit' });
  const sha = createHash('sha256').update(readFileSync(join(ICI, 'carte', 'agent-card.v2.json'))).digest('hex');
  const a = await outil('build_set_agent_uri', { token_id: tokenId, agent_uri: carteUrl(2), metadata_hash_hex: sha, sender: COMPTES.proprietaire });
  const r = await soumettre(appel(a), { par: 'proprietaire' });
  console.log('setAgentURI v2', r.hash, r.lien, 'sha', sha);
}
console.log(json(await outil('agent_by_token_address', { token_address: badge })));
