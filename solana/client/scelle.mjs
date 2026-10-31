#!/usr/bin/env node
/**
 * dareskro on Solana — the sealed pay statement.
 *
 * What is public, on chain, next to the escrow: the statement's SHA-256 (the escrow
 * memo already carries it), the ciphertext (padded to a 1 024-byte class), its hash,
 * and the list of readers. What is private: everything the statement says. The
 * content key is AES-256-GCM; it is wrapped once per reader with X25519 + HKDF +
 * AES-GCM — the very primitives of agent/confidentiel.mjs, imported, not copied.
 *
 * Readers in the demo: employee, urssaf, retraite, dgfip, and the employer (so the
 * desk can wrap the key for a new administration later with add_reader). Their keys
 * are generated here, 0600, gitignored. In production an administration's key is
 * pinned by its fingerprint; today no French administration publishes one, and the
 * DSN remains the legal channel: this record is the opposable, timestamped copy.
 *
 * The employee also gets a Token-2022 token that cannot be transferred (the
 * NonTransferable extension), whose metadata points at the sealed record: a payslip
 * in their wallet that nobody can take or sell, and that reveals nothing by itself.
 *
 *   node scelle.mjs selftest        seal / open / refuse, offline
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, SystemProgram, Transaction, Keypair } from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction, createMintToInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateFieldInstruction, pack } from "@solana/spl-token-metadata";
import { wrapKey, unwrapKey, rawPublic, publicKeyFromRaw, canon, b64, unb64 } from "../../agent/confidentiel.mjs";
export { rawPublic };
import { PROGRAM_ID } from "./dareskro_solana.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const CLES = join(here, "cles");
export const VERSION = "dareskro/sealed-statement.solana.v1";
export const PAD_TO = 1024;
export const CHUNK = 850; // bytes of ciphertext per write_ciphertext (a transaction is 1 232 bytes)
export const ROLES = ["employee", "urssaf", "retraite", "dgfip", "employer"];
const GCM = { authTagLength: 16 };
export const sha256 = (b) => createHash("sha256").update(b).digest();

// ------------------------------------------------------------------ keys
export const keyPath = (role) => join(CLES, `${role}.key`);
export function initKeys(roles = ROLES) {
  mkdirSync(CLES, { recursive: true, mode: 0o700 }); chmodSync(CLES, 0o700);
  const pub = {};
  for (const role of roles) {
    const p = keyPath(role);
    if (!existsSync(p)) { const { privateKey } = generateKeyPairSync("x25519"); writeFileSync(p, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }); }
    chmodSync(p, 0o600);
    pub[role] = rawPublic(createPublicKey(readFileSync(p, "utf8"))).toString("hex");
  }
  return pub; // role -> x25519 public key, hex
}
export const loadPrivate = (role) => createPrivateKey(readFileSync(keyPath(role), "utf8"));
export const publicOf = (role) => rawPublic(createPublicKey(loadPrivate(role)));

// ------------------------------------------------------------------ seal / open
export const statementAddress = (escrow) =>
  PublicKey.findProgramAddressSync([Buffer.from("statement"), new PublicKey(escrow).toBuffer()], PROGRAM_ID)[0];
const aadOf = (sha256_plain, escrow) => Buffer.from(canon({ version: VERSION, sha256_plain, escrow: String(escrow) }), "utf8");

/** Seal `plain` (Buffer) for `recipients` ({role, key: Buffer(32)}). Returns what the program stores. */
export function sealStatement(plain, escrow, recipients) {
  const sha256_plain = sha256(plain).toString("hex");
  const padded = Buffer.concat([plain, Buffer.alloc((PAD_TO - (plain.length % PAD_TO)) % PAD_TO, 0x20)]);
  const contentKey = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", contentKey, iv, GCM); c.setAAD(aadOf(sha256_plain, escrow));
  const ciphertext = Buffer.concat([c.update(padded), c.final()]); const tag = c.getAuthTag();
  const readers = recipients.map(({ role, key }) => {
    const w = wrapKey(contentKey, key);
    return { role, key: Array.from(key), epk: Array.from(unb64(w.epk)), iv: Array.from(unb64(w.iv)), wrapped: Array.from(Buffer.concat([unb64(w.wrapped), unb64(w.tag)])) };
  });
  return { sha256_plain, sha256_cipher: sha256(ciphertext).toString("hex"), iv, tag, ciphertext, readers, contentKey };
}

