// One door to the chain: load a role's key, build, sign, optionally sponsor, submit, wait.
// Keys are the Browser Wallet export files in cles/<role>.export (git-ignored).
// Sponsoring (protocol-level, web-sdk 12): the EMPLOYER (`proprietaire`) co-signs and pays the
// fees of every transaction the agent sends. The agent keeps no CCD of its own, so it cannot
// move anything unless the employer's side co-signs: a hard control available today, until
// Protocol-Level Locks reach testnet (Simple Locks, January 2027).
import { existsSync, readFileSync } from 'node:fs';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { AccountAddress, Transaction, TransactionExpiry, parseWallet, buildAccountSigner,
         buildBasicAccountSigner } from '@concordium/web-sdk';
import nacl from 'tweetnacl';
import { GRPC, EXPLORATEUR, COMPTES, cleDe } from './config.mjs';

export const client = new ConcordiumGRPCNodeClient(GRPC.hote, GRPC.port, credentials.createSsl());

// Two accepted key formats in cles/:
//   <role>.export : the JSON file of the Desktop/mobile wallet export (concordium-client format);
//   <role>.key    : the raw private key copied from the Browser Wallet ("Export" copies it),
//                   written by `pbpaste > cles/<role>.key`, never shown anywhere.
// A raw key carries no address, so we check it against the chain: its public key must be the
// verify key of credential 0 of the expected account.
export function cleBrute(role) {
  const f = cleDe(role).replace(/\.export$/, '.key');
  if (!existsSync(f)) return null;
  const hex = readFileSync(f, 'utf8').trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${f}: expected a 64-hex-character private key, got ${hex.length} characters`);
  return hex;
}

export function signataire(role) {
  const brute = cleBrute(role);
  if (brute) {
    const attendu = COMPTES[role];
    if (!attendu) throw new Error(`no account configured for role ${role}`);
    return { adresse: AccountAddress.fromBase58(attendu), signer: buildBasicAccountSigner(brute), brute };
  }
  const f = cleDe(role);
  if (!existsSync(f)) throw new Error(`missing key for "${role}": put it in concordium/cles/${role}.key (pbpaste) or ${role}.export`);
  const portefeuille = parseWallet(readFileSync(f, 'utf8'));
  const attendu = COMPTES[role];
  if (attendu && portefeuille.value.address !== attendu)
    throw new Error(`key file ${f} is for ${portefeuille.value.address}, expected ${role} = ${attendu}`);
  return { adresse: AccountAddress.fromBase58(portefeuille.value.address), signer: buildAccountSigner(portefeuille),
           brute: portefeuille.value.accountKeys.keys[0].keys[0].signKey };
}

// Check a role's key against the chain without signing anything: the public key derived from
// the private key must equal the account's on-chain verify key.
export async function verifierCle(role) {
  const s = signataire(role);
  const pub = Buffer.from(nacl.sign.keyPair.fromSeed(Buffer.from(s.brute, 'hex')).publicKey).toString('hex');
  const info = await client.getAccountInfo(s.adresse);
  const cred = info.accountCredentials[0]?.value?.contents;
  const cles = cred?.credentialPublicKeys?.keys ?? {};
  const surChaine = Object.values(cles).map((k) => k.verifyKey);
  return { role, adresse: s.adresse.address ?? AccountAddress.toBase58(s.adresse), ok: surChaine.includes(pub) };
}

// builder: an Initial transaction (Transaction.updateContract(...), registerData(...), tokenUpdate(...)).
export async function soumettre(builder, { par, sponsor = null, expirationMin = 10 } = {}) {
  const exp = signataire(par);
  const { nonce } = await client.getNextAccountNonce(exp.adresse);
  let tx = builder.addMetadata({ sender: exp.adresse, nonce, expiry: TransactionExpiry.futureMinutes(expirationMin) });
  let sp = null;
  if (sponsor && sponsor !== par) { sp = signataire(sponsor); tx = tx.addSponsor(sp.adresse); }
  let signable = await Transaction.sign(tx.build(), exp.signer);
  if (sp) signable = await Transaction.sponsor(signable, sp.signer);
  const hash = await client.sendTransaction(Transaction.finalize(signable));
  const resume = await client.waitForTransactionFinalization(hash);
  const h = hash.toString();
  return { hash: h, lien: `${EXPLORATEUR}/?dcount=1&dentity=transaction&dhash=${h}`,
           bloc: resume.blockHash.toString(), resultat: resume.summary };
}

export const json = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
