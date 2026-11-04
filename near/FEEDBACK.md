# dareskro × NEAR — Developer feedback

Context: Rust contract `contract/src/lib.rs` (near-sdk 5.30) with escrows, non-transferable NEP-171/177 payslips and a 2-of-3 deposit vault. Testnet run on 2026-11-01 (21:54–21:58 UTC). 12 unit tests and 5 near-workspaces tests. Every item cites code or logs.

1. **No native escrow.** The contract itself is the escrow ([l.3-4](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/contract/src/lib.rs#L3-L4)). Proposal: an audited reference escrow contract.
2. **`store::` collections write lazily.** You must call `flush()` before `storage_usage()` or the storage cost is mis-measured ([l.298](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/contract/src/lib.rs#L298), [325](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/contract/src/lib.rs#L325), [483-484](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/contract/src/lib.rs#L483-L484), [635](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/contract/src/lib.rs#L635)). Proposal: a prominent doc note or a `measure_storage` helper.
3. **No way to tell which leg of `Promise::and` failed.** In [`on_vault_paid` (l.693-704)](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/contract/src/lib.rs#L693-L704) a failed leg leaves funds stranded in the contract. Proposal: named result indices, or a split-payout example with recovery.
4. **Client errors parsed by regex** ([`lib.mjs` l.42](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/lib.mjs#L42)). Proposal: structured errors in near-api-js.
5. **Read-after-write retries** (`viewSure`, [`demo_near.mjs` l.51](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/demo_near.mjs#L51)). Root cause unconfirmed. Proposal: document which finality to request.
6. **Caller-funded storage must be pre-computed** ([README l.92](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/README.md#L92), tx [HF5jND7a…](https://testnet.nearblocks.io/txns/HF5jND7aM3Dbxo5af8AS5vGuCCrSWmXdXroN3tucJuUa)). Proposal: a standard storage estimator.

## References
- Repository: <https://github.com/LeDenti/dareskro>, folder `near/`, MIT. Every cited line refers to commit `58228d1` (`58228d15b0f737d89088819512e4e380a86c774b`) on `main`, 2 November 2026.
- Contract: `dareskro.testnet` ([deploy](https://testnet.nearblocks.io/txns/AwuuUYFBTqtMktFrDVCtrMhN52nPk4XTKxc3gT9ScwSv)); the full run table of 1 November, with every transaction, is in [`near/README.md` l.73-118](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/near/README.md#L73).

## Filed upstream, 2 November 2026
- Items 2 and 6 → near-sdk-rs issue [#1665](https://github.com/near/near-sdk-rs/issues/1665).
- Item 3 → near-sdk-rs issue [#1666](https://github.com/near/near-sdk-rs/issues/1666).
- Item 1 → near-sdk-rs discussion [#1667](https://github.com/near/near-sdk-rs/discussions/1667) (Ideas).
- Item 4 → near-api-js issue [#2026](https://github.com/near/near-api-js/issues/2026).
- Item 5 → near-api-js issue [#2027](https://github.com/near/near-api-js/issues/2027).

## Answered upstream
- Item 2, 4 November 2026, on [#1665](https://github.com/near/near-sdk-rs/issues/1665): the four `flush()` calls are right for this contract. The one case they would not cover is a `store::` collection nested inside another (flushing the outer one does not flush the inner), documented in [#1669](https://github.com/near/near-sdk-rs/issues/1669) — this contract has none: every map value is a plain struct or a `Vec`. A `measure_storage(|| …)` helper is not doable yet (nothing tracks which collections hold unwritten changes) and is planned with the storage redesign; an estimator would not be reliable either. Their advice, attach a generous deposit and refund the surplus as `create_batch` does, is what every payable method here already does.
