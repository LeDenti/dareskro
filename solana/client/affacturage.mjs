#!/usr/bin/env node
/**
 * The invoice advance on Solana — the pool of `facture/` (XRPL, 1 November) replayed against
 * the program, with the ceilings held by the program instead of by a signer.
 *   node affacturage.mjs measure      the scenario of the README on devnet: pool 2-of-3 (AI seat, risk policy,
 *                                     operator), two lenders, F-001 advanced, F-002 refused by the program with two
 *                                     valid signatures, F-003 defaulted then bought back, the lenders leave;
 *                                     affacturage.log + affacturage_<stamp>.json in client/sortie/
 *   node affacturage.mjs show <pool>  the pool account and its advances
 * The three seats and the parties are throwaway keys written to client/cles/affacturage/ (gitignored), funded from the
 * CLI wallet (SOLANA_KEYPAIR or ~/.config/solana/id.json). Cluster: SOLANA_CLUSTER (devnet).
 * The invoice fingerprints are those of facture/pieces (facture/facture.mjs, `empreinte`): the same SHA-256 the XRPL
 * version anchors with AccountSet.
 */
import { appendFileSync, writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, loadKeypair, Keypair, PublicKey, anchor, explorerTx, explorerAccount, chainNow, getFeeConfig, feeConfigAddress, LAMPORTS, PROGRAM_ID, sha256 } from "./dareskro_solana.mjs";
import { SystemProgram, Transaction } from "@solana/web3.js";
import { dossierFacture, empreinte } from "../../facture/facture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "sortie");
const KEYS = join(HERE, "cles", "affacturage");
const PIECES = join(HERE, "..", "..", "facture", "pieces");
const [cmd, ...a] = process.argv.slice(2);
const cluster = process.env.SOLANA_CLUSTER || "devnet";
const wallet = process.env.SOLANA_KEYPAIR ? loadKeypair(process.env.SOLANA_KEYPAIR) : loadKeypair();
const { program, connection } = await connect({ cluster, keypair: wallet });
const U = 10_000_000; // 0.01 SOL: the unit of the XRPL run (pool 160, advances 45 / 54 / 36)
const BN = anchor.BN;
const codeOf = (e) => e?.error?.errorCode?.code ?? (String(e.message).match(/Error Code: (\w+)/) || [])[1] ?? String(e.message).slice(0, 160);
const short = (k) => `${k.toBase58().slice(0, 6)}…`;

