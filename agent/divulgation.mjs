#!/usr/bin/env node
// dareskro — who can read the sealed pay statement, and what the public sees instead.
//
//   node agent/divulgation.mjs --role administration|employee [--escrow <hash>] [--offline]
//       unwraps with that role's private key, decrypts, recomputes the hash, compares it
//       with the escrow memo on testnet, prints the statement.
//   node agent/divulgation.mjs --role public [--escrow <hash>] [--offline]
//       prints only what anyone sees (file sizes, hashes, on-chain facts), shows that the
//       content key cannot be unwrapped without a private key, and says what the memos give
//       away: a memo naming the coefficient or the date is a privacy FAIL, whoever wrote it.
//
// Without --escrow, the hash recorded in bulletin.chiffre.json is used when there is one.
// --offline skips testnet: the statement is read, the binding is reported as not checked.
// Exit 0 ok, 1 mismatch, decryption failure or privacy leak, 2 usage.

import { createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  CHIFFRE, ROLES, UsageError, arg, decodeMemos, decryptStatement, empreinte, fetchTx, fmtBytes,
  keyPath, leaks, loadPrivateKey, memoFiat, memoHash, normHash, rel, rippleDate, unb64, unwrapKey, xrp,
} from "./confidentiel.mjs";

const fail = (msg) => { console.error(msg); process.exit(1); };
const offline = process.argv.includes("--offline");

function fileFacts(file) {
  console.log(`what anyone sees in ${rel(CHIFFRE)}:`);
  console.log(`  version       ${file.version}`);
  console.log(`  sha256_plain  ${file.sha256_plain}`);
  console.log(`  escrow        ${file.escrow ?? "(not bound)"}`);
  console.log(`  ciphertext    ${fmtBytes(unb64(file.ciphertext).length)}, opaque${file.padding ? ` (${file.padding})` : ""}`);
  console.log(`  zk opening    ${file.zk?.opening ? `${fmtBytes(unb64(file.zk.opening.ciphertext).length)}, opaque; commitment ${file.zk.commitment.slice(0, 18)}... (public already)` : "none"}`);
  console.log(`  recipients    ${Object.keys(file.recipients).join(", ")} (wrapped content key each)`);
}

// Prints the escrow as anyone can read it and returns the memos. Exits 1 if it is not a validated EscrowCreate.
async function chainFacts(escrow) {
  let fetched;
  try { fetched = await fetchTx(escrow); } catch (e) { fail(`${e.message}; --offline reads the file without it`); }
  const { tx, validated, ms } = fetched;
  if (tx.TransactionType !== "EscrowCreate" || !validated) fail(`${escrow} is not a validated EscrowCreate on testnet`);
  const memos = decodeMemos(tx);
  console.log(`what anyone sees on testnet, EscrowCreate ${escrow} (${ms} ms):`);
  console.log(`  from          ${tx.Account}`);
  console.log(`  to            ${tx.Destination}`);
  console.log(`  amount        ${xrp(tx.Amount)}  (public: the XRP amount is never hidden on an escrow)`);
  console.log(`  payable at    ${rippleDate(tx.FinishAfter)}`);
  for (const m of memos) console.log(`  memo          ${m.type.padEnd(26)} ${m.data}`);
  return memos;
}

// What the memos give away. The statement-id memo of the shipped escrow names the coefficient
// and the date: written by the pay desk from bulletin.statement_id, not by this layer, but the
// public sees it, so this tool says so instead of claiming the hours are sealed.
function reportLeaks(memos) {
  const found = leaks(memos);
  for (const l of found) console.log(`  LEAK          memo ${l.memo} reveals ${l.reveals} (${l.value}): the pay desk must write an opaque statement id (app/src/xrpl.ts), not this layer`);
  return found.length === 0;
}

function printStatement(b) {
  console.log("--- statement (sealed for the public, open for this role) ---");
  console.log(`  employee  ${b.employee?.label}  (badge ${b.employee?.badge})`);
  console.log(`  period    ${b.period}, ${b.evidence?.schedule?.date} ${b.evidence?.schedule?.slot}, ${b.evidence?.schedule?.type}`);
  for (const l of b.lines ?? []) console.log(`  ${l.item.padEnd(28)} ${String(l.amount).padStart(8)}`);
  console.log(`  ${"gross".padEnd(28)} ${String(b.total).padStart(8)} ${b.currency}${b.contract?.fixed_term ? `  (${b.contract.type})` : ""}`);
  if (b.contributions) {
    const c = b.contributions;
    console.log(`  ${"employee contributions".padEnd(28)} ${("-" + c.employee.amount).padStart(8)} ${b.currency}  (${Number(c.employee.rate) * 100} %)`);
    console.log(`  ${"NET TO PAY".padEnd(28)} ${String(b.net_to_pay).padStart(8)} ${b.currency}  -> the employee's escrow`);
    console.log(`  ${"employer contributions".padEnd(28)} ${String(c.employer.amount).padStart(8)} ${b.currency}  (${Number(c.employer.rate) * 100} %)`);
    console.log(`  ${("to " + c.recipient).padEnd(28)} ${String(c.total_to_urssaf).padStart(8)} ${b.currency}  -> the contributions escrow, due ${c.due}`);
  }
  console.log(`  status    ${b.status}, computed by ${b.computed_by}`);
}