/** Wrap an existing content key for one more reader (the employer keeps a wrapped copy for this). */
export function wrapFor(contentKey, role, key) {
  const w = wrapKey(contentKey, key);
  return { role, key: Array.from(key), epk: Array.from(unb64(w.epk)), iv: Array.from(unb64(w.iv)), wrapped: Array.from(Buffer.concat([unb64(w.wrapped), unb64(w.tag)])) };
}

/** The content key, from the on-chain record, for whoever holds `privateKey`. Throws when they are not a reader. */
export function unwrapAs(record, privateKey) {
  const mine = rawPublic(createPublicKey(privateKey));
  const r = record.readers.find((x) => Buffer.from(x.key).equals(mine));
  if (!r) throw new Error("not a reader of this statement");
  const wrapped = Buffer.from(r.wrapped);
  return unwrapKey({ epk: b64(Buffer.from(r.epk)), iv: b64(Buffer.from(r.iv)), wrapped: b64(wrapped.subarray(0, 32)), tag: b64(wrapped.subarray(32)) }, privateKey);
}

/** Decrypt the on-chain record with a content key; checks the GCM tag, the AAD and the SHA-256. */
export function openRecord(record, contentKey) {
  const sha256_plain = Buffer.from(record.sha256Plain).toString("hex");
  const d = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(record.iv), GCM);
  d.setAAD(aadOf(sha256_plain, record.escrow)); d.setAuthTag(Buffer.from(record.tag));
  const padded = Buffer.concat([d.update(Buffer.from(record.ciphertext)), d.final()]);
  const plain = Buffer.from(padded.toString("utf8").replace(/ +$/, ""), "utf8");
  if (sha256(plain).toString("hex") !== sha256_plain) throw new Error("decrypted statement does not match sha256_plain");
  return plain;
}

/** What anyone sees. */
export function publicView(record, address) {
  return {
    statement: String(address), escrow: record.escrow.toBase58(), owner: record.owner.toBase58(),
    sha256_plain: Buffer.from(record.sha256Plain).toString("hex"), sha256_cipher: Buffer.from(record.sha256Cipher).toString("hex"),
    ciphertext_bytes: record.cipherLen, size_class: `${Math.ceil(record.cipherLen / PAD_TO) * PAD_TO} bytes`, sealed: record.sealed,
    readers: record.readers.map((r) => ({ role: r.role, x25519: Buffer.from(r.key).toString("hex").slice(0, 16) + "…" })),
    token: record.token ? record.token.toBase58() : null, created_at: new Date(record.createdAt.toNumber() * 1000).toISOString(),
  };
}

// ------------------------------------------------------------------ on chain
/** seal_statement, then the chunks, then finalize. Returns the record address and the signatures. */
export async function sealOnChain(program, { owner, escrow, sealed, uri = "", token = null }) {
  const statement = statementAddress(escrow);
  const h = (hex) => Array.from(Buffer.from(hex, "hex"));
  const sigs = [];
  sigs.push(await program.methods
    .sealStatement(h(sealed.sha256_plain), h(sealed.sha256_cipher), sealed.ciphertext.length, Array.from(sealed.iv), Array.from(sealed.tag), uri, sealed.readers, token ? new PublicKey(token) : null)
    .accountsPartial({ owner: owner.publicKey, escrow: new PublicKey(escrow), statement }).signers([owner]).rpc());
  for (let off = 0; off < sealed.ciphertext.length; off += CHUNK) {
    sigs.push(await program.methods.writeCiphertext(off, sealed.ciphertext.subarray(off, off + CHUNK)).accountsPartial({ owner: owner.publicKey, statement }).signers([owner]).rpc());
  }
  sigs.push(await program.methods.finalizeStatement().accountsPartial({ owner: owner.publicKey, statement }).signers([owner]).rpc());
  return { statement: statement.toBase58(), signatures: sigs };
}
export const addReaderOnChain = (program, { owner, statement, reader }) =>
  program.methods.addReader(reader).accountsPartial({ owner: owner.publicKey, statement: new PublicKey(statement) }).signers([owner]).rpc();
