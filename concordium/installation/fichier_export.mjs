// Builds a full wallet-export JSON (the format concordium-client and the verifier service read)
// from a raw key in cles/<role>.key and the account's on-chain credential. Written to
// cles/<role>.export (git-ignored, mode 600). Prints only the role and the address.
import { writeFileSync, chmodSync } from 'node:fs';
import nacl from 'tweetnacl';
import { AccountAddress, parseWallet } from '@concordium/web-sdk';
import { COMPTES, cleDe } from '../config.mjs';
import { client, cleBrute } from '../chaine.mjs';

const role = process.argv[2] ?? 'proprietaire';
const brute = cleBrute(role);
if (!brute) throw new Error(`no cles/${role}.key`);
const adresse = COMPTES[role];
const info = await client.getAccountInfo(AccountAddress.fromBase58(adresse));
const cred = info.accountCredentials[0].value.contents;
const verifyKey = Buffer.from(nacl.sign.keyPair.fromSeed(Buffer.from(brute, 'hex')).publicKey).toString('hex');
const doc = { type: 'concordium-browser-wallet-account', v: 0, environment: 'testnet',
  value: { accountKeys: { keys: { 0: { keys: { 0: { signKey: brute, verifyKey } }, threshold: 1 } }, threshold: 1 },
           credentials: { 0: cred.credId ?? cred.regId }, address: adresse } };
parseWallet(JSON.stringify(doc)); // throws if the SDK cannot read it back
const f = cleDe(role);
writeFileSync(f, JSON.stringify(doc)); chmodSync(f, 0o600);
console.log(`${role}: export file written for ${adresse}`);
process.exit(0);
