# dareskro on NEAR — the escrow is a contract with no owner

**NEAR Hackathon "Build Beyond Boundaries", 1–14 November 2026.** Tracks: 08 Real-World Money, 07 Agent Economy, 04 Autonomous Business.
Everything in this folder was written in the hackathon window (first commit 31/10/2026, after the 19/10 announcement). The rest of the
repository is the XRPL product built for the New York hackathon of 24–25 October; it is baseline and not for judging here (rule Q-002:
"Existing product on another chain? Allowed. Only the NEAR integration built in the window is judged. Disclose in README." — this is the disclosure).

> The agent reads the evidence. The code computes the amount. A human signs. The contract pays at the date.
> Nobody holds the funds in between — on NEAR, not even the people who deployed the contract.

## What changes when the ledger has no escrow

On the XRP Ledger `EscrowCreate` is a native transaction: the ledger itself holds the money and enforces the date. NEAR has no native
escrow, so here **the escrow is a contract**, [`contract/src/lib.rs`](contract/src/lib.rs), 300 lines of Rust, and the guarantees dareskro
measured on XRPL are written as code and measured again:

| guarantee | XRPL (native) | NEAR (this contract) |
|---|---|---|
| the money goes where it was written | `Destination` field of `EscrowCreate` | `finish(id)` has no parameter for an address; the destination is read from the record |
| nobody pays early | `FinishAfter`, `tecNO_PERMISSION` before it | `env::block_timestamp() < finish_after` → panic `too early` |
| nobody takes it back | no `CancelAfter` → `EscrowCancel` always refused | no `cancel_after` → `cancel()` panics `nobody can cancel it`, owner included |
| release by a secret | `Condition` / `Fulfillment` (PREIMAGE-SHA-256) | `condition` = sha256 hex; `finish(id, fulfillment)` checks it and **records the secret on chain** |
| several payees, one signature, all or nothing | Batch (XLS-56) | `create_batch(items)`: amounts + storage must fit the deposit or nothing is created; surplus returned |
| who holds the funds | the ledger | the contract account — **after `deploy_near.mjs lock` it has no keys left**: nobody can change the code or move the balance except through `create` / `finish` / `cancel` |

Four shapes, as on XRPL: **payroll** (`finish_after` only), **delivery** (`condition` + `cancel_after`), **presence** (`condition` +
`finish_after` + `cancel_after`), **affiliate** (`condition` + `cancel_after`, the merchant brings the secret). The record's storage
(≈ 0.003 NEAR) is taken from the deposit, so the contract never needs topping up; every change emits a NEP-297 `EVENT_JSON` log.

## Measured on testnet, 31/10/2026 07:58–08:00 UTC

