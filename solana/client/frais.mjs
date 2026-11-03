#!/usr/bin/env node
/**
 * The fee per act, on Solana (the counterpart of near/frais_near.mjs).
 *   node frais.mjs show                      the schedule, the till, the ceilings
 *   node frais.mjs init [adminPubkey]        once, by the program's upgrade authority (the CLI wallet); starts at zero
 *   node frais.mjs set <bps> <floorSol>      the administrator sets the schedule (≤ 100 bps, ≤ 0.01 SOL)
 *   node frais.mjs admin <newAdminPubkey>    hand the role over
 *   node frais.mjs withdraw                  everything charged so far, to the administrator
 *   node frais.mjs measure                   the scenario of the README: refusals, a schedule, an act charged, withdrawn, back down; frais.log + frais.json
 * Signer: SOLANA_KEYPAIR or ~/.config/solana/id.json. Cluster: SOLANA_CLUSTER (devnet).
 */
import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, loadKeypair, Keypair, PublicKey, anchor, explorerTx, explorerAccount, createEscrow, chainNow, getFeeConfig, feeConfigAddress, feeFor, LAMPORTS, PROGRAM_ID } from "./dareskro_solana.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "sortie");
const [cmd, ...a] = process.argv.slice(2);
const cluster = process.env.SOLANA_CLUSTER || "devnet";
const signer = process.env.SOLANA_KEYPAIR ? loadKeypair(process.env.SOLANA_KEYPAIR) : loadKeypair();
const { program, connection } = await connect({ cluster, keypair: signer });
const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];

const show = async () => { const c = await getFeeConfig(program); console.log(JSON.stringify(c ?? { address: feeConfigAddress().toBase58(), note: "not created yet: node frais.mjs init" }, null, 2)); return c; };
const init = (admin) => program.methods.configInit(new PublicKey(admin)).accountsPartial({ authority: signer.publicKey, program: PROGRAM_ID, programData }).signers([signer]).rpc();
const setFee = (who, bps, floorSol) => program.methods.setFee(Number(bps), new anchor.BN(Math.round(Number(floorSol) * LAMPORTS))).accountsPartial({ admin: who.publicKey }).signers([who]).rpc();
const withdraw = (who) => program.methods.withdrawFees().accountsPartial({ admin: who.publicKey }).signers([who]).rpc();
const codeOf = (e) => e?.error?.errorCode?.code ?? (String(e.message).match(/Error Code: (\w+)/) || [])[1] ?? String(e.message).slice(0, 120);

