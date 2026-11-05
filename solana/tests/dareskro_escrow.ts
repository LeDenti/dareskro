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

function sharedPda(owner: PublicKey, id: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shared"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    program.programId
  )[0];
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

  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
  const programData = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  )[0];

  before(async () => {
    await fund(employer, 20);
    await fund(passerby, 2);
    await fund(oracle, 2);
    // the schedule account: only the program's upgrade authority (the test wallet) creates it, at zero
    if (!(await connection.getAccountInfo(configPda))) {
      await refused(
        program.methods.configInit(passerby.publicKey).accountsPartial({ authority: passerby.publicKey, program: program.programId, programData }).signers([passerby]).rpc(),
        "NotUpgradeAuthority"
      );
      await program.methods.configInit(payer.publicKey).accountsPartial({ authority: payer.publicKey, program: program.programId, programData }).rpc();
    }
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


  it("token: a stranger drops 1 unit into the vault; the escrow still pays and closes (nothing can jam it)", async () => {
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const employerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, employer.publicKey);
    const employeeAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, employee.publicKey);
    const passerbyAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, passerby.publicKey);
    await mintTo(connection, payer, mint, employerAta.address, payer, 5_000_000);
    await mintTo(connection, payer, mint, passerbyAta.address, payer, 10);
    const id = newId();
    const escrow = escrowPda(employer.publicKey, id);
    const vault = vaultPda(escrow);
    await program.methods
      .createToken(id, employee.publicKey, new BN(5_000_000), null, null, null, [])
      .accountsPartial({ owner: employer.publicKey, mint, ownerToken: employerAta.address, escrow, vault, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([employer]).rpc();
    // the griefing attempt: one unit straight into the vault
    const { transfer } = await import("@solana/spl-token");
    await transfer(connection, passerby, passerbyAta.address, vault, passerby, 1);
    assert.equal((await getAccount(connection, vault)).amount.toString(), "5000001");
    await program.methods.finishToken(null)
      .accountsPartial({ caller: passerby.publicKey, escrow, mint, vault, destinationToken: employeeAta.address, ownerAccount: employer.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([passerby]).rpc();
    assert.equal((await getAccount(connection, employeeAta.address)).amount.toString(), "5000001", "pay plus the stray unit");
    assert.isNull(await connection.getAccountInfo(vault), "vault closed despite the stray unit");
    const e = await program.account.escrow.fetch(escrow);
    assert.equal(e.amount.toNumber(), 5_000_000, "the record keeps what was promised");
  });

  // ------------------------------------------------------------ the sealed statement

  const statementPda = (escrow: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("statement"), escrow.toBuffer()], program.programId)[0];
  const reader = (role: string) => ({
    role, key: Array.from(randomBytes(32)), epk: Array.from(randomBytes(32)), iv: Array.from(randomBytes(12)), wrapped: Array.from(randomBytes(48)),
  });
  const seal = (owner: Keypair, escrow: PublicKey, cipher: Buffer, readers: any[], declaredHash?: Buffer) =>
    program.methods
      .sealStatement(
        Array.from(sha256(Buffer.from("statement"))), Array.from(declaredHash ?? sha256(cipher)), cipher.length,
        Array.from(randomBytes(12)), Array.from(randomBytes(16)), "", readers, null)
      .accountsPartial({ owner: owner.publicKey, escrow, statement: statementPda(escrow) })
      .signers([owner]).rpc();
  const write = (owner: Keypair, statement: PublicKey, offset: number, data: Buffer) =>
    program.methods.writeCiphertext(offset, data).accountsPartial({ owner: owner.publicKey, statement }).signers([owner]).rpc();
  const finalize = (owner: Keypair, statement: PublicKey) =>
    program.methods.finalizeStatement().accountsPartial({ owner: owner.publicKey, statement }).signers([owner]).rpc();

  it("sealed statement: written in chunks by the owner only, sealed once its hash checks, readers added later", async () => {
    const { escrow } = await create(employer, employee.publicKey, 1000, { finishAfter: (await chainNow()) + 3600 });
    const statement = statementPda(escrow);
    const cipher = randomBytes(2000);
    // a stranger cannot seal someone else's escrow
    await refused(seal(passerby, escrow, cipher, [reader("employee")]), "WrongOwner");
    await seal(employer, escrow, cipher, [reader("employee"), reader("urssaf"), reader("retraite"), reader("dgfip")]);
    let st = await program.account.sealedStatement.fetch(statement);
    assert.isFalse(st.sealed); assert.equal(st.readers.length, 4); assert.equal(st.cipherLen, 2000);
    // not complete yet
    await refused(finalize(employer, statement), "CipherIncomplete");
    // chunks must come in order and inside the announced length
    await refused(write(employer, statement, 900, cipher.subarray(900, 1800)), "BadChunk");
    await write(employer, statement, 0, cipher.subarray(0, 900));
    await write(employer, statement, 900, cipher.subarray(900, 1800));
    await refused(write(employer, statement, 1800, Buffer.concat([cipher.subarray(1800), Buffer.alloc(10)])), "BadChunk");
    await write(employer, statement, 1800, cipher.subarray(1800));
    await refused(write(passerby, statement, 2000, Buffer.alloc(0)), "WrongOwner");
    await finalize(employer, statement);
    st = await program.account.sealedStatement.fetch(statement);
    assert.isTrue(st.sealed);
    assert.equal(Buffer.from(st.ciphertext).toString("hex"), cipher.toString("hex"));
    // sealed: no more writing, no second finalize
    await refused(write(employer, statement, 2000, Buffer.alloc(1)), "StatementSealed");
    await refused(finalize(employer, statement), "StatementSealed");
    // readers: up to six, no duplicate key, owner only
    const r5 = reader("agirc-arrco");
    await program.methods.addReader(r5).accountsPartial({ owner: employer.publicKey, statement }).signers([employer]).rpc();
    await refused(program.methods.addReader(r5).accountsPartial({ owner: employer.publicKey, statement }).signers([employer]).rpc(), "ReaderExists");
    await refused(program.methods.addReader(reader("x")).accountsPartial({ owner: passerby.publicKey, statement }).signers([passerby]).rpc(), "WrongOwner");
    await program.methods.addReader(reader("employer")).accountsPartial({ owner: employer.publicKey, statement }).signers([employer]).rpc();
    await refused(program.methods.addReader(reader("seventh")).accountsPartial({ owner: employer.publicKey, statement }).signers([employer]).rpc(), "TooManyReaders");
    st = await program.account.sealedStatement.fetch(statement);
    assert.equal(st.readers.length, 6);
    assert.equal(st.readers[4].role, "agirc-arrco");
  });

  it("sealed statement: a ciphertext that does not hash to what was announced never seals", async () => {
    const { escrow } = await create(employer, employee.publicKey, 1000, { finishAfter: (await chainNow()) + 3600 });
    const statement = statementPda(escrow);
    const cipher = randomBytes(500);
    await seal(employer, escrow, cipher, [reader("employee")], sha256(Buffer.from("something else")));
    await write(employer, statement, 0, cipher);
    await refused(finalize(employer, statement), "CipherHashMismatch");
    assert.isFalse((await program.account.sealedStatement.fetch(statement)).sealed);
    // shape at creation: neither a ciphertext nor a uri (on a fresh escrow: one record per escrow)
    const { escrow: e2 } = await create(employer, employee.publicKey, 1000, { finishAfter: (await chainNow()) + 3600 });
    await refused(
      program.methods.sealStatement(Array.from(randomBytes(32)), Array.from(randomBytes(32)), 0, Array.from(randomBytes(12)), Array.from(randomBytes(16)), "", [reader("a")], null)
        .accountsPartial({ owner: employer.publicKey, escrow: e2, statement: statementPda(e2) }).signers([employer]).rpc(),
      "NoContent"
    );
  });

  // ------------------------------------------------------------ the shared vault

  async function vaultCreate(owner: Keypair, beneficiary: PublicKey, parties: PublicKey[], threshold: number, lamports: number, deadline: number | null, memos: string[] = []) {
    const id = newId();
    const vault = sharedPda(owner.publicKey, id);
    await program.methods
      .vaultCreate(id, beneficiary, new BN(lamports), parties, threshold, deadline === null ? null : new BN(deadline), memos)
      .accountsPartial({ owner: owner.publicKey, vault })
      .signers([owner])
      .rpc();
    return vault;
  }
  const vaultVote = (party: Keypair, vault: PublicKey, beneficiary: PublicKey, owner: PublicKey, lamports: number) =>
    program.methods.vaultVote(new BN(lamports)).accountsPartial({ party: party.publicKey, vault, beneficiary, ownerAccount: owner }).signers([party]).rpc();

  it("shared vault 2-of-3: one vote decides nothing, two votes on the same amount pay, a stranger cannot vote", async () => {
    const tenant = employer, landlord = Keypair.generate(), mediator = Keypair.generate();
    await fund(mediator, 1);
    await fund(landlord, 1);
    const deposit = 1 * LAMPORTS_PER_SOL;
    const vault = await vaultCreate(tenant, landlord.publicKey, [tenant.publicKey, landlord.publicKey, mediator.publicKey], 2, deposit, null, ["rental deposit · lease 12 rue X", "art. 22 loi 1989"]);
    let v = await program.account.sharedVault.fetch(vault);
    assert.deepEqual(v.status, { locked: {} });
    assert.equal(v.parties.length, 3);

    // a stranger has no say
    await refused(vaultVote(passerby, vault, landlord.publicKey, tenant.publicKey, deposit), "NotAParty");
    // more than the vault holds
    await refused(vaultVote(landlord, vault, landlord.publicKey, tenant.publicKey, deposit + 1), "AmountExceeds");
    // the beneficiary cannot be swapped in the payout accounts
    await refused(vaultVote(landlord, vault, passerby.publicKey, tenant.publicKey, deposit), "WrongDestination");

    // landlord wants it all: 1 vote of 2, nothing moves
    await vaultVote(landlord, vault, landlord.publicKey, tenant.publicKey, deposit);
    v = await program.account.sharedVault.fetch(vault);
    assert.deepEqual(v.status, { locked: {} });
    assert.equal(v.votes.length, 1);
    // tenant wants a full refund: still no two votes alike
    await vaultVote(tenant, vault, landlord.publicKey, tenant.publicKey, 0);
    v = await program.account.sharedVault.fetch(vault);
    assert.deepEqual(v.status, { locked: {} });
    assert.equal(v.votes.length, 2);
    // the mediator settles on a split: 0.3 to the landlord; the tenant agrees — 2 of 3, paid
    const split = 0.3 * LAMPORTS_PER_SOL;
    await vaultVote(mediator, vault, landlord.publicKey, tenant.publicKey, split);
    const lBefore = await connection.getBalance(landlord.publicKey);
    const tBefore = await connection.getBalance(tenant.publicKey);
    await vaultVote(tenant, vault, landlord.publicKey, tenant.publicKey, split); // changes the tenant's vote
    const lAfter = await connection.getBalance(landlord.publicKey);
    const tAfter = await connection.getBalance(tenant.publicKey);
    assert.equal(lAfter - lBefore, split);
    assert.isAtLeast(tAfter - tBefore, deposit - split - 10_000); // minus the fee of the vote
    v = await program.account.sharedVault.fetch(vault);
    assert.deepEqual(v.status, { finished: {} });
    assert.equal(v.paidToBeneficiary.toNumber(), split);
    assert.equal(v.closedBy!.toBase58(), tenant.publicKey.toBase58());
    // and not twice
    await refused(vaultVote(mediator, vault, landlord.publicKey, tenant.publicKey, split), "AlreadyClosed");
    // the owner closes the record and gets the rent back
    await program.methods.vaultClose().accountsPartial({ owner: tenant.publicKey, vault }).signers([tenant]).rpc();
    assert.isNull(await program.account.sharedVault.fetchNullable(vault));
  });

  it("shared vault: past the deadline with no decision, anyone returns the deposit to the owner; before it, nobody", async () => {
    const tenant = employer, landlord = Keypair.generate(), mediator = Keypair.generate();
    const now = await chainNow();
    const deposit = 0.4 * LAMPORTS_PER_SOL;
    const vault = await vaultCreate(tenant, landlord.publicKey, [tenant.publicKey, landlord.publicKey, mediator.publicKey], 2, deposit, now + 6);
    const timeout = (who: Keypair) => program.methods.vaultTimeout().accountsPartial({ caller: who.publicKey, vault, ownerAccount: tenant.publicKey }).signers([who]).rpc();
    await refused(timeout(passerby), "DeadlineNotReached");
    await sleep(7000);
    const before = await connection.getBalance(tenant.publicKey);
    await timeout(passerby);
    const after = await connection.getBalance(tenant.publicKey);
    assert.equal(after - before, deposit);
    const v = await program.account.sharedVault.fetch(vault);
    assert.deepEqual(v.status, { cancelled: {} });
    // shape refusals at creation
    await refused(vaultCreate(tenant, landlord.publicKey, [tenant.publicKey], 1, deposit, null), "BadParties");
    await refused(vaultCreate(tenant, landlord.publicKey, [tenant.publicKey, landlord.publicKey], 3, deposit, null), "BadThreshold");
    await refused(vaultCreate(tenant, landlord.publicKey, [tenant.publicKey, tenant.publicKey], 1, deposit, null), "DuplicateParty");
    await refused(vaultCreate(tenant, landlord.publicKey, [tenant.publicKey, landlord.publicKey], 2, deposit, now - 100), "DeadlinePassed");
  });

  it("invoice advance: a 2-of-3 pool whose ceilings the program holds — two signatures cannot pass a breach; repaid, defaulted, bought back; the lenders carry the loss", async () => {
    const U = 10_000_000; // 0.01 SOL, the unit of the XRPL measurement (160 XRP pool, 45 advanced…)
    const ia = Keypair.generate(), policy = Keypair.generate(), operator = Keypair.generate();
    const lenderA = Keypair.generate(), lenderB = Keypair.generate();
    const supplier = Keypair.generate(), d1 = Keypair.generate(), d2 = Keypair.generate(), d3 = Keypair.generate();
    for (const k of [ia, policy, operator, lenderA, lenderB, d1, d3]) await fund(k, 2);
    const setFee = (bps: number, min: number) => program.methods.setFee(bps, new BN(min)).accountsPartial({ admin: payer.publicKey }).rpc();
    await setFee(0, 500_000); // the devnet schedule: a floor of 0.0005 SOL per act, paid by the pool

    const id = newId();
    const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), operator.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], program.programId)[0];
    const advPda = (invoice: Buffer) => PublicKey.findProgramAddressSync([Buffer.from("advance"), pool.toBuffer(), invoice], program.programId)[0];
    const inv = (name: string) => sha256(Buffer.from(`dareskro/facture/1 ${name}`));
    const now0 = await chainNow();
    const pol = { maxShareBps: 3000, maxAdvanceBps: 9000, maxTerm: new BN(90 * 86400), grace: new BN(4) };

    const poolCreate = (signers: PublicKey[], threshold: number, policy: any) =>
      program.methods.poolCreate(id, signers, threshold, policy).accountsPartial({ operator: operator.publicKey }).signers([operator]).rpc();
    await refused(poolCreate([ia.publicKey], 1, pol), "BadParties");
    await refused(poolCreate([ia.publicKey, policy.publicKey, operator.publicKey], 2, { ...pol, maxShareBps: 0 }), "BadPolicy");
    await poolCreate([ia.publicKey, policy.publicKey, operator.publicKey], 2, pol);
    const deposit = (who: Keypair, amount: number) => program.methods.poolDeposit(new BN(amount)).accountsPartial({ lender: who.publicKey, pool }).signers([who]).rpc();
    await deposit(lenderA, 80 * U);
    await deposit(lenderB, 80 * U);
    let P = await program.account.pool.fetch(pool);
    assert.equal(P.capital.toNumber(), 160 * U);
    assert.equal(P.lenders.length, 2);

    const propose = (who: Keypair, invoice: Buffer, debtor: PublicKey, face: number, advance: number, fee: number, due: number) =>
      program.methods.advancePropose([...invoice], supplier.publicKey, debtor, new BN(face), new BN(advance), new BN(fee), new BN(due))
        .accountsPartial({ signer: who.publicKey, pool, advance: advPda(invoice) }).signers([who]).rpc();
    const approve = (who: Keypair, invoice: Buffer, supplierAcc = supplier.publicKey) =>
      program.methods.advanceApprove().accountsPartial({ signer: who.publicKey, pool, advance: advPda(invoice), supplier: supplierAcc, config: configPda }).signers([who]).rpc();
    const repay = (who: Keypair, invoice: Buffer, amount: number) =>
      program.methods.advanceRepay(new BN(amount)).accountsPartial({ payer: who.publicKey, pool, advance: advPda(invoice), supplier: supplier.publicKey }).signers([who]).rpc();
    const dflt = (who: Keypair, invoice: Buffer) =>
      program.methods.advanceDefault().accountsPartial({ signer: who.publicKey, pool, advance: advPda(invoice) }).signers([who]).rpc();
    const buyback = (who: Keypair, invoice: Buffer) =>
      program.methods.advanceBuyback().accountsPartial({ payer: who.publicKey, pool, advance: advPda(invoice) }).signers([who]).rpc();
    const closeAdv = (invoice: Buffer) =>
      program.methods.advanceClose().accountsPartial({ operator: operator.publicKey, pool, advance: advPda(invoice) }).signers([operator]).rpc();
    const withdraw = (who: Keypair) => program.methods.poolWithdraw().accountsPartial({ lender: who.publicKey, pool }).signers([who]).rpc();

    // shape, at the proposal
    const f1 = inv("F-2026-001"), f2 = inv("F-2026-002"), f3 = inv("F-2026-003"), f4 = inv("F-2026-004");
    await refused(propose(passerby, f1, d1.publicKey, 50 * U, 45 * U, 1 * U, now0 + 600), "NotAParty");
    await refused(propose(ia, f1, d1.publicKey, 50 * U, 45 * U, 6 * U, now0 + 600), "FeeAboveFace");
    await refused(propose(ia, f1, d1.publicKey, 50 * U, 45 * U, 1 * U, now0 + 91 * 86400), "TermTooLong");
    await refused(propose(ia, f1, d1.publicKey, 50 * U, 45 * U, 1 * U, now0 - 10), "DeadlinePassed");

    // F-001: 50 due, 45 advanced, fee 1 — the AI seat proposes, the risk policy approves: paid, 2 of 3
    await propose(ia, f1, d1.publicKey, 50 * U, 45 * U, 1 * U, now0 + 600);
    await refused(approve(ia, f1), "AlreadyApproved");
    await refused(approve(passerby, f1), "NotAParty");
    await refused(approve(policy, f1, passerby.publicKey), "WrongDestination");
    const s0 = await connection.getBalance(supplier.publicKey);
    const held0 = (await program.account.feeConfig.fetch(configPda)).feesHeld.toNumber();
    await approve(policy, f1);
    assert.equal((await connection.getBalance(supplier.publicKey)) - s0, 45 * U, "the supplier has the advance");
    let A = await program.account.advance.fetch(advPda(f1));
    assert.deepEqual(A.status, { funded: {} });
    assert.equal(A.approvals.length, 2);
    P = await program.account.pool.fetch(pool);
    assert.equal(P.outstanding.toNumber(), 45 * U);
    assert.equal(P.capital.toNumber(), 160 * U - 500_000, "the act fee left the book");
    assert.equal((await program.account.feeConfig.fetch(configPda)).feesHeld.toNumber() - held0, 500_000, "dareskro's fee per act, from the pool");
    assert.equal(P.exposures[0].owed.toNumber(), 46 * U);
    await refused(closeAdv(f1), "StillLocked");

    // F-002: 60 due, 54 advanced to a second debtor — 54 / 160 = 33.75 % > 30 %.
    // On XRPL two signers passed it (tesSUCCESS): the ledger knew no cap. Here the second
    // signature is valid and the program refuses; the third signer changes nothing.
    await propose(ia, f2, d2.publicKey, 60 * U, 54 * U, 0, now0 + 600);
    await refused(approve(operator, f2), "ConcentrationBreached");
    await refused(approve(policy, f2), "ConcentrationBreached");
    A = await program.account.advance.fetch(advPda(f2));
    assert.deepEqual(A.status, { proposed: {} });
    assert.equal(A.approvals.length, 1, "a refused approval is not recorded");
    // and an advance above 90 % of the face, however many sign
    await propose(ia, f4, d2.publicKey, 50 * U, 46 * U, 0, now0 + 600);
    await refused(approve(operator, f4), "AdvanceAboveCap");

    // F-003: 40 due in a few seconds, 36 advanced, fee 1 — funded (37 / 160 = 23 %)
    const dueF3 = (await chainNow()) + 6;
    await propose(operator, f3, d3.publicKey, 40 * U, 36 * U, 1 * U, dueF3);
    await approve(ia, f3);
    P = await program.account.pool.fetch(pool);
    assert.equal(P.outstanding.toNumber(), 81 * U);
    assert.equal(P.advancesFunded.toNumber(), 2);
    // a lender cannot leave with cash that is out on advances
    await refused(withdraw(lenderA), "PoolIlliquid");

    // F-001 is paid by its debtor: 50 in, 46 to the pool (45 + fee 1), 4 to the supplier
    await refused(repay(d1, f2, 10 * U), "NotFunded");
    const s1 = await connection.getBalance(supplier.publicKey);
    const p1 = await connection.getBalance(pool);
    await repay(d1, f1, 50 * U);
    assert.equal((await connection.getBalance(supplier.publicKey)) - s1, 4 * U);
    assert.equal((await connection.getBalance(pool)) - p1, 46 * U);
    A = await program.account.advance.fetch(advPda(f1));
    assert.deepEqual(A.status, { repaid: {} });
    P = await program.account.pool.fetch(pool);
    assert.equal(P.outstanding.toNumber(), 36 * U);
    assert.equal(P.feesEarned.toNumber(), 1 * U);
    assert.equal(P.capital.toNumber(), 161 * U - 2 * 500_000);
    assert.equal(P.exposures.length, 1, "d1 owes nothing any more");

    // F-003: 10 paid, then nothing. Before due + grace no default can be written…
    await repay(d3, f3, 10 * U);
    await refused(dflt(ia, f3), "DefaultTooEarly");
    await refused(buyback(supplier, f3), "NotDefaulted");
    while ((await chainNow()) < dueF3 + 4) await sleep(1000);
    await refused(dflt(passerby, f3), "NotAParty");
    // …after it, a signer writes it: loss 26 on the book, the 10 recovered go to the pool, nothing is seized
    await dflt(ia, f3);
    A = await program.account.advance.fetch(advPda(f3));
    assert.deepEqual(A.status, { defaulted: {} });
    P = await program.account.pool.fetch(pool);
    assert.equal(P.losses.toNumber(), 26 * U);
    assert.equal(P.outstanding.toNumber(), 0);
    assert.equal(P.capital.toNumber(), 135 * U - 2 * 500_000);
    assert.equal(P.exposures.length, 0);

    // lender A leaves now: 80 × 134.9 / 160 = 67.45 — it carries half the loss, minus the fee earned
    const a0 = await connection.getBalance(lenderA.publicKey);
    await withdraw(lenderA);
    const paidA = (await connection.getBalance(lenderA.publicKey)) - a0;
    assert.equal(paidA, Math.floor((80 * U * (135 * U - 2 * 500_000)) / (160 * U)));
    await refused(withdraw(lenderA), "NotALender");

    // the supplier buys the defaulted invoice back: 27 unpaid (36 + 1 − 10) to the pool; the loss leaves the book
    await fund(supplier, 1);
    const p2 = await connection.getBalance(pool);
    await buyback(supplier, f3);
    assert.equal((await connection.getBalance(pool)) - p2, 27 * U);
    P = await program.account.pool.fetch(pool);
    assert.equal(P.losses.toNumber(), 0);
    assert.equal(P.feesEarned.toNumber(), 2 * U);
    A = await program.account.advance.fetch(advPda(f3));
    assert.deepEqual(A.status, { boughtBack: {} });

    // lender B leaves last and gets the whole book: it is above its 80 (the two fees, minus the act fees, A's share gone)
    const b0 = await connection.getBalance(lenderB.publicKey);
    await withdraw(lenderB);
    const paidB = (await connection.getBalance(lenderB.publicKey)) - b0;
    assert.equal(paidB, P.capital.toNumber(), "the whole book, 94.45");
    assert.isAbove(paidB, 80 * U);
    P = await program.account.pool.fetch(pool);
    assert.equal(P.capital.toNumber(), 0);
    assert.equal(P.deposits.toNumber(), 0);

    // the operator deletes the settled records and the never-funded proposals; rent comes back
    for (const f of [f1, f2, f3, f4]) await closeAdv(f);
    assert.isNull(await program.account.advance.fetchNullable(advPda(f1)));
    await setFee(0, 0);
    await program.methods.withdrawFees().accountsPartial({ admin: payer.publicKey }).rpc(); // the two act fees, so the next test starts from an empty till
  });

  it("fee per act: zero by default, set by the administrator under the ceilings, paid on top of the lock, withdrawn, never skippable", async () => {
    const setFee = (who: Keypair, bps: number, min: number) =>
      program.methods.setFee(bps, new BN(min)).accountsPartial({ admin: who.publicKey }).signers([who]).rpc();
    const withdraw = (who: Keypair) => program.methods.withdrawFees().accountsPartial({ admin: who.publicKey }).signers([who]).rpc();
    const held = async () => (await program.account.feeConfig.fetch(configPda)).feesHeld.toNumber();
    const SIG = 5000; // one signature

    let cfg = await program.account.feeConfig.fetch(configPda);
    const acts0 = cfg.actsCharged.toNumber(), total0 = cfg.feesTotal.toNumber();
    assert.equal(cfg.feeBps, 0);
    assert.equal(cfg.feeMin.toNumber(), 0);
    assert.equal(cfg.admin.toBase58(), payer.publicKey.toBase58());

    // a stranger cannot set it; the administrator cannot go above the ceilings compiled in the program
    await refused(setFee(passerby, 10, 0), "NotAdmin");
    await refused(setFee(payer, 101, 0), "FeeAboveCeiling");
    await refused(setFee(payer, 0, 10_000_001), "FeeAboveCeiling");

    // 50 bps (0.5 %) with a floor of 0.001 SOL
    await setFee(payer, 50, 1_000_000);
    const now = await chainNow();

    // 1 SOL locked: the owner pays 1 SOL + rent + 0.005 SOL; the escrow holds exactly 1 SOL for the destination
    const pay = 1 * LAMPORTS_PER_SOL;
    const b0 = await connection.getBalance(employer.publicKey);
    const { escrow } = await create(employer, employee.publicKey, pay, { finishAfter: now + 600, memos: ["fee test"] });
    const b1 = await connection.getBalance(employer.publicKey);
    const rent = (await connection.getBalance(escrow)) - pay;
    assert.isAbove(rent, 0);
    assert.equal(b0 - b1 - rent - pay, 5_000_000, "0.5 % of 1 SOL, on top (the test wallet pays the signatures)");
    assert.equal((await program.account.escrow.fetch(escrow)).amount.toNumber(), pay, "what the destination gets is untouched");
    assert.equal(await held(), 5_000_000);

    // 0.01 SOL locked: 0.5 % is 50 000 lamports, under the floor — the floor applies
    await create(employer, employee.publicKey, 0.01 * LAMPORTS_PER_SOL, { finishAfter: now + 600 });
    assert.equal(await held(), 6_000_000);

    // a shared vault of 0.4 SOL: 0.5 % = 0.002 SOL
    const vid = newId();
    await program.methods
      .vaultCreate(vid, employee.publicKey, new BN(0.4 * LAMPORTS_PER_SOL), [employer.publicKey, employee.publicKey, oracle.publicKey], 2, null, [])
      .accountsPartial({ owner: employer.publicKey, vault: sharedPda(employer.publicKey, vid) })
      .signers([employer])
      .rpc();
    assert.equal(await held(), 8_000_000);

    // a token escrow locks no SOL: it pays the floor
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, employer.publicKey);
    await mintTo(connection, payer, mint, ata.address, payer, 10_000_000);
    const tid = newId();
    const tesc = escrowPda(employer.publicKey, tid);
    await program.methods
      .createToken(tid, employee.publicKey, new BN(1_000_000), new BN(now + 600), null, null, [])
      .accountsPartial({ owner: employer.publicKey, mint, ownerToken: ata.address, escrow: tesc, vault: vaultPda(tesc), tokenProgram: TOKEN_PROGRAM_ID })
      .signers([employer])
      .rpc();
    assert.equal(await held(), 9_000_000);

    // the fee cannot be skipped: the schedule account is a fixed PDA of the program; a wallet in its
    // place is refused (wrong owner), an unknown key too (not initialized), another kind of program account (discriminator)
    const fakeId = newId();
    const withConfig = (config: PublicKey) =>
      program.methods
        .create(fakeId, employee.publicKey, new BN(pay), new BN(now + 600), null, null, [])
        .accountsPartial({ owner: employer.publicKey, escrow: escrowPda(employer.publicKey, fakeId), config })
        .signers([employer])
        .rpc();
    await refused(withConfig(passerby.publicKey), "AccountOwnedByWrongProgram");
    await refused(withConfig(Keypair.generate().publicKey), "AccountNotInitialized");
    await refused(withConfig(escrow), "AccountDiscriminatorMismatch");
    assert.equal(await held(), 9_000_000);
    cfg = await program.account.feeConfig.fetch(configPda);
    assert.equal(cfg.actsCharged.toNumber() - acts0, 4, "four acts charged in this test (the counter is cumulative)");

    // only the administrator withdraws, in one call; the account keeps its rent
    await refused(withdraw(passerby), "NotAdmin");
    const rentCfg = (await connection.getBalance(configPda)) - 9_000_000;
    const a0 = await connection.getBalance(payer.publicKey);
    await withdraw(payer);
    const a1 = await connection.getBalance(payer.publicKey);
    // the test wallet is also the local validator's identity, which earns a few lamports of fee rewards meanwhile
    assert.isAtLeast(a1 - a0 + SIG, 9_000_000);
    assert.isBelow(a1 - a0 + SIG, 9_001_000);
    assert.equal(await connection.getBalance(configPda), rentCfg);
    assert.equal(await held(), 0);
    assert.equal((await program.account.feeConfig.fetch(configPda)).feesTotal.toNumber() - total0, 9_000_000, "charged in this test (the total is cumulative)");
    await refused(withdraw(payer), "NothingToWithdraw");

    // back to zero: the next act costs nothing beyond rent and gas
    await setFee(payer, 0, 0);
    const c0 = await connection.getBalance(employer.publicKey);
    const { escrow: free } = await create(employer, employee.publicKey, pay, { finishAfter: now + 600 });
    const c1 = await connection.getBalance(employer.publicKey);
    assert.equal(c0 - c1, await connection.getBalance(free), "amount + rent, nothing else");
    assert.equal(await held(), 0);
  });
});