function keyAt(name) {
  if (!existsSync(KEYS)) mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const f = join(KEYS, `${name}.json`);
  if (existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8"))));
  const k = Keypair.generate();
  writeFileSync(f, JSON.stringify([...k.secretKey]), { mode: 0o600 });
  return k;
}
async function topUp(keys, sol) {
  const tx = new Transaction();
  for (const k of keys) {
    const have = await connection.getBalance(k.publicKey);
    const want = Math.round(sol * LAMPORTS);
    if (have < want) tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: k.publicKey, lamports: want - have }));
  }
  if (tx.instructions.length) await program.provider.sendAndConfirm(tx, [wallet]);
}
const poolAddress = (operator, id) => PublicKey.findProgramAddressSync([Buffer.from("pool"), operator.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
const advanceAddress = (pool, invoice) => PublicKey.findProgramAddressSync([Buffer.from("advance"), pool.toBuffer(), invoice], PROGRAM_ID)[0];
const statusName = (s) => Object.keys(s)[0];

/** the dossier of facture/pieces/<name>.txt, canonicalised as the XRPL version does, and its fingerprint */
function invoice(name, { supplier, debtor, pool, montant, avance, fraisPct, echeance }) {
  const file = join(PIECES, `${name}.txt`);
  const piece = { nom: `${name}.txt`, sha256: sha256(readFileSync(file)).toString("hex") };
  const d = dossierFacture({
    id: name, fournisseur: { nom: "Fournisseur SAS", adresse: supplier.toBase58() }, client: { nom: "Client SA", adresse: debtor.toBase58() },
    montant: String(montant), unite: "SOL×0.01", emission: "2026-11-05", echeance, pieces: [piece], tauxAvance: avance / montant, fraisPct, pool: pool.toBase58(),
  });
  return { dossier: d, hash: Buffer.from(empreinte(d), "hex") };
}

if (cmd === "show") {
  const pool = new PublicKey(a[0]);
  const P = await program.account.pool.fetch(pool);
  console.log(JSON.stringify({ pool: pool.toBase58(), operator: P.operator.toBase58(), signers: P.signers.map((k) => k.toBase58()), threshold: P.threshold, policy: { maxShareBps: P.policy.maxShareBps, maxAdvanceBps: P.policy.maxAdvanceBps, maxTermS: P.policy.maxTerm.toNumber(), graceS: P.policy.grace.toNumber() }, capitalSol: P.capital.toNumber() / LAMPORTS, depositsSol: P.deposits.toNumber() / LAMPORTS, outstandingSol: P.outstanding.toNumber() / LAMPORTS, lossesSol: P.losses.toNumber() / LAMPORTS, feesEarnedSol: P.feesEarned.toNumber() / LAMPORTS, advancesFunded: P.advancesFunded.toNumber(), lenders: P.lenders.map((l) => ({ key: l.key.toBase58(), sol: l.amount.toNumber() / LAMPORTS })), exposures: P.exposures.map((e) => ({ debtor: e.debtor.toBase58(), owedSol: e.owed.toNumber() / LAMPORTS })) }, null, 2));
  const advances = await program.account.advance.all([{ memcmp: { offset: 8, bytes: pool.toBase58() } }]);
  for (const { publicKey, account: A } of advances) console.log(`advance ${publicKey.toBase58()} invoice ${Buffer.from(A.invoice).toString("hex").slice(0, 12)}… ${statusName(A.status)} face ${A.face.toNumber() / U} advance ${A.advance.toNumber() / U} fee ${A.fee.toNumber() / U} repaid ${A.repaid.toNumber() / U} approvals ${A.approvals.length}`);
} else if (cmd === "leave") {
  const pool = new PublicKey(a[0]);
  for (const name of ["preteur-A", "preteur-B"]) {
    const k = keyAt(name);
    try { const sig = await program.methods.poolWithdraw().accountsPartial({ lender: k.publicKey, pool }).signers([k]).rpc(); console.log(`${name} left ${pool.toBase58()} — ${explorerTx(sig, cluster)}`); }
    catch (e) { console.log(`${name}: ${codeOf(e)}`); }
  }
} else if (cmd === "measure") {
  if (!existsSync(OUT)) mkdirSync(OUT);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const LOG = join(OUT, "affacturage.log"), rows = [];
  const line = (step, text, sig) => { const r = { at: new Date().toISOString().slice(11, 19), step, text, tx: sig ? explorerTx(sig, cluster) : null }; rows.push(r); const s = `${r.at} | ${step} ${text}${sig ? ` | ${r.tx}` : ""}`; console.log(s); appendFileSync(LOG, s + "\n"); };
  const refused = async (label, p) => { try { await p; line("✗", `${label}: PASSED, it should not have`); return "passed"; } catch (e) { const c = codeOf(e); line("·", `${label}: refused — ${c}`); return c; } };

  const ia = keyAt("siege-ia"), policy = keyAt("politique"), operator = keyAt("operateur");
  const lenderA = keyAt("preteur-A"), lenderB = keyAt("preteur-B");
  const supplier = keyAt("fournisseur"), d1 = keyAt("debiteur-1"), d2 = keyAt("debiteur-2"), d3 = keyAt("debiteur-3");
  const stranger = keyAt("passant");
  await topUp([ia, policy, operator, stranger], 0.05);
  await topUp([lenderA, lenderB], 0.9);
  await topUp([d1, d3, supplier], 0.6);
  const cfg = await getFeeConfig(program);
  line(0, `program ${PROGRAM_ID.toBase58()} on ${cluster}; fee per act ${cfg ? `${cfg.feeBps} bps, floor ${cfg.feeMinLamports / LAMPORTS} SOL` : "none"}; seats: AI ${short(ia.publicKey)}, policy ${short(policy.publicKey)}, operator ${short(operator.publicKey)}; lenders A ${short(lenderA.publicKey)}, B ${short(lenderB.publicKey)}; unit = 0.01 SOL`);

  // the pool: 2 of 3, 30 % per debtor, 90 % of the face, 90 days, grace 20 s (the demo's)
  const id = new BN(Date.now());
  const pool = poolAddress(operator.publicKey, id);
  const pol = { maxShareBps: 3000, maxAdvanceBps: 9000, maxTerm: new BN(90 * 86400), grace: new BN(20) };
  let sig = await program.methods.poolCreate(id, [ia.publicKey, policy.publicKey, operator.publicKey], 2, pol).accountsPartial({ operator: operator.publicKey }).signers([operator]).rpc();
  line(1, `pool ${pool.toBase58()} created: 2 of 3, one debtor ≤ 30 % of the capital, advance ≤ 90 % of the face, term ≤ 90 d, grace 20 s — ${explorerAccount(pool, cluster)}`, sig);
  const deposit = (who, n) => program.methods.poolDeposit(new BN(n * U)).accountsPartial({ lender: who.publicKey, pool }).signers([who]).rpc();
  sig = await deposit(lenderA, 80); line("2a", `lender A deposits 80 (0.8 SOL)`, sig);
  sig = await deposit(lenderB, 80); line("2b", `lender B deposits 80 — capital 160`, sig);

  const now = await chainNow(connection);
  const propose = (who, inv, debtor, face, adv, fee, due) => program.methods.advancePropose([...inv.hash], supplier.publicKey, debtor, new BN(face * U), new BN(adv * U), new BN(fee * U), new BN(due)).accountsPartial({ signer: who.publicKey, pool, advance: advanceAddress(pool, inv.hash) }).signers([who]).rpc();
  const approve = (who, inv) => program.methods.advanceApprove().accountsPartial({ signer: who.publicKey, pool, advance: advanceAddress(pool, inv.hash), supplier: supplier.publicKey, config: feeConfigAddress() }).signers([who]).rpc();
  const repay = (who, inv, n) => program.methods.advanceRepay(new BN(n * U)).accountsPartial({ payer: who.publicKey, pool, advance: advanceAddress(pool, inv.hash), supplier: supplier.publicKey }).signers([who]).rpc();
  const dflt = (who, inv) => program.methods.advanceDefault().accountsPartial({ signer: who.publicKey, pool, advance: advanceAddress(pool, inv.hash) }).signers([who]).rpc();
  const buyback = (who, inv) => program.methods.advanceBuyback().accountsPartial({ payer: who.publicKey, pool, advance: advanceAddress(pool, inv.hash) }).signers([who]).rpc();
  const withdraw = (who) => program.methods.poolWithdraw().accountsPartial({ lender: who.publicKey, pool }).signers([who]).rpc();
  const closeAdv = (inv) => program.methods.advanceClose().accountsPartial({ operator: operator.publicKey, pool, advance: advanceAddress(pool, inv.hash) }).signers([operator]).rpc();
  const book = async () => { const P = await program.account.pool.fetch(pool); return `capital ${P.capital.toNumber() / U}, outstanding ${P.outstanding.toNumber() / U}, losses ${P.losses.toNumber() / U}, fees earned ${P.feesEarned.toNumber() / U}, exposures ${P.exposures.map((e) => `${short(e.debtor)} ${e.owed.toNumber() / U}`).join(" ") || "none"}`; };
  const bal = async (k) => (await connection.getBalance(k.publicKey)) / LAMPORTS;

  // F-001: 50 due in 30 days, 45 advanced, fee 1 — the AI seat proposes, the risk policy approves
  const f1 = invoice("F-2026-001", { supplier: supplier.publicKey, debtor: d1.publicKey, pool, montant: 50, avance: 45, fraisPct: 2, echeance: "2026-12-05" });
  await refused("a stranger proposes F-001", propose(stranger, f1, d1.publicKey, 50, 45, 1, now + 30 * 86400));
  sig = await propose(ia, f1, d1.publicKey, 50, 45, 1, now + 30 * 86400);
  line(3, `F-001 (dossier ${f1.hash.toString("hex").slice(0, 12)}…): 50 due, 45 asked, fee 1 — proposed by the AI seat, 1 of 2`, sig);
  await refused("the AI seat approves its own proposal again", approve(ia, f1));
  await refused("a stranger approves", approve(stranger, f1));
  const s0 = await bal(supplier);
  sig = await approve(policy, f1);
  line(4, `F-001 approved by the risk policy: 2 of 2, the supplier receives 45 (${s0.toFixed(3)} → ${(await bal(supplier)).toFixed(3)} SOL); the act fee ${cfg ? cfg.feeMinLamports / LAMPORTS : 0} SOL left the pool — ${await book()}`, sig);

  // F-002: 60 due, 54 advanced to a second debtor: 54 / 160 = 33.75 % > 30 %. On XRPL (1 November) the
  // AI seat + the operator passed it, tesSUCCESS: the ledger knew no cap. Here the program holds it.
  const f2 = invoice("F-2026-002", { supplier: supplier.publicKey, debtor: d2.publicKey, pool, montant: 60, avance: 54, fraisPct: 0, echeance: "2026-12-20" });
  sig = await propose(ia, f2, d2.publicKey, 60, 54, 0, now + 45 * 86400);
  line(5, `F-002: 60 due, 54 asked for a second debtor — 54 / 160 = 33.75 % of the capital, above the 30 % cap; proposed by the AI seat`, sig);
  const c1 = await refused("the operator approves F-002 (AI + operator = 2 of 3, as on XRPL)", approve(operator, f2));
  const c2 = await refused("the risk policy approves F-002 as well (3 of 3)", approve(policy, f2));
  const A2 = await program.account.advance.fetch(advanceAddress(pool, f2.hash));
  line(6, `F-002 stays ${statusName(A2.status)} with ${A2.approvals.length} approval recorded: the signatures were valid, the program refused (${c1}, ${c2}) — on XRPL the same two signatures paid`);

  // F-003: 40 due in 25 s, 36 advanced, fee 1 — funded (37 / 160 = 23 %), then paid 10 and left there
  const dueF3 = (await chainNow(connection)) + 25;
  const f3 = invoice("F-2026-003", { supplier: supplier.publicKey, debtor: d3.publicKey, pool, montant: 40, avance: 36, fraisPct: 2.5, echeance: "2026-11-06" });
  sig = await propose(operator, f3, d3.publicKey, 40, 36, 1, dueF3);
  sig = await approve(ia, f3);
  line(7, `F-003: 40 due in 25 s, 36 advanced, fee 1 — operator + AI seat, paid — ${await book()}`, sig);
  await refused("lender A withdraws while 81 are out on advances", withdraw(lenderA));

  // F-001 paid by its debtor: 50 in, 46 to the pool, 4 to the supplier
  const s1 = await bal(supplier);
  sig = await repay(d1, f1, 50);
  line(8, `F-001 paid by its debtor: 50 in — 46 to the pool (45 + fee 1), 4 to the supplier (${s1.toFixed(3)} → ${(await bal(supplier)).toFixed(3)} SOL) — ${await book()}`, sig);

  // F-003: 10 paid, then default
  sig = await repay(d3, f3, 10);
  line(9, `F-003: the debtor pays 10 of 40, then nothing`, sig);
  await refused("default written before due + grace", dflt(ia, f3));
  await refused("buyback before any default", buyback(supplier, f3));
  while ((await chainNow(connection)) < dueF3 + 20) await new Promise((r) => setTimeout(r, 2000));
  await refused("a stranger writes the default", dflt(stranger, f3));
  sig = await dflt(ia, f3);
  line(10, `F-003 in default, written by the AI seat after due + grace: loss 26 on the book (36 − 10), the 10 recovered go to the pool; the program seizes nothing — ${await book()}`, sig);

  // lender A leaves with its share of the book
  const a0 = await bal(lenderA);
  sig = await withdraw(lenderA);
  const paidA = (await bal(lenderA)) - a0;
  line(11, `lender A leaves: 80 × capital ÷ 160 = ${(paidA * LAMPORTS / U).toFixed(3)} (deposited 80) — it carries half the loss — ${await book()}`, sig);

  // the recourse: the supplier buys the defaulted invoice back
  sig = await buyback(supplier, f3);
  line(12, `F-003 bought back by the supplier: 27 unpaid (36 + 1 − 10) paid to the pool, the loss leaves the book — ${await book()}`, sig);
  const b0 = await bal(lenderB);
  sig = await withdraw(lenderB);
  const paidB = (await bal(lenderB)) - b0;
  line(13, `lender B leaves last with the whole book: ${(paidB * LAMPORTS / U).toFixed(3)} (deposited 80): the two fees earned, minus the act fees, A's share gone — ${await book()}`, sig);
  for (const inv of [f1, f2, f3]) sig = await closeAdv(inv);
  line(14, `the operator deletes the three records, rent back — pool ${explorerAccount(pool, cluster)}`, sig);
  const file = join(OUT, `affacturage_${stamp}.json`);
  writeFileSync(file, JSON.stringify({ cluster, program: PROGRAM_ID.toBase58(), pool: pool.toBase58(), policy: pol, unitLamports: U, seats: { ia: ia.publicKey.toBase58(), policy: policy.publicKey.toBase58(), operator: operator.publicKey.toBase58() }, invoices: { f1: f1.dossier, f2: f2.dossier, f3: f3.dossier }, rows }, null, 2));
  console.log(`→ ${file}`);
} else {
  console.log("usage: node affacturage.mjs measure | show <pool> | leave <pool>");
}