if (cmd === "show") await show();
else if (cmd === "init") { const sig = await init(a[0] ?? signer.publicKey); console.log(`schedule created, administrator ${a[0] ?? signer.publicKey.toBase58()} — ${explorerTx(sig, cluster)}`); await show(); }
else if (cmd === "set") { const sig = await setFee(signer, a[0], a[1]); console.log(`schedule: ${a[0]} bps, floor ${a[1]} SOL — ${explorerTx(sig, cluster)}`); await show(); }
else if (cmd === "admin") { const sig = await program.methods.setAdmin(new PublicKey(a[0])).accountsPartial({ admin: signer.publicKey }).signers([signer]).rpc(); console.log(`administrator is now ${a[0]} — ${explorerTx(sig, cluster)}`); await show(); }
else if (cmd === "withdraw") { const sig = await withdraw(signer); console.log(`withdrawn — ${explorerTx(sig, cluster)}`); await show(); }
else if (cmd === "measure") {
  if (!existsSync(OUT)) mkdirSync(OUT);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const LOG = join(OUT, "frais.log"), rows = [];
  const line = (step, text, sig) => { const r = { at: new Date().toISOString().slice(11, 19), step, text, tx: sig ? explorerTx(sig, cluster) : null }; rows.push(r); const s = `${r.at} | ${step} ${text}${sig ? ` | ${r.tx}` : ""}`; console.log(s); appendFileSync(LOG, s + "\n"); };
  const state = async () => { const c = await getFeeConfig(program); return `${c.feeBps} bps / floor ${c.feeMinSol.toFixed(4)} SOL, held ${c.feesHeldSol.toFixed(4)}, total ${c.feesTotalSol.toFixed(4)}, ${c.actsCharged} act(s) charged; ceiling ${c.ceiling.bps} bps / ${c.ceiling.minSol} SOL`; };
  appendFileSync(LOG, `\n== ${new Date().toISOString()} cluster ${cluster} program ${PROGRAM_ID.toBase58()} signer ${signer.publicKey.toBase58()}\n`);
  let c = await getFeeConfig(program);
  if (!c) { const sig = await init(signer.publicKey); line("0", `schedule created by the upgrade authority, administrator ${signer.publicKey.toBase58()}`, sig); c = await getFeeConfig(program); }
  line("1", `schedule ${c.address}: administrator ${c.admin}, ${await state()}`);
  const before = { bps: c.feeBps, floorSol: c.feeMinSol };
  // a stranger, funded with the gas of a few refusals
  const stranger = Keypair.generate();
  { const tx = new anchor.web3.Transaction().add(anchor.web3.SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: stranger.publicKey, lamports: 0.01 * LAMPORTS })); await anchor.web3.sendAndConfirmTransaction(connection, tx, [signer]); }
  try { await setFee(stranger, 10, 0); line("2a", "stranger set_fee → ACCEPTED (bug)"); } catch (e) { line("2a", `stranger set_fee → refused: ${codeOf(e)}`); }
  try { await setFee(signer, 101, 0); line("2b", "administrator above the ceiling → ACCEPTED (bug)"); } catch (e) { line("2b", `administrator at 101 bps → refused: ${codeOf(e)}`); }
  try { await setFee(signer, 0, 0.0101); line("2b'", "floor above the ceiling → ACCEPTED (bug)"); } catch (e) { line("2b'", `administrator with a floor of 0.0101 SOL → refused: ${codeOf(e)}`); }
  let sig = await setFee(signer, 50, 0.001); line("2c", `administrator ${signer.publicKey.toBase58()} sets 50 bps (0.5 %) with a floor of 0.001 SOL`, sig);
  c = await getFeeConfig(program);
  // an act under the schedule: 0.05 SOL locked → 0.5 % = 0.00025 < floor → the floor; the destination's amount untouched
  const now = await chainNow(connection);
  const lamports = 0.05 * LAMPORTS, expected = feeFor(c, lamports);
  const b0 = await connection.getBalance(signer.publicKey);
  const created = await createEscrow(program, { owner: signer, destination: signer.publicKey, lamports, finishAfter: now + 60, cancelAfter: null, condition: null, memos: ["fee per act, measured"] });
  const b1 = await connection.getBalance(signer.publicKey);
  const escBal = await connection.getBalance(new PublicKey(created.escrow));
  const paidFee = b0 - b1 - escBal - 5000;
  const on = await program.account.escrow.fetch(new PublicKey(created.escrow));
  line("3", `escrow ${created.escrow} with the schedule: ${(lamports / LAMPORTS).toFixed(4)} SOL locked for the destination (on chain: ${on.amount.toNumber() / LAMPORTS}), the owner paid ${(paidFee / LAMPORTS).toFixed(5)} SOL of fee on top (expected ${(expected / LAMPORTS).toFixed(5)}: 0.5 % is under the floor) + rent + signature`, created.signature);
  line("4", `till: ${await state()}`);
  try { await withdraw(stranger); line("5a", "stranger withdraw_fees → ACCEPTED (bug)"); } catch (e) { line("5a", `stranger withdraw_fees → refused: ${codeOf(e)}`); }
  const w0 = await connection.getBalance(signer.publicKey);
  sig = await withdraw(signer);
  const w1 = await connection.getBalance(signer.publicKey);
  line("5b", `administrator withdraws: ${(w0 / LAMPORTS).toFixed(4)} → ${(w1 / LAMPORTS).toFixed(4)} SOL (+${((w1 - w0) / LAMPORTS).toFixed(5)} after the signature); ${await state()}`, sig);
  sig = await setFee(signer, before.bps, before.floorSol);
  line("6", `schedule back to ${before.bps} bps / ${before.floorSol} SOL; ${await state()}`, sig);
  writeFileSync(join(OUT, `frais_${stamp}.json`), JSON.stringify({ cluster, program: PROGRAM_ID.toBase58(), schedule: feeConfigAddress().toBase58(), scheduleExplorer: explorerAccount(feeConfigAddress().toBase58(), cluster), rows }, null, 2));
  console.log(`\n${rows.length} lines → ${LOG}`);
} else { console.error("usage: show | init [admin] | set <bps> <floorSol> | admin <pubkey> | withdraw | measure"); process.exit(2); }