async function asPublic(file, escrow) {
  fileFacts(file);
  let ok = true;
  if (escrow && !offline) {
    const memos = await chainFacts(escrow);
    const mh = memoHash(memos);
    if (mh === file.sha256_plain) console.log(`  => the escrow cites the same statement hash as the sealed file: same statement, content unreadable`);
    else { console.log(`  => escrow memo ${mh} differs from the sealed file ${file.sha256_plain}: MISMATCH`); ok = false; }
    if (!reportLeaks(memos)) ok = false;
  } else if (escrow) console.log(`  escrow ${escrow}: not fetched (--offline), binding and memos not checked`);
  console.log("what the public cannot do: open it.");
  // No private key: the best anyone can do is guess a key. GCM refuses, as it must.
  const block = file.recipients[ROLES[0]];
  try {
    const d = createDecipheriv("aes-256-gcm", randomBytes(32), unb64(block.iv), { authTagLength: 16 });
    d.setAuthTag(unb64(block.tag));
    d.update(unb64(block.wrapped)); d.final();
    console.log("  unexpected: a random key unwrapped the content key"); ok = false;
  } catch (e) {
    console.log(`  tried to unwrap the ${ROLES[0]} block with a random key: refused ("${e.message}")`);
  }
  console.log("  the two private keys are the only way in: who worked, how many hours, which lines stay sealed in the file.");
  console.log(ok ? "RESULT: OK, the file and the escrow show the public nothing private" : "RESULT: FAIL, the public learns more than the sealed file lets out");
  process.exit(ok ? 0 : 1);
}

async function asRole(role, file, escrow) {
  if (!existsSync(keyPath(role))) throw new UsageError(`no private key for "${role}" at ${rel(keyPath(role))}: run node agent/confidentiel.mjs --init`);
  const t0 = performance.now();
  let plain;
  try {
    const contentKey = unwrapKey(file.recipients[role], loadPrivateKey(role));
    plain = decryptStatement(file, contentKey);
    contentKey.fill(0);
  } catch (e) {
    fail(`role ${role}: decryption failed, the GCM tag does not authenticate (tampered file or wrong key): ${e.message}`);
  }
  const ms = (performance.now() - t0).toFixed(1);
  const bulletin = JSON.parse(plain.toString("utf8"));
  const sha = empreinte(bulletin);
  console.log(`role ${role}: unwrapped with ${rel(keyPath(role))}, decrypted ${fmtBytes(plain.toString("utf8").trimEnd().length)} (+ padding) in ${ms} ms`);
  console.log(`  recomputed sha256 ${sha}`);
  let ok = true;
  if (sha !== file.sha256_plain || sha !== bulletin.sha256) {
    console.log(`  MISMATCH: file says ${file.sha256_plain}, statement field says ${bulletin.sha256}`); ok = false;
  } else console.log("  = sha256_plain of the sealed file = sha256 field of the statement");

  if (escrow && !offline) {
    const memos = await chainFacts(escrow);
    const mh = memoHash(memos);
    const bound = mh === sha;
    console.log(`  bound to escrow ${escrow}: ${bound ? "MATCH" : `MISMATCH (memo ${mh})`}`);
    if (!bound) ok = false;
    const fiat = memoFiat(memos);
    if (fiat) {
      // The escrow holds the net when the statement carries contributions (the gross goes to the
      // proof, the contributions to URSSAF's escrow): "440.35 USD @ 1.28865 ..." must agree with it.
      const expected = bulletin.net_to_pay ?? bulletin.total;
      const same = fiat.startsWith(`${expected} ${bulletin.currency} `);
      console.log(`  memo dareskro/fiat "${fiat}" vs statement ${bulletin.net_to_pay ? "net to pay" : "total"} ${expected} ${bulletin.currency}: ${same ? "MATCH" : "MISMATCH"}`);
      if (!same) ok = false;
      const gross = memos.find((m) => m.type === "dareskro/gross")?.data;
      if (gross) {
        const sameGross = gross.startsWith(`gross=${bulletin.total};net=${expected};`);
        console.log(`  memo dareskro/gross "${gross}" vs statement gross ${bulletin.total} and net ${expected}: ${sameGross ? "MATCH" : "MISMATCH"}`);
        if (!sameGross) ok = false;
      }
    }
  } else if (escrow) console.log(`  escrow ${escrow}: binding not checked (--offline)`);
  if (file.zk?.opening) console.log(`  zk opening sealed under the same key: node zk/ouvrir.mjs --role ${role} recomputes the commitment ${file.zk.commitment.slice(0, 18)}...`);
  printStatement(bulletin);
  process.exit(ok ? 0 : 1);
}

function usage(code) {
  console.error("usage: node agent/divulgation.mjs --role administration|employee|public [--escrow <EscrowCreate hash>] [--offline]");
  process.exit(code);
}

try {
  const role = arg("--role");
  if (!role || ![...ROLES, "public"].includes(role)) usage(2);
  if (!existsSync(CHIFFRE)) throw new UsageError(`${rel(CHIFFRE)} missing: run node agent/confidentiel.mjs --chiffre`);
  const file = JSON.parse(readFileSync(CHIFFRE, "utf8"));
  const escrow = normHash(arg("--escrow")) ?? file.escrow ?? null;
  if (role === "public") await asPublic(file, escrow);
  else await asRole(role, file, escrow);
} catch (e) {
  console.error(e instanceof UsageError ? `usage: ${e.message}` : e.message);
  process.exit(e instanceof UsageError ? 2 : 1);
}
