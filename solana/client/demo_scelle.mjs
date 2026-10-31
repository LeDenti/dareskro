#!/usr/bin/env node
/**
 * The sealed pay statement on devnet, end to end:
 *
 *   1. the employer locks the Sunday shift (payroll escrow, memo = statement sha256)
 *   2. the statement is sealed for employee, URSSAF, retraite, DGFiP and the employer:
 *      seal_statement, the ciphertext in chunks, finalize_statement (hash checked on chain)
 *   3. the employee receives a non-transferable Token-2022 token pointing at the record
 *   4. each administration opens the record with its own key; the hash matches the memo
 *   5. the public sees sizes, hashes and roles — nothing else
 *   6. a stranger with a fresh key cannot unwrap; a tampered copy does not decrypt
 *   7. a new reader (Agirc-Arrco) is added later: the employer wraps the same key for it
 *   8. the employee tries to transfer the token: refused by Token-2022 (NonTransferable)
 *
 * Usage: node demo_scelle.mjs      (CLI key pays, ~0.1 SOL)   → compte_rendu_scelle.json
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { connect, createEscrow, getEscrow, explorerTx, explorerAccount, chainNow, Keypair, PublicKey } from "./dareskro_solana.mjs";
import { statementAddress, ROLES, initKeys, loadPrivate, sealStatement, sealOnChain, fetchRecord, unwrapAs, openRecord, publicView, wrapFor, addReaderOnChain, mintPayslipToken, sha256, rawPublic } from "./scelle.mjs";
import { createPublicKey } from "node:crypto";

const CLUSTER = process.env.CLUSTER || "devnet";
const here = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { cluster: CLUSTER, startedAt: new Date().toISOString(), steps: [] };
const note = (step, data) => { report.steps.push({ step, ...data }); log(step, JSON.stringify(data)); };

const { connection, provider, program, payer } = await connect({ cluster: CLUSTER });
const employer = payer, employee = Keypair.generate(), passerby = Keypair.generate();
log("program", program.programId.toBase58(), "balance", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");
// the employee needs a little SOL to even try the transfer in step 8
{ const { SystemProgram } = await import("@solana/web3.js"); await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: employee.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL })), [payer]); }

// the statement: the real one when the XRPL agent produced it, else a faithful sample
const BULLETIN = join(here, "..", "..", "agent", "sortie", "bulletin.json");
const plain = existsSync(BULLETIN) ? readFileSync(BULLETIN) : Buffer.from(JSON.stringify({
  version: "dareskro/bulletin.v1", kind: "one-day fixed-term contract", shift: "Sunday 2026-10-25 09:00-19:00", convention: "IDCC 1996 art. 11",
  lines: [{ label: "Sunday duty, 10 h, coefficient 500", amount: "466.57" }], gross: "564.56", net: "440.35", tax_withheld: "33.03", paid: "407.32", currency: "EUR",
  employee: employee.publicKey.toBase58(), employer: employer.publicKey.toBase58(),
}, null, 2));
const statementSha = sha256(plain).toString("hex");
report.statement_source = existsSync(BULLETIN) ? "agent/sortie/bulletin.json" : "sample";

// ---- 1. the escrow, memo = statement sha256
const now = await chainNow(connection);
const e = await createEscrow(program, { owner: employer, destination: employee.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL, finishAfter: now + 3600, memos: [`sha256:${statementSha}`, "466.57 EUR"] });
note("1 escrow", { escrow: e.escrow, tx: explorerTx(e.signature, CLUSTER) });

// ---- 2. the employee's token first: it points at the record's address, known in advance
const statementAddr = statementAddress(e.escrow).toBase58();
const tok = await mintPayslipToken(connection, employer, { employee: employee.publicKey, statement: statementAddr, escrow: e.escrow, sha256_plain: statementSha });
note("2 payslip token (Token-2022, NonTransferable)", { mint: tok.mint, account: explorerAccount(tok.mint, CLUSTER), holder: employee.publicKey.toBase58(), points_at: statementAddr });

// ---- 3. seal for five readers and write it on chain, the token recorded in the record
const pub = initKeys(ROLES);
const sealed = sealStatement(plain, e.escrow, ROLES.map((role) => ({ role, key: Buffer.from(pub[role], "hex") })));
const onchain = await sealOnChain(program, { owner: employer, escrow: e.escrow, sealed, token: tok.mint });
let record = await fetchRecord(program, onchain.statement);
note("3 sealed on chain", { statement: onchain.statement, account: explorerAccount(onchain.statement, CLUSTER), plain_bytes: plain.length, ciphertext_bytes: sealed.ciphertext.length, chunks: onchain.signatures.length - 2, readers: record.readers.map((r) => r.role), sealed: record.sealed, token: record.token?.toBase58() ?? null, txs: onchain.signatures.map((s) => explorerTx(s, CLUSTER)) });

// ---- 4. each reader opens
const memoSha = (await getEscrow(program, e.escrow)).memos[0].replace("sha256:", "");
for (const role of ["employee", "urssaf", "retraite", "dgfip"]) {
  const key = unwrapAs(record, loadPrivate(role)); const p = openRecord(record, key);
  note(`4 ${role} opens`, { bytes: p.length, sha256_matches_escrow_memo: sha256(p).toString("hex") === memoSha, first_line: JSON.parse(p.toString("utf8")).lines?.[0]?.label ?? "(real statement)" });
}

// ---- 5. the public
note("5 what the public sees", publicView(record, onchain.statement));

// ---- 6. stranger and tampering
try { unwrapAs(record, generateKeyPairSync("x25519").privateKey); note("6a stranger", { opened: true }); } catch (err) { note("6a stranger with a fresh key", { refused: err.message }); }
{ const bad = { ...record, ciphertext: Buffer.from(record.ciphertext) }; bad.ciphertext[10] ^= 1;
  try { openRecord(bad, unwrapAs(record, loadPrivate("urssaf"))); note("6b tampered", { opened: true }); } catch (err) { note("6b tampered ciphertext", { refused: err.message.slice(0, 80) }); } }

// ---- 7. a reader added later, from the employer's wrapped copy
const agirc = generateKeyPairSync("x25519");
const contentKey = unwrapAs(record, loadPrivate("employer"));
const sig7 = await addReaderOnChain(program, { owner: employer, statement: onchain.statement, reader: wrapFor(contentKey, "agirc-arrco", rawPublic(agirc.publicKey)) });
record = await fetchRecord(program, onchain.statement);
note("7 add_reader agirc-arrco", { tx: explorerTx(sig7, CLUSTER), readers: record.readers.map((r) => r.role), agirc_opens: openRecord(record, unwrapAs(record, agirc.privateKey)).length + " bytes" });

// ---- 8. the token cannot move
{
  const mint = new PublicKey(tok.mint);
  const from = getAssociatedTokenAddressSync(mint, employee.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const to = getAssociatedTokenAddressSync(mint, passerby.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(employee.publicKey, to, passerby.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(from, mint, to, employee.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID));
  let refused = null; try { await provider.sendAndConfirm(tx, [employee]); } catch (err) { refused = String(err.message).match(/custom program error: (0x[0-9a-f]+)|Error Message: ([^\n]+)|(NonTransferable[^\n"]*)/i)?.[0] ?? String(err.message).split("\n")[0].slice(0, 120); }
  const bal = (await getAccount(connection, from, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString();
  const label = refused && /0x25/.test(refused) ? `${refused} = Token-2022 error 37, NonTransferable` : refused;
  note("8 employee tries to transfer the token", { refused: label, employee_still_holds: bal });
}
report.endedAt = new Date().toISOString();
writeFileSync(join(here, "compte_rendu_scelle.json"), JSON.stringify(report, null, 2));
log("written", join(here, "compte_rendu_scelle.json"));