export const fetchRecord = (program, statement) => program.account.sealedStatement.fetch(new PublicKey(statement));

// ------------------------------------------------------------------ the payslip token
/**
 * A Token-2022 mint with NonTransferable + MetadataPointer + TokenMetadata, one unit
 * minted to the employee, then no mint authority left. Returns the mint address.
 */
export async function mintPayslipToken(connection, payer, { employee, statement, escrow, sha256_plain, name = "dareskro payslip", symbol = "PAIE", uri }) {
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey;
  const metadata = { mint, name, symbol, uri: uri ?? `solana:${statement}`, additionalMetadata: [["statement", String(statement)], ["escrow", String(escrow)], ["sha256", sha256_plain]] };
  const mintLen = getMintLen([ExtensionType.NonTransferable, ExtensionType.MetadataPointer]);
  const space = mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const tx1 = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeNonTransferableMintInstruction(mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: payer.publicKey, mint, mintAuthority: payer.publicKey, name, symbol, uri: metadata.uri }),
  );
  const { sendAndConfirmTransaction } = await import("@solana/web3.js");
  await sendAndConfirmTransaction(connection, tx1, [payer, mintKp], { commitment: "confirmed" });
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(employee), false, TOKEN_2022_PROGRAM_ID);
  const tx2 = new Transaction().add(
    ...metadata.additionalMetadata.map(([field, value]) => createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: payer.publicKey, field, value })),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, new PublicKey(employee), mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer.publicKey, 1, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, tx2, [payer], { commitment: "confirmed" });
  return { mint: mint.toBase58(), ata: ata.toBase58() };
}

// ------------------------------------------------------------------ self-test
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "selftest") {
  const pub = initKeys();
  const plain = Buffer.from(JSON.stringify({ bulletin: "garde du dimanche", total: "466.57", employee: "7zonozdo…" }));
  const escrow = Keypair.generate().publicKey.toBase58();
  const sealed = sealStatement(plain, escrow, ROLES.map((role) => ({ role, key: Buffer.from(pub[role], "hex") })));
  const record = { escrow: new PublicKey(escrow), sha256Plain: Buffer.from(sealed.sha256_plain, "hex"), iv: sealed.iv, tag: sealed.tag, ciphertext: sealed.ciphertext, readers: sealed.readers };
  for (const role of ROLES) { const k = unwrapAs(record, loadPrivate(role)); const p = openRecord(record, k); if (!p.equals(plain)) throw new Error(role); console.log(`${role.padEnd(9)} opens: ${p.length} bytes, sha256 ok`); }
  try { unwrapAs(record, generateKeyPairSync("x25519").privateKey); throw new Error("stranger opened!"); } catch (e) { console.log(`stranger  refused: ${e.message}`); }
  const bad = { ...record, ciphertext: Buffer.from(sealed.ciphertext) }; bad.ciphertext[5] ^= 1;
  try { openRecord(bad, unwrapAs(record, loadPrivate("urssaf"))); throw new Error("tampered opened!"); } catch (e) { console.log(`tampered  refused: ${e.message.slice(0, 60)}`); }
  console.log(`ciphertext ${sealed.ciphertext.length} bytes (plain ${plain.length}), ${sealed.readers.length} readers, ${Math.ceil(sealed.ciphertext.length / CHUNK)} chunks`);
}
