# dareskro × XRPL — Developer feedback

Context: dareskro locks payroll in XRP. The desk converts the amount to drops (`app/src/xrpl.ts` l.214 and l.287), into a native **date-only** escrow: FinishAfter, no Condition, no CancelAfter, by design ([`app/src/xrpl.ts` l.10-16](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/app/src/xrpl.ts#L10-L16) and [l.215-216](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/app/src/xrpl.ts#L215-L216); [README l.137](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/README.md#L137)). Anyone, in practice the oracle, finishes it at the hour. The PREIMAGE-SHA-256 condition held by the oracle serves the delivery, presence and affiliate cases, not payroll. XLS-85 Token Escrow was a September study (`sources/`), never published; its two lessons are summarised in the main README, l.112-118. An invoice prototype (Lending/Vault) ran on devnet on 2026-11-01.

1. **The recipient trustline must exist before a third-party EscrowFinish (XLS-85).**
   - Observed: without it, the oracle's EscrowFinish fails with `tecNO_LINE`.
   - Evidence: [main README, l.112-118](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/README.md#L112-L118); the same `tecNO_LINE` on a plain Payment to an account without a trustline, measured 07/09/2026, is recalled in [`depot/demo_depot_garantie.mjs` l.232](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/depot/demo_depot_garantie.mjs#L232).
   - Impact: no impact today, since payroll is in XRP. It would only block payday when paying in stablecoins (RLUSD, EURØP) through a token escrow.
   - Proposal: create the trustline at finish (reserve funded from the escrow), or reserve it at EscrowCreate.
2. **RLUSD cannot be escrowed.**
   - Observed: the issuer lacks `lsfAllowTrustLineLocking`. Measured on 08/09, unchanged on 27/10.
   - Evidence: [main README, l.112-118](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/README.md#L112-L118).
   - Proposal: enable the flag, or publicly document which issuers do.
3. **Unclear XLS-89 MPTokenMetadata warning** (minor).
   - Evidence: appears three times in [`facture/run.log` (l.23, 43, 64)](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/facture/run.log#L23) and in the desk log.
   - Proposal: ship a minimal valid JSON example and a validator in xrpl.js.
4. **Works well: crisp, verifiable refusals.**
   - `tefBAD_QUORUM` on testnet (1 of 3): a `tef` result is never applied to the ledger, so no hash; trace in [`facture/run.log` l.55-56](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/facture/run.log#L55-L56).
   - `tecLIMIT_EXCEEDED` ([A1C24C3E…](https://devnet.xrpl.org/transactions/A1C24C3EBDB76A9C43DAC52B6CC7EC83AE8DE0FEB857137C4BF3B700F950D859)) and `tecTOO_SOON` ([28405135…](https://devnet.xrpl.org/transactions/28405135794DFDF0A281580F5F713CD65B729464A31C4BB241B89BF600FA9300)) on devnet; Lending and Vault ran on devnet only.
   - `tecNO_PERMISSION` in the payroll scenario (run of 24/10/2026 signed by Ledger's XRP app 2.8.1 under Speculos, [README l.59-66](https://github.com/LeDenti/dareskro/blob/58228d15b0f737d89088819512e4e380a86c774b/README.md#L59-L66)): a third party's EscrowFinish **before the date** ([48136EE8…](https://testnet.xrpl.org/transactions/48136EE86CEDF26039857AD3C876697F95CEE59FF25708A149735542BD27D0DB)) and the employer's EscrowCancel on an escrow without CancelAfter ([1E08B209…](https://testnet.xrpl.org/transactions/1E08B209F6C42A9217E24B028611F98C2FF6F33A1631CA3DD965BDD221772600)).

## References
- Repository: <https://github.com/LeDenti/dareskro>, MIT. Every cited line refers to commit `58228d1` (`58228d15b0f737d89088819512e4e380a86c774b`) on `main`, 2 November 2026.
- Networks: testnet `wss://testnet.xrpl-labs.com`, devnet `wss://s.devnet.rippletest.net:51233`. Explorers: testnet.xrpl.org, devnet.xrpl.org.
- Written after the XRPL Commons hackathon, New York, 24–25 October 2026, and the week that followed.

## Filed upstream, 2 November 2026
- Item 1 → XRPL-Standards discussion [#677](https://github.com/XRPLF/XRPL-Standards/discussions/677) (XLS Ideas).
- Item 2 → sent to Ripple through its contact form (issuer decision, not a GitHub matter).
- Item 3 → xrpl.js issue [#3562](https://github.com/XRPLF/xrpl.js/issues/3562).