Contract `dareskro.testnet` ([deploy](https://testnet.nearblocks.io/txns/AwuuUYFBTqtMktFrDVCtrMhN52nPk4XTKxc3gT9ScwSv)), oracle
`dareskro-oracle.testnet`. Full log: [`run.log`](run.log); every hash and state: [`compte_rendu.json`](compte_rendu.json).

| step | signed by | result |
|---|---|---|
| 1 `create` 1 NEAR → employee, `finish_after` = now + 75 s, memos = statement sha256 · `net 440.36 EUR` · `dareskro/oracle:…` — [84KesLHx…](https://testnet.nearblocks.io/txns/84KesLHxoSBJwvBwLMhBtbrzGZTJKLE3HaKhp57rUbof) | employer | escrow #1, 0.9963 NEAR (1 NEAR minus the record's storage) |
| 2 `finish` **before** the date — [3TV2JVA2…](https://testnet.nearblocks.io/txns/3TV2JVA2adYTghpLfHSyCGu2JodRSuMAxvJXkKWsxHm1) | a stranger | `too early: the contract's clock has not reached finish_after` |
| 3 `cancel` the payroll escrow — [39uHEe16…](https://testnet.nearblocks.io/txns/39uHEe16B9xHiteNMzJw5rEXmuWnH4wrtDPg5XMgDZtj) | the employer | `this escrow has no cancel_after: nobody can cancel it` |
| 4a `create_batch` 3 × 1 NEAR with 1 NEAR attached — [39tk4YJr…](https://testnet.nearblocks.io/txns/39tk4YJrCtQYFKskmkFzEG8AKYbyPcFAdPuJnPpCjtsd) | employer | `deposit 1.00 NEAR does not cover the batch: 3.00 NEAR + storage 0.009 NEAR`, nothing created |
| 4b `create_batch` net 0.5 + URSSAF 0.4 + DGFiP 0.04, 1 NEAR attached — [HiosFJnE…](https://testnet.nearblocks.io/txns/HiosFJnELZszsrtqbaHntEsfyG5RYQMaAjcYg7L6NBjj) | employer, one signature | escrows #2 #3 #4, surplus returned |
| 5 `create` 0.5 NEAR, `condition` = sha256(secret held by the oracle), proof = a public file and its sha256 — [EMS1af4X…](https://testnet.nearblocks.io/txns/EMS1af4XSKb9Ec1Zbr8jL8JTca8jGGNob2XLTd7QjMw4) | employer | escrow #5 |
| 5a `finish` without the secret — [FsHeHu86…](https://testnet.nearblocks.io/txns/FsHeHu86v9LsJQwyRaTytHwnm2YecwXUnagJVEy9sxfc) | a stranger | `locked by a condition: bring the fulfillment` |
| 5b `finish` with a wrong secret — [DF9DHFJP…](https://testnet.nearblocks.io/txns/DF9DHFJPH4735x3BrWQPodYdwx5XmEUrfVtuTJpHef1f) | a stranger | `fulfillment does not match the condition` |
| 5c `cancel` before the deadline — [3g6XpGWS…](https://testnet.nearblocks.io/txns/3g6XpGWSfQaVSyXqhgviP8TXXnRDiywRhvhRoYe3dC1b) | the employer | `too early: cancel_after not reached` |
| 6 `create` 0.25 NEAR, a delivery that will never be proven, deadline + 90 s — [FCRaFjC5…](https://testnet.nearblocks.io/txns/FCRaFjC5kUzbgvLMeeRimTGyt7aTv4CaUcPd8W5kmomw) | employer | escrow #6 |
| 7 the oracle reads the file, the sha256 matches, `finish(#5, secret)` — [3StGQzE9…](https://testnet.nearblocks.io/txns/3StGQzE9oAtLnXjthuR1FKvpBF4wNen665rizRSzxecZ) | the oracle | paid, the secret is now public in the record |
| 7 `finish(#1)` **4 s after the date, nobody clicked** — [BS411Rjz…](https://testnet.nearblocks.io/txns/BS411RjzQafP8NrJBTSQm9NHhmeKKtUYhC4XirAzYrxg) | the oracle | employee credited 0.9963 NEAR |
| 7 `finish(#2)` [ACAYyJnB…](https://testnet.nearblocks.io/txns/ACAYyJnBx7LqYUs9Ci9PsmYbjpa5LFscxT8Mvhj6bBEs) · `finish(#3)` [xmT6xDsg…](https://testnet.nearblocks.io/txns/xmT6xDsgL3WqQALkFUwwwrr13srzgFe4YXcHcZUQ4TM) · `finish(#4)` [HkDMtpBs…](https://testnet.nearblocks.io/txns/HkDMtpBsLe8M9DaNzzPU6SewfnjiTi7vSRFsjoVgKRET) | the oracle | the three payees of the batch credited |
| 7 `cancel(#6)` past the deadline — [7wotFYbc…](https://testnet.nearblocks.io/txns/7wotFYbchWeHEhr5BgjwgPyPjndgF2thUG2VJoYQ3X9D) | the oracle | employer refunded 0.25 NEAR |
| 8 `finish(#1)` again — [2t7HjTMe…](https://testnet.nearblocks.io/txns/2t7HjTMemFm1arDjCWqLQZHE7D5LTTGX3X5zvPpxk6Uz) | a stranger | `escrow already closed` |

Employee balance over the run: 10.0000 → 11.9914 NEAR (#1 + #2 + #5). The oracle paid gas and nothing else.

The same rules run against a local `near-sandbox` node in [`contract/tests/escrow.rs`](contract/tests/escrow.rs) (3 scenarios) and as
unit tests in `lib.rs` (6).

## Do X, see Y

```bash
# toolchain (macOS): Rust, the wasm target, cargo-near, near-cli-rs
brew install rustup near && rustup-init -y && rustup target add wasm32-unknown-unknown && cargo install --locked cargo-near
# on macOS 26 with a beta SDK, cargo may need: export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk

cd near/contract
cargo test --lib                      # 6 unit tests, 40 s the first time
cargo test --test escrow              # 3 sandbox tests on a real local node (downloads near-sandbox once), ≈ 2 min
cargo near build non-reproducible-wasm   # → target/near/dareskro_escrow.wasm, 180 KB

cd ..
npm install
# five faucet accounts; keys land in ~/.near-credentials/testnet/<id>.json (never in this repo)
for a in dareskro dareskro-employer dareskro-employee dareskro-oracle dareskro-stranger; do
  near account create-account sponsor-by-faucet-service $a.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done
node deploy_near.mjs deploy           # deploy + new() on dareskro.testnet (DARESKRO_CONTRACT to change the name)
node demo_near.mjs                    # the 8 steps above, ≈ 2 min; writes run.log and compte_rendu.json
node deploy_near.mjs lock --yes       # delete the contract's keys: nobody can change it any more (irreversible)
node oracle_near.mjs watch            # the oracle as a service, every 10 s
```

`dareskro.testnet` is already deployed; `node demo_near.mjs` with the five accounts above reproduces the run against it (the account
names are taken, create your own with `DARESKRO_CONTRACT=<you>.testnet` and the matching employer/employee/oracle/stranger names).

## Files

| file | what |
|---|---|
| `contract/src/lib.rs` | the escrow contract: `create`, `create_batch`, `finish`, `cancel`, views `get` `list` `count` `now`; unit tests |
| `contract/tests/escrow.rs` | sandbox tests: payroll's one possible outcome, delivery by secret and refund at the deadline, batch all-or-nothing |
| `lib.mjs` | near-api-js 7 helpers: accounts from the legacy keychain, `call` that never throws on a panic, views |
| `oracle_near.mjs` | the oracle: makes conditions (keeps the secret in `.oracle_near.json`, 0600), reads public facts, finishes and refunds |
| `deploy_near.mjs` | deploy, list keys, **lock** |
| `demo_near.mjs` | the testnet run; `run.log`, `compte_rendu.json` |
| `../presentation/video/scenarios/near.json` | the film's NEAR scenario, filled from `compte_rendu.json` (see `../presentation/video/README.md`) |

Libraries: `near-sdk` 5.30, `hex` 0.4, `near-workspaces` 0.24, `near-api-js` 7.4. Written with Claude Code (Fable 5.1), as the rest
of dareskro; the code was run and measured as reported above.

## What is not done

- The human signature on NEAR is still a key in a file for the demo. The product path is a wallet (Meteor, Ledger NEAR app) signing
  `create` from the pay desk; the desk in `app/` speaks XRPL only for now.
- `cargo near build reproducible-wasm` (Docker) is not set up; the wasm's sha256 is printed by the non-reproducible build.
- Stablecoins: the demo locks NEAR. A NEP-141 variant (USDC on NEAR via `ft_transfer_call`) is the natural next step for track 08.

Submission account (prize payout, mainnet): `dareskro.near`.
