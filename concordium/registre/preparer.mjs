// Prepare the two registry acts the owner signs, with no Concordium key involved:
//  1. CIS-8 registerExternalKey: the dareskro oracle's Solana key signs the canonical
//     bytes locally (tweetnacl), proving the owner controls that key;
//  2. CIS-8004 register: mint the agent NFT with the card URI, its SHA-256 and the
//     Cis8 external reference pointing at that binding.
// Output: sortie/actes-registre.json, the sign-ready payloads for registre/envoyer.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { ICI, COMPTES, SOLANA, CIS8, carteUrl } from '../config.mjs';
import { outil } from '../mcp.mjs';

const version = Number(process.argv[2] || 1);
const carte = readFileSync(join(ICI, 'carte', `agent-card.v${version}.json`));
const sha = createHash('sha256').update(carte).digest('hex');

const secret = Uint8Array.from(JSON.parse(readFileSync(SOLANA.fichier_cle, 'utf8')));
const paire = nacl.sign.keyPair.fromSecretKey(secret);
const pubHex = Buffer.from(paire.publicKey).toString('hex');
const cle = { namespace: SOLANA.namespace, key_type: SOLANA.cle_type, public_key_hex: pubHex };

// 1. what the Solana key must sign, then the signature (scheme solana-ed25519 = raw bytes)
const canon = await outil('build_cis8_canonical_bytes', {
  concordium_account: COMPTES.proprietaire,
  external_namespace: SOLANA.namespace, external_key_namespace: SOLANA.namespace,
  external_key_type: SOLANA.cle_type, external_public_key_hex: pubHex, proof_scheme: SOLANA.schema,
});
const octetsHex = canon.canonical_bytes_hex ?? canon.bytes_hex ?? canon.hex;
if (!octetsHex) throw new Error('canonical bytes not found in ' + JSON.stringify(canon).slice(0, 300));
const signature = nacl.sign.detached(Buffer.from(octetsHex, 'hex'), paire.secretKey);
if (!nacl.sign.detached.verify(Buffer.from(octetsHex, 'hex'), signature, paire.publicKey))
  throw new Error('local signature check failed');

const lien = await outil('build_cis8_register', {
  sender: COMPTES.proprietaire, external_key: cle,
  proof: { scheme: SOLANA.schema, signature_hex: Buffer.from(signature).toString('hex') },
  metadata: [{ key: 'role', value: 'dareskro payroll agent: oracle key on Solana devnet' }],
});

// 2. the NFT, with the reference to the binding above
const enregistrement = await outil('build_register', {
  sender: COMPTES.proprietaire,
  agent_uri: carteUrl(version), metadata_hash_hex: sha,
  external_reference: { kind: 'Cis8', contract_address: { index: Number(CIS8.index), subindex: Number(CIS8.subindex) }, key: cle },
});

const sortie = { prepare_le: new Date().toISOString(), signataire: COMPTES.proprietaire,
  carte: { version, uri: carteUrl(version), sha256: sha }, cle_solana: cle,
  actes: [ { nom: 'cis8.registerExternalKey', ...lien }, { nom: 'cis8004.register', ...enregistrement } ] };
writeFileSync(join(ICI, 'sortie', 'actes-registre.json'), JSON.stringify(sortie, null, 2) + '\n');
for (const a of sortie.actes) console.log(a.nom, Object.keys(a).join(','), (a.hex ?? a.parameter_hex ?? '').length, 'hex chars');
