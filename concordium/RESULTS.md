# Results on Concordium testnet (20–21 November 2026)

Every step of the flow ran on testnet. Each line links to the explorer.

Agent: CIS-8004 token **1345**, badge **`JyP9V7ZjVu29m1xTU1KDH`**, checked green by the official verifier
(`https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9V7ZjVu29m1xTU1KDH`: all 15 checks true, no issue).

| # | Step | Signed by | Fees paid by | Transaction |
|---|---|---|---|---|
| 1 | Token reserve (1,000,000 hh-EURD) from the agent to the employer | agent | employer (sponsored) | [9876d48c…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=9876d48c6a111335687621ac7b3c1cca9cc7f497f1686fc29263617baa4326b4) |
| 2 | All the agent's CCD to the employer: the agent now holds none | agent | employer (sponsored) | [330fb3ac…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=330fb3ac3c2ec66f50a7575bd90bac05254c96a05b7210da69c6633b55872edb) |
| 3 | CIS-8: the dareskro oracle's Solana devnet key bound to the owner | owner | owner | [fada50c0…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=fada50c010246a090819d1053b21f85f7a70305ef2884d2512327c8a665af3dc) |
| 4 | CIS-8004: agent NFT minted, card v1 hash pinned, Cis8 external reference | owner | owner | [9b036880…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=9b036880ff33523d3b50a754bcd518745e9e4eb21b534fcc61d81edb2d84bdbb) |
| 5 | setAgentWallet: payments routed to the agent account (proof signed by the agent key) | owner | owner | [f1c048ad…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=f1c048ad557335c718a0aaab0929997c7dc9e5d7d0ca77b90feeb7c09c36e147) |
| 6 | setAgentURI: card v2 with the badge, new hash pinned | owner | owner | [e7c5cef2…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=e7c5cef2eb5681e053968b2dae6583e26112daece9c78b2b228576c5f5d94c22) |
| 7 | Article 12 record, entry 1: the agent's PROPOSAL (register_data) | agent | employer (sponsored) | [7618fc2f…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=7618fc2f22bf9ad0d1c1b61b0d3c06787c582b0943faff4c7b1b1c018fd8b88a) |
| 8 | Entry 2: the HUMAN APPROVAL | owner | owner | [1e68cfbe…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=1e68cfbe68213ca812f3174875022b4e28a584b829b1242203f39815edc616d6) |
| 9 | Exact approved net, 407.33 hh-EURD, employer to agent, memo = statement + approval hash | owner | owner | [e57122b6…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=e57122b6b4fbae7b56429308149b5a6bedf674c364f904fa89d9b9e4bad4e4e0) |
| 10 | Entry 3: a REFUSAL by the employer's facilitator (a bug of ours: it could not read the payer; it refused rather than guess) | owner | owner | [82f219b3…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=82f219b3c02474e5d62970032b0974a32ab7fabc0d5ba560a3327e67c541f134) |
| 11 | x402 payment: 407.33 hh-EURD agent to employee, co-signed by the employer's facilitator | agent | employer (sponsored) | [febf17b2…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=febf17b2779930804050265e9886dc20ce4a4868b6e5727f1389dca5ae1aa10f) |
| 12 | Entry 4: the PAYMENT | agent | employer (sponsored) | [52ce72c9…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=52ce72c9f9283f4bc464478ad84c70c67f7bcf83d1c28eb091c66ea6074ce662) |

The collector refused the same agent when it called without its badge
(`agent_not_accountable: anonymous agent: no Concordium badge presented`), and it refuses real
testnet agents that are revoked, have no card, or pay from a wallet that is not theirs
(`node test/collecteur_testnet.mjs`, 5/5).

Balances after the cycle: employer 999,592.67 hh-EURD; agent 0 hh-EURD and 0 CCD; employee 407.33 hh-EURD.
The four record entries chain and recompute (`verifierLocal`); entries and nonces stay off chain.
