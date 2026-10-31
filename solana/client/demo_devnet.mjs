#!/usr/bin/env node
/**
 * dareskro on Solana, measured on devnet: the payroll shape and the conditional
 * shape, each refusal recorded on chain (sent without preflight, so the
 * explorer shows the refused attempt, as XRPL shows a tecNO_PERMISSION).
 *
 *   1. the employer locks the Sunday shift for the employee, FinishAfter +90 s,
 *      memos = statement SHA-256 + fiat line + oracle
 *   2. a passer-by finishes BEFORE the date          → TooEarly, recorded
 *   3. the employer cancels                          → NotCancellable, recorded
 *   4. a passer-by tries to redirect to themself     → WrongDestination, recorded
 *   5. after the date, the passer-by finishes         → paid to the employee
 *   6. a conditional escrow (delivery): wrong secret → WrongFulfillment; right secret → paid, secret public
 *   7. two escrows in one transaction, one unaffordable → nothing locked
 *
 * Usage: node demo_devnet.mjs            (the CLI key in ~/.config/solana/id.json pays, ~0.2 SOL)
 * Writes compte_rendu.json next to this file.
 */
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  connect, createEscrow, createInstruction, getEscrow, listEscrows, escrowAddress, sha256,
  explorerTx, explorerAccount, chainNow, sendRecorded, anchor, Keypair, PublicKey,
} from "./dareskro_solana.mjs";

const CLUSTER = process.env.CLUSTER || "devnet";
const DELAY = Number(process.env.FINISH_AFTER_S || 90);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const report = { cluster: CLUSTER, startedAt: new Date().toISOString(), steps: [] };
const note = (step, data) => { report.steps.push({ step, ...data }); log(step, JSON.stringify(data)); };

const { connection, provider, program, payer } = await connect({ cluster: CLUSTER });
log("program", program.programId.toBase58(), "payer", payer.publicKey.toBase58(), "balance", (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "SOL");
report.program = program.programId.toBase58();

// the parties: the employer is the CLI key; the employee and the passer-by are fresh
const employer = payer;
const employee = Keypair.generate();
const passerby = Keypair.generate();
const oracle = Keypair.generate();
{
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: passerby.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: oracle.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
  );
  await provider.sendAndConfirm(tx, [payer]);
}
report.parties = { employer: employer.publicKey.toBase58(), employee: employee.publicKey.toBase58(), passerby: passerby.publicKey.toBase58(), oracle: oracle.publicKey.toBase58() };

// ---- 1. payroll: the Sunday shift
const statement = sha256(Buffer.from("bulletin garde dimanche 466.57 EUR")).toString("hex");
const now = await chainNow(connection);
const finishAfter = now + DELAY;
const pay = Math.round(0.05 * LAMPORTS_PER_SOL);
const e1 = await createEscrow(program, {
  owner: employer, destination: employee.publicKey, lamports: pay, finishAfter,
  memos: [`sha256:${statement}`, "466.57 EUR", `dareskro/oracle:${oracle.publicKey.toBase58()}`],
});
note("1 create payroll", { ...e1, finishAfter: new Date(finishAfter * 1000).toISOString(), lamports: pay, tx: explorerTx(e1.signature, CLUSTER), account: explorerAccount(e1.escrow, CLUSTER) });

// ---- 2. a passer-by, before the date
const esc1 = new PublicKey(e1.escrow);
let r = await sendRecorded(provider, program.methods.finish(null).accountsPartial({ caller: passerby.publicKey, escrow: esc1, destination: employee.publicKey }), [passerby]);
note("2 finish by passer-by BEFORE the date", { code: r.code, message: r.message, tx: explorerTx(r.signature, CLUSTER) });

// ---- 3. the employer wants it back
r = await sendRecorded(provider, program.methods.cancel().accountsPartial({ caller: employer.publicKey, escrow: esc1, ownerAccount: employer.publicKey }), [employer]);
note("3 cancel by the employer", { code: r.code, message: r.message, tx: explorerTx(r.signature, CLUSTER) });

// ---- 4. redirect attempt
r = await sendRecorded(provider, program.methods.finish(null).accountsPartial({ caller: passerby.publicKey, escrow: esc1, destination: passerby.publicKey }), [passerby]);
note("4 finish to another destination", { code: r.code, message: r.message, tx: explorerTx(r.signature, CLUSTER) });

// ---- 6. (while waiting) the conditional shape
const secret = randomBytes(32);
const e2 = await createEscrow(program, {
  owner: employer, destination: employee.publicKey, lamports: Math.round(0.02 * LAMPORTS_PER_SOL),
  condition: sha256(secret).toString("hex"), cancelAfter: now + 3600, memos: ["delivery: url + sha256"],
});
note("6a create conditional", { ...e2, tx: explorerTx(e2.signature, CLUSTER) });
const esc2 = new PublicKey(e2.escrow);
r = await sendRecorded(provider, program.methods.finish(randomBytes(32)).accountsPartial({ caller: oracle.publicKey, escrow: esc2, destination: employee.publicKey }), [oracle]);
note("6b finish with a WRONG secret", { code: r.code, message: r.message, tx: explorerTx(r.signature, CLUSTER) });
r = await sendRecorded(provider, program.methods.finish(secret).accountsPartial({ caller: oracle.publicKey, escrow: esc2, destination: employee.publicKey }), [oracle]);
const e2after = await getEscrow(program, esc2);
note("6c finish with the RIGHT secret", { err: r.err, tx: explorerTx(r.signature, CLUSTER), status: e2after.status, fulfillmentOnChain: e2after.fulfillment === secret.toString("hex") });

// ---- 7. batch: all or nothing
{
  const a = await createInstruction(program, { owner: employer.publicKey, destination: employee.publicKey, lamports: 1000, finishAfter: now + 3600, id: Date.now() + 1 });
  const b = await createInstruction(program, { owner: employer.publicKey, destination: employee.publicKey, lamports: 10_000 * LAMPORTS_PER_SOL, finishAfter: now + 3600, id: Date.now() + 2 });
  const tx = new Transaction().add(a.ix, b.ix);
  let failed = null;
  try { await provider.sendAndConfirm(tx, [employer]); } catch (err) { failed = String(err.message).split("\n")[0].slice(0, 160); }
  const firstExists = (await connection.getAccountInfo(new PublicKey(a.escrow))) !== null;
  note("7 batch with one unaffordable line", { failed, firstLineLocked: firstExists });
}

// ---- 5. after the date
const wait = finishAfter - (await chainNow(connection)) + 5;
if (wait > 0) { log(`waiting ${wait} s for the cluster clock…`); await sleep(wait * 1000); }
const before = await connection.getBalance(employee.publicKey);
r = await sendRecorded(provider, program.methods.finish(null).accountsPartial({ caller: passerby.publicKey, escrow: esc1, destination: employee.publicKey }), [passerby]);
const after = await connection.getBalance(employee.publicKey);
const e1after = await getEscrow(program, esc1);
note("5 finish by passer-by AFTER the date", { err: r.err, tx: explorerTx(r.signature, CLUSTER), employeeCredited: (after - before) / LAMPORTS_PER_SOL, status: e1after.status, closedBy: e1after.closedBy });

report.registry = await listEscrows(program, { owner: employer.publicKey });
report.endedAt = new Date().toISOString();
writeFileSync(join(here, "compte_rendu.json"), JSON.stringify(report, null, 2));
log("written", join(here, "compte_rendu.json"));
