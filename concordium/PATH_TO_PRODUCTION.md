# Path to production: dareskro Accountable on Concordium mainnet

What exists today on testnet, and what each piece becomes on mainnet, in front of a real
pharmacy and a real employee.

| Today (testnet) | On mainnet | What it takes |
|---|---|---|
| Owner = a testnet account from the test identity provider | The pharmacy owner's account from a real identity provider; later the pharmacy itself via an LEI-backed company identity (Global FinReg) | onboarding through an approved provider; no code change |
| Agent NFT in CIS-8004 testnet (12802) | Same standard on mainnet (CIS-8004 index 10082, CIS-8 index 10081) | re-run `carte/` and `registre/` with `RESEAU = 'mainnet'` |
| Agent's Solana devnet key bound through CIS-8 | The production Solana key of the dareskro program | one CIS-8 registration, signed by that key |
| Pay in `hh-EURD`, a test token | A MiCA-authorised euro stablecoin issued as a PLT (Concordium announced one for December 2026) | change `JETON` in `config.mjs`; the x402 flow is asset-agnostic |
| Reserve moved to the agent per approved statement, rails enforced by the employer's facilitator | **Simple Lock** (January 2027): recipient = the employee, token = the euro PLT, expiry = pay date, send right = the agent; funds never leave the employer's account until sent | replace `journal/approbation.mjs` step 2 by lock create/fund; the agent keeps only the send right |
| Fees sponsored by the employer's own facilitator, key on disk | Sponsor key in an HSM or MPC wallet (KMS / Dfns), rate limits and balance alerts kept | key custody, monitoring |
| Article 12 record: entry + nonce off chain, hash anchored with `register_data` | Same; entries kept at least 6 months (10 years with payroll records), erasable on request without touching the chain | retention policy, access log for inspectors |
| Owner verified once (Verify and Access) | Same flow with production identity providers; the two anchors it writes are cited in the approval entry | Reown project, verifier service in the employer's VPC |

## What stays deliberately out

- The legal French pay slip is still produced by the employer's payroll software. dareskro is the
  proof layer: who computed, who approved, what was paid, to whom, when, and that nothing else moved.
- No model computes an amount. The computation is deterministic code, replayable to the cent.

## Limits we state plainly

Testnet only; no audit of our code; test tokens with no value; the pay statement in the demo is
fictitious; the badge proves a verified human owns the agent, not that the human is honest.
