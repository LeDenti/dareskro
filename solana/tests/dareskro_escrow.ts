// dareskro on Solana — the guarantees measured on XRPL, replayed against the
// program on a local validator. Each `it` is one line of the README's table.
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";
import { DareskroEscrow } from "../target/types/dareskro_escrow";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.dareskroEscrow as Program<DareskroEscrow>;
const connection = provider.connection;
const payer = (provider.wallet as anchor.Wallet).payer;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fund(k: Keypair, sol: number) {
  const sig = await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

/** the cluster's clock, not the laptop's */
async function chainNow(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const t = await connection.getBlockTime(slot);
  if (t === null) throw new Error("no block time");
  return t;
}

let nextId = Date.now();
function newId() {
  return new BN(nextId++);
}

function escrowPda(owner: PublicKey, id: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    program.programId
  )[0];
}
function vaultPda(escrow: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId)[0];
}

/** the program refused with this error code */
async function refused(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    const got = e?.error?.errorCode?.code ?? "";
    const text = `${e?.message ?? ""} ${JSON.stringify(e?.logs ?? "")}`;
    if (got === code || text.includes(code)) return;
    throw new Error(`expected ${code}, got ${got || text.slice(0, 300)}`);
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

type Opts = {
  finishAfter?: number | null;
  cancelAfter?: number | null;
  condition?: Buffer | null;
  memos?: string[];
};

async function create(owner: Keypair, destination: PublicKey, lamports: number, o: Opts = {}) {
  const id = newId();
  const escrow = escrowPda(owner.publicKey, id);
  await program.methods
    .create(
      id,
      destination,
      new BN(lamports),
      o.finishAfter == null ? null : new BN(o.finishAfter),
      o.cancelAfter == null ? null : new BN(o.cancelAfter),
      o.condition == null ? null : Array.from(o.condition),
      o.memos ?? []
    )
    .accountsPartial({ owner: owner.publicKey, escrow })
    .signers([owner])
    .rpc();
  return { id, escrow };
}

const finish = (caller: Keypair, escrow: PublicKey, destination: PublicKey, fulfillment: Buffer | null = null) =>
  program.methods.finish(fulfillment).accountsPartial({ caller: caller.publicKey, escrow, destination }).signers([caller]).rpc();

const cancel = (caller: Keypair, escrow: PublicKey, ownerAccount: PublicKey) =>
  program.methods.cancel().accountsPartial({ caller: caller.publicKey, escrow, ownerAccount }).signers([caller]).rpc();

describe("dareskro escrow on Solana", () => {
  const employer = Keypair.generate();
  const employee = Keypair.generate();
  const passerby = Keypair.generate();
  const oracle = Keypair.generate();

  before(async () => {
    await fund(employer, 20);
    await fund(passerby, 2);
    await fund(oracle, 2);
  });

  it("payroll shape: no finish before the date, no cancel ever, anyone finishes after", async () => {
    const now = await chainNow();
    const pay = 0.5 * LAMPORTS_PER_SOL;
    const { escrow } = await create(employer, employee.publicKey, pay, {
      finishAfter: now + 6,
      memos: ["sha256:" + sha256(Buffer.from("statement")).toString("hex"), "466.57 EUR"],
    });
    const e = await program.account.escrow.fetch(escrow);
    assert.deepEqual(e.status, { locked: {} });
    assert.equal(e.amount.toNumber(), pay);
    assert.equal(e.memos.length, 2);
    assert.isNull(e.cancelAfter);

    // a third party, before the date: refused by the clock
    await refused(finish(passerby, escrow, employee.publicKey), "TooEarly");
    // the employer wants the money back: there is no such move
    await refused(cancel(employer, escrow, employer.publicKey), "NotCancellable");
    // the destination cannot be swapped, whoever signs
    await refused(finish(passerby, escrow, passerby.publicKey), "WrongDestination");

    await sleep(7000);
    const before = await connection.getBalance(employee.publicKey);
    await finish(passerby, escrow, employee.publicKey);
    const after = await connection.getBalance(employee.publicKey);
    assert.equal(after - before, pay);

    const done = await program.account.escrow.fetch(escrow);
    assert.deepEqual(done.status, { finished: {} });
    assert.equal(done.closedBy!.toBase58(), passerby.publicKey.toBase58());
    // and not twice
    await refused(finish(passerby, escrow, employee.publicKey), "AlreadyClosed");
  });

  it("condition: only the secret releases, and the secret becomes public", async () => {
    const now = await chainNow();
    const secret = randomBytes(32);
    const pay = 0.25 * LAMPORTS_PER_SOL;
    const { escrow } = await create(employer, employee.publicKey, pay, {
      condition: sha256(secret),
      cancelAfter: now + 3600,
    });
    await refused(finish(oracle, escrow, employee.publicKey), "FulfillmentRequired");
    await refused(finish(oracle, escrow, employee.publicKey, randomBytes(32)), "WrongFulfillment");

    const before = await connection.getBalance(employee.publicKey);
    await finish(oracle, escrow, employee.publicKey, secret);
    assert.equal((await connection.getBalance(employee.publicKey)) - before, pay);
    const e = await program.account.escrow.fetch(escrow);
    assert.equal(Buffer.from(e.fulfillment).toString("hex"), secret.toString("hex"));
    assert.equal(e.closedBy!.toBase58(), oracle.publicKey.toBase58());
  });

  it("refund: before cancel_after nobody can cancel, after it anyone can, and finish is over", async () => {
    const now = await chainNow();
    const secret = randomBytes(16);
    const pay = 0.1 * LAMPORTS_PER_SOL;
    const { escrow } = await create(employer, employee.publicKey, pay, {
      condition: sha256(secret),
      cancelAfter: now + 5,
    });
    await refused(cancel(passerby, escrow, employer.publicKey), "CancelTooEarly");
    await sleep(6000);
    // the secret arrives too late
    await refused(finish(oracle, escrow, employee.publicKey, secret), "TooLate");
    // refund goes to the owner only
    await refused(cancel(passerby, escrow, passerby.publicKey), "WrongOwner");
    const before = await connection.getBalance(employer.publicKey);
    await cancel(passerby, escrow, employer.publicKey);
    assert.equal((await connection.getBalance(employer.publicKey)) - before, pay);
    const e = await program.account.escrow.fetch(escrow);
    assert.deepEqual(e.status, { cancelled: {} });
  });

  it("shape: zero amount, cancel before finish, too many memos are refused at creation", async () => {
    const now = await chainNow();
    await refused(create(employer, employee.publicKey, 0), "ZeroAmount");
    await refused(
      create(employer, employee.publicKey, 1000, { finishAfter: now + 100, cancelAfter: now + 50 }),
      "CancelBeforeFinish"
    );
    await refused(create(employer, employee.publicKey, 1000, { memos: ["a", "b", "c", "d"] }), "TooManyMemos");
    await refused(create(employer, employee.publicKey, 1000, { memos: ["x".repeat(129)] }), "MemoTooLong");
  });

  it("batch: several escrows in one transaction are all or nothing", async () => {
    const small = Keypair.generate();
    await fund(small, 1);
    const now = await chainNow();
    const id1 = newId();
    const id2 = newId();
    const e1 = escrowPda(small.publicKey, id1);
    const e2 = escrowPda(small.publicKey, id2);
    const line = (id: BN, escrow: PublicKey, lamports: number) =>
      program.methods
        .create(id, employee.publicKey, new BN(lamports), new BN(now + 60), null, null, [])
        .accountsPartial({ owner: small.publicKey, escrow })
        .instruction();
    // 0.3 SOL fits, 5 SOL does not: the first line must not survive alone
    const tx = new Transaction().add(await line(id1, e1, 0.3 * LAMPORTS_PER_SOL), await line(id2, e2, 5 * LAMPORTS_PER_SOL));
    let failed = false;
    try {
      await provider.sendAndConfirm(tx, [small]);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "the batch should fail");
    assert.isNull(await connection.getAccountInfo(e1), "first line rolled back");
    // the same two lines, both affordable, land together
    const tx2 = new Transaction().add(await line(id1, e1, 0.3 * LAMPORTS_PER_SOL), await line(id2, e2, 0.2 * LAMPORTS_PER_SOL));
    await provider.sendAndConfirm(tx2, [small]);
    assert.isNotNull(await connection.getAccountInfo(e1));
    assert.isNotNull(await connection.getAccountInfo(e2));
  });

  it("close: the owner deletes a closed record and gets the rent back; a Locked one stays", async () => {
    const now = await chainNow();
    const { escrow: locked } = await create(employer, employee.publicKey, 1000, { finishAfter: now + 3600 });
    await refused(
      program.methods.close().accountsPartial({ owner: employer.publicKey, escrow: locked }).signers([employer]).rpc(),
      "StillLocked"
    );
    const { escrow } = await create(employer, employee.publicKey, 1000);
    await finish(passerby, escrow, employee.publicKey);
    await refused(
      program.methods.close().accountsPartial({ owner: passerby.publicKey, escrow }).signers([passerby]).rpc(),
      "WrongOwner"
    );
    const before = await connection.getBalance(employer.publicKey);
    await program.methods.close().accountsPartial({ owner: employer.publicKey, escrow }).signers([employer]).rpc();
    assert.isNull(await connection.getAccountInfo(escrow));
    assert.isAbove(await connection.getBalance(employer.publicKey), before);
  });

  it("token: USDC-like mint locked in a vault, released to the destination's token account, vault closed", async () => {
    const decimals = 6;
    const mint = await createMint(connection, payer, payer.publicKey, null, decimals);
    const employerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, employer.publicKey);
    const employeeAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, employee.publicKey);
    await mintTo(connection, payer, mint, employerAta.address, payer, 1_000_000_000);

    const now = await chainNow();
    const amount = new BN(466_570_000); // 466.57 with 6 decimals
    const id = newId();
    const escrow = escrowPda(employer.publicKey, id);
    const vault = vaultPda(escrow);
    await program.methods
      .createToken(id, employee.publicKey, amount, new BN(now + 4), null, null, ["466.57 EUR, Sunday shift"])
      .accountsPartial({
        owner: employer.publicKey,
        mint,
        ownerToken: employerAta.address,
        escrow,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([employer])
      .rpc();
    assert.equal((await getAccount(connection, vault)).amount.toString(), amount.toString());
    const e = await program.account.escrow.fetch(escrow);
    assert.equal(e.mint!.toBase58(), mint.toBase58());

    const finishToken = (caller: Keypair, to: PublicKey) =>
      program.methods
        .finishToken(null)
        .accountsPartial({
          caller: caller.publicKey,
          escrow,
          mint,
          vault,
          destinationToken: to,
          ownerAccount: employer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([caller])
        .rpc();
    await refused(finishToken(passerby, employeeAta.address), "TooEarly");
    // the SOL instruction cannot touch a token escrow
    await refused(finish(passerby, escrow, employee.publicKey), "WrongRail");
    await sleep(5000);
    // a token account of someone else is refused, even after the date
    await refused(finishToken(passerby, employerAta.address), "WrongDestination");
    await finishToken(passerby, employeeAta.address);
    assert.equal((await getAccount(connection, employeeAta.address)).amount.toString(), amount.toString());
    assert.isNull(await connection.getAccountInfo(vault), "vault closed");
    assert.deepEqual((await program.account.escrow.fetch(escrow)).status, { finished: {} });
  });

  it("token refund: cancel_after reached, the vault pays the owner back", async () => {
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const employerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, employer.publicKey);
    await mintTo(connection, payer, mint, employerAta.address, payer, 10_000_000);
    const now = await chainNow();
    const id = newId();
    const escrow = escrowPda(employer.publicKey, id);
    const vault = vaultPda(escrow);
    const secret = randomBytes(8);
    await program.methods
      .createToken(id, employee.publicKey, new BN(10_000_000), null, new BN(now + 4), Array.from(sha256(secret)), [])
      .accountsPartial({ owner: employer.publicKey, mint, ownerToken: employerAta.address, escrow, vault, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([employer])
      .rpc();
    const cancelToken = () =>
      program.methods
        .cancelToken()
        .accountsPartial({ caller: passerby.publicKey, escrow, mint, vault, ownerToken: employerAta.address, ownerAccount: employer.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([passerby])
        .rpc();
    await refused(cancelToken(), "CancelTooEarly");
    await sleep(5000);
    await cancelToken();
    assert.equal((await getAccount(connection, employerAta.address)).amount.toString(), "10000000");
    assert.isNull(await connection.getAccountInfo(vault));
  });
});
