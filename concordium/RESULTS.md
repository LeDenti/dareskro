# Results on Concordium testnet (20–21 November 2026)

Demo video (2:26): https://youtu.be/Ike9etJ1p6w

Every step of the flow ran on testnet. Each line links to the explorer.

Agent: CIS-8004 token **1345**, badge **`JyP9V7ZjVu29m1xTU1KDH`**, checked green by the official verifier
(`https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9V7ZjVu29m1xTU1KDH`: all 14 checks true, no issue).

| # | Step | Signed by | Fees paid by | Transaction |
|---|---|---|---|---|
| 1 | Token reserve (1,000,000 hh-EURD) from the agent to the employer | agent | employer (sponsored) | [9876d48c…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=9876d48c6a111335687621ac7b3c1cca9cc7f497f1686fc29263617baa4326b4) |
| 2 | All the agent's CCD to the employer: the agent now holds none | agent | employer (sponsored) | [330fb3ac…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=330fb3ac3c2ec66f50a7575bd90bac05254c96a05b7210da69c6633b55872edb) |
| 3 | CIS-8: the dareskro oracle's Solana devnet key bound to the owner | owner | owner | [fada50c0…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=fada50c010246a090819d1053b21f85f7a70305ef2884d2512327c8a665af3dc) |
| 4 | CIS-8004: agent NFT minted, card v1 hash pinned, Cis8 external reference | owner | owner | [9b036880…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=9b036880ff33523d3b50a754bcd518745e9e4eb21b534fcc61d81edb2d84bdbb) |
| 5 | setAgentWallet: payments routed to the agent account (proof signed by the agent key) | owner | owner | [f1c048ad…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=f1c048ad557335c718a0aaab0929997c7dc9e5d7d0ca77b90feeb7c09c36e147) |
| 6 | setAgentURI: card v2 with the badge, new hash pinned (v3 on 21 Nov: wording of the fee sponsor corrected, tx 350325cb…) | owner | owner | [e7c5cef2…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=e7c5cef2eb5681e053968b2dae6583e26112daece9c78b2b228576c5f5d94c22) |
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

## Owner verification (21 November 2026)

The owner proved, from the Concordium Wallet extension, that a verified adult stands behind agent 1345:
a zero-knowledge range proof on the date of birth (born before 22 Nov 2008), from a testnet identity
provider, bound to a fresh challenge. No name and no date of birth left the wallet. The server checked
the proof against the chain (`getPublicData` + `verifyPresentation`), checked that the proving credential
is Active and belongs to the owner account `3f3W…Ecx3`, and recorded the result.

| # | Step | Transaction |
|---|---|---|
| 13 | Request anchor (challenge + statement fingerprint, tag DKAVR), attempt 1 | [0e5ea942…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=0e5ea942ad1583bf950059aea45472761d772230144f4fbd54b1dd35b03436ee) |
| 14 | Entry 5: REFUSAL of attempt 1 (our own checks misread the credential status and the statement order; the proof itself was valid) | [a4237b50…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=a4237b5023e9f73a1ef2c7bf5b08941c141e4ae83360e46644ea1f2776d0f284) |
| 15 | Request anchor, attempt 2 | [2036438d…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=2036438dbe34b98feba33fa58ea3183c754a2497308992f328310d2e377a087d) |
| 16 | Entry 6: OWNER VERIFIED (proving account = owner, credential Active) | [6f6b999a…](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=6f6b999a56096191ee83f2d0048a8800472a0ea496de49db5d91c1d7a58dd3ca) |
