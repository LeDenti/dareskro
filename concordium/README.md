# dareskro Accountable: the payroll agent, made accountable on Concordium

Concordium Trusted Agents Hackathon (Encode, November–December 2026). Testnet only.

We do not build a new agent. We take the payroll agent dareskro already runs (it reads the
schedule and the badge clock, computes the on-call pay statement with deterministic code,
waits for a named human, then pays) and make it accountable:

| Concordium piece | What it does here | Code |
|---|---|---|
| Agent Registry (CIS-8004) + badge | the agent is an NFT owned by the employer's verified account; its card is hashed on chain | `carte/`, `registre/` |
| CIS-8 external key | binds the agent's existing **Solana** key (the dareskro oracle on devnet) to the owner | `registre/preparer.mjs` |
| Sponsored transactions | the employer pays every fee of the agent; the agent holds **no CCD** | `chaine.mjs` |
| Protocol-Level Token | pay is settled in `hh-EURD`, a test euro token issued for this project | `jeton.mjs` |
| x402 | the agent pays the employee's 402 invoice; the employer's facilitator co-signs | `x402/` |
| Concordium ID (Web3 ID proof) | the owner proves once, from the wallet extension, "age >= 18" with no personal data; the proving account must be the agent's owner | `verification/` |
| Badge check (collector) | the employee's service deals only with an accountable agent: valid badge, Active, card hash pinned, payer = the agent's registered wallet | `x402/collecteur.mjs` |
| register_data | EU AI Act Article 12 record: each decision hashed with a random nonce, only the hash on chain | `journal/` |

## Roles (three testnet accounts, one test identity)

- `proprietaire`: the employer, a verified human. Owns the agent NFT, holds the token reserve,
  approves each statement, runs the x402 facilitator and sponsors the agent's fees.
- `agent`: the payroll agent. Holds nothing but the exact net of an approved statement.
- `salarie`: the employee. Receives the net.

## The rails (before Protocol-Level Locks)

Locks reach testnet in 2027 (Simple Locks in January). Until then, as Concordium advised in
workshop 4: a small balance on the agent, x402 spend controls, and an allow-list in code.
We add one hard rail: the agent has no CCD, so nothing it signs reaches the chain unless the
employer's facilitator co-signs, and the facilitator only co-signs a payment that matches an
open human approval (payee on the allow-list, exact amount, `hh-EURD`, rate-limited).
Every refusal is itself recorded and anchored.

In January 2027 the approval transfer becomes a Simple Lock: recipient = employee,
token = `hh-EURD`, expiry = pay date, send right = agent; the funds stay on the employer's account.

## Run order

```bash
npm install
node test/x402_hors_ligne.mjs                 # offline check of the x402 wiring (no key)
node test/collecteur_testnet.mjs              # the badge check against 5 real testnet agents (no key)
node installation/basculer_reserve.mjs --go   # once: reserve and CCD from agent to employer
node carte/construire.mjs 1                   # agent card, pass 1 (no badge yet)
node registre/preparer.mjs 1                  # CIS-8 Solana binding + register payloads
node registre/envoyer.mjs                     # owner signs both
node registre/apres_enregistrement.mjs        # badge file + setAgentWallet (agent key proves control)
node registre/apres_enregistrement.mjs --carte   # card pass 2 with the badge + setAgentURI (push it first)
npm run build:verification && node verification/serveur.mjs   # owner check page :4030 (wallet extension)
node journal/proposition.mjs --ancrer         # 1. the agent proposes (record anchored)
node journal/approbation.mjs --approuve       # 2. the human approves, net moves to the agent
node x402/facilitateur.mjs &                  # 3. employer's facilitator  :4021
node x402/salarie.mjs &                       #    employee's 402 service  :4022
node x402/agent_paie.mjs                      #    the agent pays, records the payment
node x402/agent_paie.mjs --anonyme            #    same agent without its badge: refused by the collector
```

Keys: export each account from the Concordium Browser Wallet into `cles/<role>.export`
(`proprietaire`, `agent`). That folder is git-ignored. The Solana key stays in
`../solana/desk/cles/` (git-ignored) and only signs locally.
