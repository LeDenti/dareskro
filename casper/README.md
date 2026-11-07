# dareskro on Casper 2.x — the escrow as an Odra contract, deployed on casper-test

> The oracle reads the evidence. The code pays. Nobody holds the funds in between — on Casper,
> the contract does, and its rules are the ones measured below.

**Deployed on `casper-test` on 7 November 2026** (casper-node 2.2.2, protocol 2.0.0), from this Mac, with the
testnet key that had waited on the VPS since August. Package `hash-daff0600705aad5ca85b7a653043eeae2a5de7d743fe90d4abf9a95166933de6`
([contract package on cspr.live](https://testnet.cspr.live/contract-package/daff0600705aad5ca85b7a653043eeae2a5de7d743fe90d4abf9a95166933de6),
[install transaction 2dfce9ca…](https://testnet.cspr.live/transaction/2dfce9ca39c3aba8c0c730a70c5dd4495a31a7aa4265950cb5ad6417b639970d),
316 789 bytes of wasm, 301.4 CSPR consumed on a 400 CSPR payment, 75 % of the unused part refunded). Every address and
hash of the deployment is in [`deploiement.json`](deploiement.json); every step of the testnet run, with its hash and the
state read back, in [`compte_rendu.json`](compte_rendu.json) and [`run.log`](run.log). **Nothing on mainnet.**

## Why it was never deployed before, and what changed

The first contract (`sources/casper/contract.wasm`, 21/08/2026: `create_escrow`, `deliver`, `release`, `refund`,
`open_dispute`, `resolve`, `set_arbiter`, `set_fee`) was compiled against the 1.x crates. By the time it was ready the testnet
had moved to Casper 2.x: `Deploy` replaced by `Transaction`, `casper-client` 5 without a prebuilt binary, `pycspr` still a
1.x client. On 07/11 the developer of CasperAI answered on Reddit: a 1.x wasm is not checked on 2.x (so recompile), the
Casper JS SDK detects 1.x / 2.0 and sends the right format, and `casper-client 5` installs with
`put-transaction session --install-upgrade`. So this folder starts over, in Node and Odra, and keeps nothing of the Python
side. The on-chain arbitration of the old wasm (`open_dispute` / `resolve`) is not carried over: dareskro's rule is that
the oracle observes and the code pays, the same on XRPL, Solana and NEAR.

| obstacle (06/09/2026) | lifted on 07/11/2026 by |
|---|---|
| testnet in Casper 2.x, `Deploy` replaced by `Transaction` | the contract rewritten with **Odra 2.10** (`cargo odra build` → `wasm/DareskroEscrow.wasm`), sent as `TransactionV1` on the install-upgrade lane by the JS SDK v5 (`SessionBuilder().installOrUpgrade()`), the four `odra_cfg_*` arguments the generated `call` expects |
| `casper-client` 5.0.1 has no prebuilt binary | `cargo install casper-client --version 5.0.1 --locked` on the Mac (Rust 1.99, 20 min); kept as a second path, the deploy and the demo use the JS SDK |
| `pycspr` is a 1.x client | Python dropped for Casper: [`dareskro_casper.mjs`](dareskro_casper.mjs) on `casper-js-sdk` 5.3.1, which detects the node's API (`CasperNetwork.create`) — here 2.0.0 |
| the wasm targets 1.x | recompiled; the old wasm is kept in `sources/` (untracked) as history only |
| the key is on the VPS | copied by `scp` into `casper/cles/` (git-ignored, mode 600); it never appears in a message or a log |

## The contract — [`contract/src/escrow.rs`](contract/src/escrow.rs)

`DareskroEscrow`, 420 lines of Rust with Odra 2.10 (the macros write the entry points, the storage and the events).
The deployer is administrator and, until `set_oracle`, oracle. Amounts in motes (1 CSPR = 10⁹), times in block
milliseconds.

| guarantee | XRPL (native) | Casper (this contract) |
|---|---|---|
| the money goes where it was written | `Destination` of `EscrowCreate` | `release(id, fulfillment?)` has no parameter for an address: the beneficiary is read from the record |
| nobody pays early | `FinishAfter`, `tecNO_PERMISSION` before it | block time `< release_after` → `TooEarly` (3), whoever calls, key or not |
| nobody takes it back | no `CancelAfter` → `EscrowCancel` always refused | `cancel_after = 0` → `refund` reverts `NotCancellable` (4), administrator included; with a date, only after it (`CancelTooEarly`, 5), by anyone, **only to the payer** |
| release by a secret | `Condition` / `Fulfillment` (PREIMAGE-SHA-256) | `condition` = sha256 hex; `release(id, key)` checks `sha256(key)` (`WrongFulfillment`, 11) and **records the key on chain** |
| release without a secret | anyone, after the date | the oracle only (`NotAuthorized`, 2): a stranger, the payer, the beneficiary are refused |
| who holds the funds | the ledger | the contract's purse; `create` is `#[odra(payable)]`, the CSPR arrive through Odra's `cargo_purse` |
| a fee per act | — | `set_fee(bps)` by the administrator, **refused above 100 bps = 1 % by the code** (`FeeTooHigh`, 12), zero by default; taken at release, kept in the contract, `withdraw_fees` by the administrator |

The fee is read at the act, not frozen at creation (a test documents it). `create` refuses an empty purse
(`ZeroAmount`), a cancel date before the release date (`BadDates`) and a condition that is not 64 lowercase hex
characters (`BadCondition`). Events: `Created`, `Released`, `Refunded`, `FeeSet` (Casper Event Standard).

### Tests — 14, on both backends

```
cd casper/contract && cargo odra test              # OdraVM, 0.04 s
cd casper/contract && cargo odra test -b casper    # CasperVM: builds the wasm, same 14 tests, 0.24 s
```

They cover the refusals above (too early, wrong key, wrong condition, condition before the date, refund too early,
refund without a date, fee above the cap, fee set by a stranger, withdraw by a stranger, zero amount, bad dates, bad
condition, unknown id, closed twice), the two releases (oracle; key, recorded), the refund to the payer by a stranger,
the 1 % fee on 200 CSPR, `set_oracle`, and the SHA-256 test vector.

## The Node client — [`dareskro_casper.mjs`](dareskro_casper.mjs)

- `createTx`, `releaseTx`, `refundTx`, `setFeeTx`, `setOracleTx`, `withdrawFeesTx`, `transferTx` build the transactions;
  `send(tx, signer)` signs, submits through `CasperNetwork` (1.x / 2.0 detected) and waits; it never throws on a revert
  and maps `User error: N` to the contract's error names.
- **The payable call.** Odra contracts take CSPR from a `cargo_purse` that only session code can fill, so `create` is sent
  as a session transaction carrying Odra's `proxy_caller` (`wasm/proxy_caller.wasm`, the `proxy_caller_with_return.wasm`
  shipped in the `odra-casper-rpc-client` 2.10.0 crate, 184 758 bytes) with the arguments it reads: `package_hash`,
  `entry_point`, `args` (the inner arguments serialized), `attached_value`, `amount`. Its size puts it on the 1 000 CSPR
  Wasm lane (one per block); a 10 CSPR payment covers it.
- **Reading is free.** Odra stores every field in the contract's `state` dictionary under
  `blake2b(index_bytes ++ key_bytes)`; `readEscrow(id)`, `readCount()`, `readOracle()`, `readFeeBps()`,
  `readFeesCollected()` recompute that key (field index 1-based, nibble-packed in a big-endian u32, the mapping key as
  bytesrepr) and decode the record from the current contract version of the package. No transaction, no gas.
- `packageHash()` reads `CASPER_ESCROW_HASH`, then `deploiement.json`, and refuses to build anything when both are
  empty: the common base keeps its rule, no escrow pretends to exist on an undeployed contract.

```
cd casper && npm install
node deploy_testnet.mjs          # install-upgrade with the JS SDK; writes deploiement.json
node demo_testnet.mjs            # the run below; writes run.log and compte_rendu.json
```

The same install with `casper-client` 5 (`--install-upgrade`, otherwise `NotAllowedToAddContractVersion`; always pass
the entry point and the package name, the client puts an empty string in silence):

```
casper-client put-transaction session --node-address https://node.testnet.casper.network/rpc \
  --chain-name casper-test --secret-key casper/cles/secret_key.pem \
  --wasm-path casper/wasm/DareskroEscrow.wasm --install-upgrade \
  --pricing-mode classic --payment-amount 400000000000 --standard-payment true --gas-price-tolerance 1 \
  --session-arg "odra_cfg_package_hash_key_name:string='dareskro_escrow'" \
  --session-arg "odra_cfg_allow_key_override:bool='false'" \
  --session-arg "odra_cfg_is_upgradable:bool='true'" --session-arg "odra_cfg_is_upgrade:bool='false'"
```

and a call: `casper-client put-transaction package --contract-package-hash hash-daff06… --session-entry-point release
--session-arg "id:u64='1'" --session-arg "fulfillment:opt_string=null" …` (`create` cannot be sent this way: see the
payable call above).

## Measured on testnet, 7 November 2026, 07:37:58–07:41:20 UTC

Second pass of [`demo_testnet.mjs`](demo_testnet.mjs) (the first, 07:34–07:36 UTC, stopped at the 16th step when the
stranger ran out of gas: a refused call burns its whole 5 CSPR payment; escrows #1–#3 of that pass are on chain too).
Accounts: employer = the deployer `01ba235fa0…` (payer and administrator), oracle
`011d2a1cdd…`, stranger `0169c7d66c…`, employee `01dee7f60c…`
(the last three generated here, in `cles/`). Every hash, cost and record read back: [`compte_rendu.json`](compte_rendu.json);
the log: [`run.log`](run.log). 23 steps, **all as expected**.

| step | signed by | result | tx |
|---|---|---|---|
| 0 fund oracle with 40 CSPR | the employer (administrator) | executed | [b5d51f53…](https://testnet.cspr.live/transaction/b5d51f539efd9c07527c377730fdf04cc4406a8acb23735510a17383d626b08e) |
| 0 fund stranger with 60 CSPR | the employer (administrator) | executed | [ae7de35b…](https://testnet.cspr.live/transaction/ae7de35be76836ea751c8c59a6326eab72aa406c8a22e50457473a1190c7b7c8) |
| 0 set_fee(0) (reset) | the employer (administrator) | executed | [b7eb71ae…](https://testnet.cspr.live/transaction/b7eb71ae8237561f244057a4314a9563bc431133993deb9b5b998a272400d92b) |
| 1 create 10 CSPR → employee, release_after = +70 s, no cancel date, memo = statement sha256 | the employer (administrator) | executed | [f64a769b…](https://testnet.cspr.live/transaction/f64a769b9668be726b5587a1e52f4fcfa577ad0ed65c601d54ab27d1c90b2252) |
| 2 release(#4) by the oracle BEFORE the date | the oracle | `TooEarly` (User error: 3) | [a88caa4f…](https://testnet.cspr.live/transaction/a88caa4fdb885915b9dae86858f3767cc11e1ad50d2386e4a0eb31076f189dfe) |
| 5 create 5 CSPR → employee, condition = sha256(secret), cancel_after = +60 s (a delivery nobody will prove) | the employer (administrator) | executed | [3d868181…](https://testnet.cspr.live/transaction/3d8681816777a91d5c50f8bfc4effa257c5a720c712983e8361591f42a132167) |
| 5a refund(#5) by the employer BEFORE cancel_after | the employer (administrator) | `CancelTooEarly` (User error: 5) | [35d99abe…](https://testnet.cspr.live/transaction/35d99abe281498debf15b96d18688919718f11e73bff359c879ddfc03af66830) |
| 3b release(#5) by a stranger with the WRONG fulfillment | a stranger | `WrongFulfillment` (User error: 11) | [8db552c0…](https://testnet.cspr.live/transaction/8db552c01a0006a68312084abcc8833e9bfbd79e322f92771c841c3d6da4b7ae) |
| 3 release(#4) by a stranger AFTER the date (not the oracle, no condition) | a stranger | `NotAuthorized` (User error: 2) | [672c5855…](https://testnet.cspr.live/transaction/672c58559570b86d250b84955d64ac89b4ca8198c13487fddc9cd75aa68c241c) |
| 3 release(#4) by the payer itself (the employer) | the employer (payer) | `NotAuthorized` (User error: 2) | [6ac3862d…](https://testnet.cspr.live/transaction/6ac3862d981acc3a11cc2481a014e08b358ecc0fa2fbecb621e6a1b53245ff79) |
| 4 release(#4) by the oracle after the date → employee 19.900 → 29.900 CSPR | the oracle | executed, escrow #4 released | [a3450057…](https://testnet.cspr.live/transaction/a34500571ce81cfd8d291e5d34d48fbd533cd8e9cb4e6c1d2f25b3a9065a6646) |
| 7 release(#4) again by the oracle | the oracle | `AlreadyClosed` (User error: 7) | [24128793…](https://testnet.cspr.live/transaction/2412879393adf36e5cb68ffca57ec442272f65a50267fa371898421a538ddbb7) |
| 5b refund(#5) by a stranger after cancel_after → employer 524.985 → 529.985 CSPR (+5) | a stranger | executed, escrow #5 refunded | [0a5536c1…](https://testnet.cspr.live/transaction/0a5536c187e34dc83aa6c8d086b5a347b373e6c72e70b2f469eaabbc4fd6a5a7) |
| 6 set_fee(101 bps) by the administrator | the administrator | `FeeTooHigh` (User error: 12) | [0e6a8e45…](https://testnet.cspr.live/transaction/0e6a8e45b0f314182dff30bad17daaa56f4f1b305dfb33f2126f7a6438b7dacd) |
| 6 set_fee(10 bps) by a stranger | a stranger | `NotAdmin` (User error: 1) | [127aef1c…](https://testnet.cspr.live/transaction/127aef1c49684ef55b1dea01e9d28a8bfd92e883d2fc310fc33e9c3697ec14be) |
| 6 set_fee(100 bps = 1 %) by the administrator | the administrator | executed | [2decc40a…](https://testnet.cspr.live/transaction/2decc40a75678460349cdfcbdf0f032451bab1b815c339a850b03d84f02de591) |
| 6 create 10 CSPR → employee, condition = sha256(secret), payable at once | the employer (administrator) | executed | [2e0b129d…](https://testnet.cspr.live/transaction/2e0b129d3e99ecd1f208ba7a4e5d998b4145399ab00b00659a8c0eb4e73748de) |
| 6 release(#6) by a stranger WITH the right secret → employee +9.900 CSPR (9.9), fee kept 0.1 | a stranger | executed, escrow #6 released, fulfillment recorded: `bon de livraison 2026-11-07 signe` | [ef9b5422…](https://testnet.cspr.live/transaction/ef9b542253befd5db60661d4c708ffa406f0078d1de0680ecfd1a9e5ac54527f) |
| 6 withdraw_fees by a stranger | a stranger | `NotAdmin` (User error: 1) | [fbdca31b…](https://testnet.cspr.live/transaction/fbdca31b906c9ad3e94037bc5bd069cda2865542d620dd520a0558df4d14b8db) |
| 6 withdraw_fees to the administrator | the administrator | executed | [219c7869…](https://testnet.cspr.live/transaction/219c7869261c058e3ce68315e34bada5f96a909768606d11312dad9b9fa04de8) |
| 6 set_fee(0) back to zero | the employer (administrator) | executed | [291d9ede…](https://testnet.cspr.live/transaction/291d9edef6514bbfe768c41b2d35267b4a422f1e042fd22e37f46967cfd9cd17) |

Balances over the run: employer 658.952 → 505.333 CSPR (funded the two gas accounts with 100,
locked 25, got 5 back, paid every call); employee 19.900 → 39.800 CSPR (10 from the oracle's release,
9.9 from the release by the key, 0.1 kept as the 1 % fee and withdrawn by the administrator); the oracle and the stranger
paid gas and nothing else. The deployer key went from 1 103 to 505.333 CSPR for the install and the two passes.

The five measures the Casper rail had to give — create, release too early refused, release by the oracle, refund after
the cancel date, wrong key refused — are rows 1, 2, 4, 5b and 3 / 3b above.

## What is not done

- Nothing on mainnet: a decision for Julien, with a funded mainnet key that does not exist.
- The package is upgradable (`odra_cfg_is_upgradable = true`, the deployer holds the upgrade group); the client always
  reads the latest version of the package. Locking the package, as `deploy_near.mjs lock` does on NEAR, is one upgrade
  away and was not done.
- The common base `sources/xrpl/sequestre.py` (untracked) points at the package and builds `casper-client 5` calls for
  `release` / `refund`; the payable `create` it delegates to this Node client.
- No batch, no sealed payslip, no vault, no pool on Casper: one payer, one beneficiary, one escrow, as on XRPL.
