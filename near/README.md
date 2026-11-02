# dareskro on NEAR — the escrow is a contract with no owner

**NEAR Hackathon "Build Beyond Boundaries", 1–14 November 2026.** Tracks: 08 Real-World Money, 07 Agent Economy, 04 Autonomous Business.
Everything in this folder was written in the hackathon window (first commit 31/10/2026, after the 19/10 announcement). The rest of the
repository is the XRPL product built for the New York hackathon of 24–25 October; it is baseline and not for judging here (rule Q-002:
"Existing product on another chain? Allowed. Only the NEAR integration built in the window is judged. Disclose in README." — this is the disclosure).

> The agent reads the evidence. The code computes the amount. A human signs. The contract pays at the date.
> Nobody holds the funds in between — on NEAR, not even the people who deployed the contract.

Developer feedback for the NEAR team, every item pinned to a line of code or a transaction: [`FEEDBACK.md`](FEEDBACK.md).

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

Two records live next to the escrows, both measured on 01/11 (table below):

- **The sealed payslip** (`issue_payslip`). The chain is public and permanent, so the payslip never goes on it in clear: [`scelle.mjs`](scelle.mjs)
  encrypts it (AES-256-GCM under a fresh content key, that key wrapped for each reader with X25519 + HKDF, the same scheme as dareskro's
  `agent/confidentiel.mjs` on XRPL) for four readers — the employee, URSSAF, the pension fund, the tax office — and the contract stores the
  sealed file, the sha256 of the clear statement (the same value the escrow's memo carries) and the list of readers. It is issued as a
  **NEP-171 token owned by the employee**, so wallets and explorers list "my payslips", and both `nft_transfer` entry points refuse: a payslip
  stays with the person it names. Anyone can read the record; only a reader's private key turns it back into a payslip.
- **The shared deposit** (`vault_create` / `vault_vote` / `vault_timeout`). A rental deposit is usually returned in part, so it is not an
  escrow. On XRPL dareskro gave each lease an account under a 2-of-3 signer list ([`../depot`](../depot)); here the vault is a record of
  this contract: the tenant funds it, the landlord is the beneficiary, a mediator is the third party. Each party votes the amount that goes
  to the beneficiary, the rest returns to the owner; **the vote that reaches the threshold pays both sides in the same call**; until then
  nothing moves, and a party may change its vote. Past the deadline with no decision, anyone returns everything to the owner. Memos carry
  the lease id and the sha256 of the inventories and quotes: the public trace a judge can read.

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

The same rules run against a local `near-sandbox` node in [`contract/tests/escrow.rs`](contract/tests/escrow.rs) (5 scenarios, the
payslip and the deposit included) and as unit tests in `lib.rs` (12).

## Measured on testnet, 01/11/2026 21:54–21:58 UTC — the payslip and the deposit

Second run, against the contract redeployed with `migrate()` ([6KUEKkmX…](https://testnet.nearblocks.io/txns/6KUEKkmXWu925VqbSoQuAwAc7hT3d5Jex3VK77QdicNx);
the six escrows of 31/10 kept). Same accounts, 10 steps: the 8 above, plus the sealed payslip (1b–1d) and the deposit (9–10). Full log
[`run.log`](run.log), every hash and state [`compte_rendu.json`](compte_rendu.json). Read it as: the landlord alone moves nothing, a
stranger cannot vote, the mediator's vote pays **0.1500 NEAR to the landlord and 0.8432 NEAR back to the tenant in one
call** ([2F3Lo2BQ…](https://testnet.nearblocks.io/txns/2F3Lo2BQs2KBXc1MrYP5J4PiAGCUZ8UELP7zTZjte9KX)); the deposit nobody decides comes back whole at the deadline, called by a passer-by.
The payroll escrow was finished 5 s after the date by the oracle ([F32G27P9…](https://testnet.nearblocks.io/txns/F32G27P9FiMP2pC4KPuEq5hSFdfkqiK5VPsVxTinYgjE)).

| time (UTC) | what happened | tx |
|---|---|---|
| 21:54:40 | 1 payroll escrow #13: 0.9963 NEAR to dareskro-employee.testnet, payable at 2026-11-01T21:55:52.382Z, memos ["sha256:e1537eda93fa56819e53981e0d6343c4602cbb8e8f9fd591048eb0bed6a58835","net 440.36 EUR","dareskro/oracle:dareskro-oracle.testnet"] | [9ckhVavi…](https://testnet.nearblocks.io/txns/9ckhVaviw3LcXJ2Eh8NdzQS56MWSiaZLYCkWzxo4kMVq) |
| 21:54:43 | 1b payslip payslip-2 issued to dareskro-employee.testnet: 7851 bytes sealed for employee, urssaf, retraite, dgfip; sha256 e1537eda93fa5681… = the escrow's memo | [2vKYhUVt…](https://testnet.nearblocks.io/txns/2vKYhUVtbK1fX5GJnGCx5yX6F3EkxPUrqxhJrbsDMP7v) |
| 21:54:43 | 1c the pension fund opens it with its key: period 2026-10, Pharmacien adjoint, coefficient 600, 18 ans d'anciennete, total "564.56" | — |
| 21:54:43 | 1c a stranger sees: owner dareskro-employee.testnet, readers employee/urssaf/retraite/dgfip, reference_hash 4VN+2pP6VoGeU5geDWNDxGAsu46Pn9WRBI6wvtaliDU=, 7851 opaque bytes (IPQg9UPDWxvkgOQeLjkwRFSF…); opening it: stranger is not a reader of this payslip | — |
| 21:54:45 | 1d the employee gives the payslip away → refused: a payslip is not transferable: it stays with the person it was issued to | [4NPBSVdk…](https://testnet.nearblocks.io/txns/4NPBSVdkQAc4C9rRdi34xTidSArKQGHcsanBBPh4SJ7P) |
| 21:54:45 | 1c the employee's wallet lists 2 payslip(s): Payslip 2026-10, Payslip 2026-10 | — |
| 21:54:47 | 2 stranger finishes before the date → refused: too early: the contract's clock has not reached finish_after | [GM4DkVjg…](https://testnet.nearblocks.io/txns/GM4DkVjgdve95guZXeKe7DqTEEQWAQSQu4wuKtEZptCq) |
| 21:54:49 | 3 employer cancels the payroll escrow → refused: this escrow has no cancel_after: nobody can cancel it | [2nju2jTW…](https://testnet.nearblocks.io/txns/2nju2jTWcYRbUYvHHG1eqxV32wjDavtF8u22iKaUeK4n) |
| 21:54:51 | 4a batch with a short deposit → refused: deposit 1.00 NEAR does not cover the batch: 3.00 NEAR + storage 0.009 NEAR | [HF5jND7a…](https://testnet.nearblocks.io/txns/HF5jND7aM3Dbxo5af8AS5vGuCCrSWmXdXroN3tucJuUa) |
| 21:54:53 | 4b one signature, three escrows #14, #15, #16: 0.5 + 0.4 + 0.04 NEAR, surplus returned | [2AYdtU1P…](https://testnet.nearblocks.io/txns/2AYdtU1PxVY3shrtoWBENiPmcvawAxe8QcCYFVCV7pwA) |
| 21:54:55 | 5 delivery escrow #17: 0.5 NEAR, condition 44caf4c9d24c4fc6…, proof = https://raw.githubusercontent.com/LeDenti/dareskro/main/LICENSE sha256 c3b463ae211f43f6… | [FPfxqj9A…](https://testnet.nearblocks.io/txns/FPfxqj9At13Uj6yzU6VhDYdqQ6ESyQc1WWVLomQg2yBh) |
| 21:54:57 | 5a stranger finishes without the secret → refused: this escrow is locked by a condition: bring the fulfillment | [FwsBJyFv…](https://testnet.nearblocks.io/txns/FwsBJyFvcaHo8JjSLxZe3W2aNzSBntz8DUhDCswSvMu5) |
| 21:54:58 | 5b stranger finishes with a wrong secret → refused: fulfillment does not match the condition | [G7gYbyDt…](https://testnet.nearblocks.io/txns/G7gYbyDtaM2xoXrZQo7S5JxhAmDoR4oV9gPAQwiVPG4b) |
| 21:55:00 | 5c employer takes it back before the deadline → refused: too early: cancel_after not reached | [997JzbzY…](https://testnet.nearblocks.io/txns/997JzbzYwy6zPoFxyAEzgm7TAYUVUzddHBN3GWwchaqH) |
| 21:55:02 | 6 delivery escrow #18: 0.25 NEAR, deadline in 90 s, will never be proven | [NiShntK9…](https://testnet.nearblocks.io/txns/NiShntK9bRgEVDMxukdmWS3xcF7KjYa1THc3KrXQdsC) |
| 21:55:02 | 7 oracle dareskro-oracle.testnet watching #13, #14, #15, #16, #17, #18; pay date in 51 s | — |
| 21:55:05 | escrow #17: delivery proven (sha256 matches), secret revealed → done, dareskro-employee.testnet credited | [By25KztF…](https://testnet.nearblocks.io/txns/By25KztFPjExCepJHT2MKzxRzakAJm3VXEUdqXMxWPHD) |
| 21:56:00 | escrow #13: date passed, finish → done, dareskro-employee.testnet credited | [F32G27P9…](https://testnet.nearblocks.io/txns/F32G27P9FiMP2pC4KPuEq5hSFdfkqiK5VPsVxTinYgjE) |
| 21:56:03 | escrow #14: date passed, finish → done, dareskro-employee.testnet credited | [481A7MKW…](https://testnet.nearblocks.io/txns/481A7MKWugJuRGtwRhmJtXCpUa8W3WDowb7X8Z1ZSLXm) |
| 21:56:06 | escrow #15: date passed, finish → done, dareskro-stranger.testnet credited | [AqZ9BiEX…](https://testnet.nearblocks.io/txns/AqZ9BiEXy2aeK2Ar4m3LaDbtAYLToeaPAy4kkj3QE2BC) |
| 21:56:08 | escrow #16: date passed, finish → done, dareskro-oracle.testnet credited | [3SA6huRv…](https://testnet.nearblocks.io/txns/3SA6huRv11VKGrz2BDsUw2h9usy4hN9wLcg9KStRqPye) |
| 21:56:20 | escrow #18: past cancel_after, refund to dareskro-employer.testnet → done | [6QiUYMVT…](https://testnet.nearblocks.io/txns/6QiUYMVTSb5fwKUuj5W1pF2kGRCC3eBsysNuYP4VPt54) |
| 21:56:20 | 7 done: employee 12.9822 → 14.9736 NEAR (+1.9914); payroll finished 5 s after the date by dareskro-oracle.testnet, nobody clicked | — |
| 21:56:22 | 8 finish the payroll escrow twice → refused: escrow already closed | [E2UmBUs7…](https://testnet.nearblocks.io/txns/E2UmBUs718TkYo2xfYV6QgeSaKrZzwWPbFERwXVCNtpt) |
| 21:56:25 | 9 deposit vault #2: 0.9932 NEAR locked by the tenant dareskro-employee.testnet for the landlord dareskro-employer.testnet, 2 of 3 with the mediator dareskro-oracle.testnet, deadline in 600 s | [GWYrAgbo…](https://testnet.nearblocks.io/txns/GWYrAgboQooJTSaiWzGpFrMpqAEoH5Zz8RwveUk8qZKL) |
| 21:56:27 | 9a a stranger votes → refused: not a party to this deposit | [GHu4zE6i…](https://testnet.nearblocks.io/txns/GHu4zE6ihWoEF6pMZfdumPnTkWjMniJTWLc4a5awgPnb) |
| 21:56:29 | 9b the landlord alone votes 0.15 NEAR for himself → recorded, Locked, nothing moves | [E4A6US5J…](https://testnet.nearblocks.io/txns/E4A6US5Jg6nfxAjKCromSgkn243YLLCMsidRvXqUjgQX) |
| 21:56:32 | 9c the tenant votes 0 → two different votes, still Locked | [4cGKrLrn…](https://testnet.nearblocks.io/txns/4cGKrLrnyyzthqLcUCw6mbMWNME3TxpA6bnmX5vf2c7M) |
| 21:56:35 | 9d the mediator sides with the quote → Finished: 0.1500 NEAR to the landlord (2.4726 → 2.6224), 0.8432 back to the tenant (13.9127 → 14.8163), decided by dareskro-oracle.testnet | [2F3Lo2BQ…](https://testnet.nearblocks.io/txns/2F3Lo2BQs2KBXc1MrYP5J4PiAGCUZ8UELP7zTZjte9KX) |
| 21:56:37 | 9e the landlord votes again → refused: vault already closed | [8fr2RFxP…](https://testnet.nearblocks.io/txns/8fr2RFxPbRzdnwBMWbZz5iwAViW3PtpLURE8dBLaDNJo) |
| 21:56:39 | 10 deposit vault #3: 0.5 NEAR, deadline in 60 s, nobody will vote | [GTyNwgEr…](https://testnet.nearblocks.io/txns/GTyNwgErhdLsaZkQh31GoSsGasgspFoJEv1pEmjEhGNV) |
| 21:56:41 | 10a a stranger calls the deadline too soon → refused: deadline not reached: the parties can still decide | [DxPSQc1g…](https://testnet.nearblocks.io/txns/DxPSQc1gNkSab6o53N3PrQiCkdtWLf9ERafQHdnDmo7P) |
| 21:57:47 | 10b after the deadline the stranger returns it → Cancelled, tenant 14.3160 → 14.8123 NEAR, called by dareskro-stranger.testnet | [9KmZJvz2…](https://testnet.nearblocks.io/txns/9KmZJvz2B3mZ5ySutUP6M7tusqg8GVKauP3PRnCvMXBh) |



## The pay desk's NEAR tab, recorded

The React desk in [`../app`](../app) (the one that signs XRPL escrows on a Ledger) has a **NEAR · same desk** tab: the same statement
validated by a named human, the payroll escrow locked and proven, and two cards that exist only here — the deposit decided 2 of 3, and
the registry of escrows, deposits and sealed payslips read from the chain. It talks to a local service, [`desk/desk_near.mjs`](desk/desk_near.mjs)
(port 8794), which holds the testnet keys of the demo roles (tenant = employee, landlord = employer, mediator = oracle, stranger) and appends
every signature to `desk/sortie/`. [`desk/enregistre.mjs`](desk/enregistre.mjs) starts the service and the app, drives the tab in a browser
the way an operator would, and keeps the film (`desk/sortie/pupitre_near.mp4`, not in git), the screenshots and the list of transactions
signed meanwhile (`desk/sortie/pupitre_near_<date>.json`).

Recorded on 01/11/2026 22:01–22:02 UTC: 91 s of film, 11 screenshots, 12 transactions, all in `desk/sortie/` (`pupitre_near_2026-11-01-22-01-11.*`):

| time (UTC) | what the operator did | signed by | tx |
|---|---|---|---|
| 22:01:18 | lock escrow #19: 0.9959 NEAR to the employee, payable in 25 s | employer | [4VRPHf5W…](https://testnet.nearblocks.io/txns/4VRPHf5WP6DGgGZ9aGfMoAojNj1JgsjVPrjLZC1GEpmL) |
| 22:01:21 | early-finish on #19: refused: too early: the contract's clock has not reached finish_after | dareskro-stranger | [AShdhHYK…](https://testnet.nearblocks.io/txns/AShdhHYK2GR5aVXgBThvigw81GH1rFuSrmL3TNvjS37) |
| 22:01:23 | cancel on #19: refused: this escrow has no cancel_after: nobody can cancel it | dareskro-employer | [41as1VcQ…](https://testnet.nearblocks.io/txns/41as1VcQuBfnjhsYThoMF4EdFdLynnMqm7SHg61FJ1kF) |
| 22:01:43 | finish on #19: accepted | dareskro-stranger | [5KkhyE1Q…](https://testnet.nearblocks.io/txns/5KkhyE1QD1ymaiTUL9yRBuPSeU9MawEc4Swq85kNRNGr) |
| 22:01:45 | vault #4 created: 0.9932 NEAR, 2 of 3 | dareskro-employee | [dqNfZfDp…](https://testnet.nearblocks.io/txns/dqNfZfDpv3VczSkiS47kPPLAGwqYZzQfkh48NnYCj9x) |
| 22:01:51 | vault #4 vote 0.15 NEAR to the landlord → refused: not a party to this deposit | dareskro-stranger | [CNoWR7Hu…](https://testnet.nearblocks.io/txns/CNoWR7HuDVTBR8HbuUWsbidAJVu2CGAz4nrq9muLyqkm) |
| 22:01:53 | vault #4 vote 0.15 NEAR to the landlord → recorded, nothing moves | dareskro-employer | [BKPi3ETd…](https://testnet.nearblocks.io/txns/BKPi3ETdcgyJrucesZJ4L3679MRm8zCPEX7dHkHwYAuk) |
| 22:01:55 | vault #4 vote 0 NEAR to the landlord → recorded, nothing moves | dareskro-employee | [6ru2pRTn…](https://testnet.nearblocks.io/txns/6ru2pRTn6ACSfDXr6Lhy2S7Bh3vx2pKm9pCdvHiNXwji) |
| 22:01:59 | vault #4 vote 0.15 NEAR to the landlord → threshold reached, paid both sides | dareskro-oracle | [Ca73ycDb…](https://testnet.nearblocks.io/txns/Ca73ycDbVgiubcxguiEfX445A9qBCULexPTHzebom51b) |
| 22:02:03 | vault #5 created: 0.9932 NEAR, 2 of 3 | dareskro-employee | [Bz5GddEm…](https://testnet.nearblocks.io/txns/Bz5GddEmr2AycENw8umuDMsfxszbY2Rm2jCMSFmZBfd3) |
| 22:02:06 | vault #5 deadline call → refused: deadline not reached: the parties can still decide | dareskro-stranger | [7DEyunhb…](https://testnet.nearblocks.io/txns/7DEyunhb6Bp2a1QpSJ1tL5SKpHsXmwgTUUYkgieceBge) |
| 22:02:35 | vault #5 deadline call → returned to the tenant | dareskro-stranger | [7HmvfdCu…](https://testnet.nearblocks.io/txns/7HmvfdCuGfuH8ZBhud1nRhL5V82DA2ux3Tan7ud6bTx6) |


## Do X, see Y

```bash
# toolchain (macOS): Rust, the wasm target, cargo-near, near-cli-rs
brew install rustup near && rustup-init -y && rustup target add wasm32-unknown-unknown && cargo install --locked cargo-near
# on macOS 26 with a beta SDK, cargo may need: export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk

cd near/contract
cargo test --lib                      # 12 unit tests, 40 s the first time
cargo test --test escrow              # 5 sandbox tests on a real local node (downloads near-sandbox once), ≈ 2 min
cargo near build non-reproducible-wasm   # → target/near/dareskro_escrow.wasm, 266 KB

cd ..
npm install
# five faucet accounts; keys land in ~/.near-credentials/testnet/<id>.json (never in this repo)
for a in dareskro dareskro-employer dareskro-employee dareskro-oracle dareskro-stranger; do
  near account create-account sponsor-by-faucet-service $a.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done
node deploy_near.mjs deploy           # deploy + new() on dareskro.testnet (DARESKRO_CONTRACT to change the name)
node scelle.mjs init                  # the four readers' X25519 keys (near/cles/, never in this repo) and cles_publiques.json
node demo_near.mjs                    # the 10 steps above, ≈ 4 min; writes run.log and compte_rendu.json
node scelle.mjs open <sealed.json> retraite   # the pension fund reads a sealed payslip with its key
node deploy_near.mjs lock --yes       # delete the contract's keys: nobody can change it any more (irreversible)
node oracle_near.mjs watch            # the oracle as a service, every 10 s

cd desk && node desk_near.mjs         # the pay desk's NEAR service (8794); then in ../../app: npm run dev → tab "NEAR · same desk"
node enregistre.mjs                   # or let it start both and film the tab: sortie/pupitre_near_<date>.{mp4,png,json}
```

`dareskro.testnet` is already deployed; `node demo_near.mjs` with the five accounts above reproduces the run against it (the account
names are taken, create your own with `DARESKRO_CONTRACT=<you>.testnet` and the matching employer/employee/oracle/stranger names).

## Files

| file | what |
|---|---|
| `contract/src/lib.rs` | the contract: escrows (`create`, `create_batch`, `finish`, `cancel`), sealed payslips (`issue_payslip`, NEP-171/177 views, transfers refused), deposits (`vault_create`, `vault_vote`, `vault_timeout`), views; `migrate`; 12 unit tests |
| `contract/tests/escrow.rs` | sandbox tests: payroll's one possible outcome, delivery by secret and refund at the deadline, batch all-or-nothing, the payslip token, the deposit decided 2 of 3 or returned at the deadline |
| `scelle.mjs` | seals a payslip for its readers (X25519 + AES-256-GCM), opens it with a reader's key; `cles_publiques.json` holds the public keys |
| `desk/desk_near.mjs`, `desk/enregistre.mjs` | the pay desk's NEAR service and the recorded run of the tab; `desk/sortie/` the records |
| `../app/src/NearDesk.tsx`, `../app/src/near.ts` | the NEAR tab of the React desk |
| `lib.mjs` | near-api-js 7 helpers: accounts from the legacy keychain, `call` that never throws on a panic, views |
| `oracle_near.mjs` | the oracle: makes conditions (keeps the secret in `.oracle_near.json`, 0600), reads public facts, finishes and refunds |
| `deploy_near.mjs` | deploy, list keys, **lock** |
| `demo_near.mjs` | the testnet run; `run.log`, `compte_rendu.json` |
| `../presentation/video/scenarios/near.json` | the film's NEAR scenario, filled from `compte_rendu.json` (see `../presentation/video/README.md`) |

Libraries: `near-sdk` 5.30, `hex` 0.4, `near-workspaces` 0.24, `near-api-js` 7.4. Written with Claude Code (Fable 5.1), as the rest
of dareskro; the code was run and measured as reported above.

## What is not done

- The human signature on NEAR is still a key in a file: the desk service signs for the roles. The product path is a wallet (Meteor,
  Ledger NEAR app) signing `create` and `vault_vote` from the pay desk.
- The readers' keys of the sealed payslip are generated here for the demo; in production each body (URSSAF, pension fund, DGFiP)
  publishes its own X25519 key and the employer's desk wraps for it.
- A vault's payout is two transfers to accounts that exist; if one disappeared meanwhile the callback logs `vault_transfer_failed`
  and the record stays decided — the failed leg is a trace to act on, not a reopen.
- `cargo near build reproducible-wasm` (Docker) is not set up; the wasm's sha256 is printed by the non-reproducible build.
- Stablecoins: the demo locks NEAR. A NEP-141 variant (USDC on NEAR via `ft_transfer_call`) is the natural next step for track 08.

Submission account (prize payout, mainnet): `dareskro.near`.
