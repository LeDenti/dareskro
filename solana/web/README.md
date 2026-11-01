# dareskro on Solana — the page

One page, no terminal. A wallet, a form to lock funds for someone at a date, the list of escrows read from the chain with **Release**, **Cancel** and **Close**, and an explorer link after every action. The payer chooses what they pay with: **SOL** from the wallet, or **XRP** / **NEAR** through Aurora Intents (a real quote from Aurora's API, mainnet; the devnet escrow itself is funded by the wallet).

```bash
cd solana/web && npm install && npm run dev      # http://127.0.0.1:5176
npm run build                                     # static files in dist/, host them anywhere
```

- **Phantom**: the page asks Phantom to sign; set Phantom to devnet. **Burner key**: a throwaway keypair kept in the browser's localStorage, for devnet only; the Airdrop button asks the devnet faucet (often rate-limited: faucet.solana.com works).
- The program is called directly from the browser (`src/program.js` encodes `create`, `finish`, `cancel`, `close` and decodes the `Escrow` account by hand, so the page ships with `@solana/web3.js` alone).
- Before the date, **Release** is greyed out. The **demo mode** checkbox enables the forbidden actions and sends them without preflight: the ledger keeps the refusal (`TooEarly`, `NotCancellable`…), the log shows it with its explorer link, and the wallet warns that the simulation fails — which is the point.
- Aurora's key in `src/config.js` is documented by Aurora as non-confidential (it is meant for public websites). The quote is `dry`: no deposit address is issued, no funds move.
