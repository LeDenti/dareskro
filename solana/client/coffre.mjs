#!/usr/bin/env node
/**
 * The shared vault from the command line (the other parties of a demo: landlord, mediator).
 *   node coffre.mjs show <vault>
 *   node coffre.mjs vote <keyfile.json> <vault> <solToBeneficiary>     one party's vote
 *   node coffre.mjs timeout <keyfile.json> <vault>                    after the deadline, anyone
 * Cluster: SOLANA_CLUSTER (devnet by default). Keyfile = Solana CLI JSON array.
 */
import { connect, loadKeypair, PublicKey, anchor, explorerTx } from "./dareskro_solana.mjs";
const [cmd, ...a] = process.argv.slice(2);
const cluster = process.env.SOLANA_CLUSTER || "devnet";
const plain = (v, address) => ({ address, owner: v.owner.toBase58(), beneficiary: v.beneficiary.toBase58(), sol: v.amount.toNumber() / 1e9, threshold: v.threshold,
  parties: v.parties.map((p) => p.toBase58()), votes: v.votes.map((x) => ({ party: x.party.toBase58(), toBeneficiarySol: x.toBeneficiary.toNumber() / 1e9 })),
  deadline: v.deadline ? v.deadline.toNumber() : null, memos: v.memos, status: Object.keys(v.status)[0], paidToBeneficiarySol: v.paidToBeneficiary.toNumber() / 1e9, closedBy: v.closedBy ? v.closedBy.toBase58() : null });
if (cmd === "show") {
  const { program } = await connect({ cluster });
  console.log(JSON.stringify(plain(await program.account.sharedVault.fetch(new PublicKey(a[0])), a[0]), null, 2));
} else if (cmd === "vote" || cmd === "timeout") {
  const signer = loadKeypair(a[0]);
  const { program } = await connect({ cluster, keypair: signer });
  const vault = new PublicKey(a[1]);
  const v = await program.account.sharedVault.fetch(vault);
  let sig;
  if (cmd === "vote") {
    const lamports = new anchor.BN(Math.round(Number(a[2]) * 1e9));
    sig = await program.methods.vaultVote(lamports).accountsPartial({ party: signer.publicKey, vault, beneficiary: v.beneficiary, ownerAccount: v.owner }).signers([signer]).rpc();
    console.log(`vote by ${signer.publicKey.toBase58()}: ${a[2]} SOL to the beneficiary — ${explorerTx(sig, cluster)}`);
  } else {
    sig = await program.methods.vaultTimeout().accountsPartial({ caller: signer.publicKey, vault, ownerAccount: v.owner }).signers([signer]).rpc();
    console.log(`timeout by ${signer.publicKey.toBase58()} — ${explorerTx(sig, cluster)}`);
  }
  console.log(JSON.stringify(plain(await program.account.sharedVault.fetch(vault), a[1]), null, 2));
} else {
  console.error("usage: show <vault> | vote <keyfile> <vault> <solToBeneficiary> | timeout <keyfile> <vault>"); process.exit(2);
}
