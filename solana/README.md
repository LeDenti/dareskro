# dareskro on Solana — an escrow program with no owner

**The employer pays with what they hold, on the chain they hold it on; the employee receives USDC locked on Solana that nobody can take back or redirect.** The bridge is not the product. The padlock on the pay line is.

**Encode Club Solana Hackathon 2026** (12 October → 8 November, online). Tracks: Aurora Intents, Best Consumer App.
**Demo video (3 min 03, English subtitles, submitted 3 November): [dareskro_film_solana_en.mp4](https://github.com/LeDenti/dareskro/releases/download/v0.3-solana-final/dareskro_film_solana_en.mp4)** — the story of a pharmacist's Sunday shift: the vault, the proof, the human signature, the pay released on date, Aurora on mainnet · **screen-recorded demo (3 min 56, English, subtitled): [dareskro_la_linea_solana_final.mp4](https://github.com/LeDenti/dareskro/releases/download/v0.3-solana-final/dareskro_la_linea_solana_final.mp4)** — the drawn story (2 min), then the real screens of 1 November: Aurora on mainnet, the pay desk on devnet · release [v0.3-solana-final](https://github.com/LeDenti/dareskro/releases/tag/v0.3-solana-final) (mid-point: [v0.2-solana-midpoint](https://github.com/LeDenti/dareskro/releases/tag/v0.2-solana-midpoint)) · program on devnet [`6NoVNiHv…`](https://explorer.solana.com/address/6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu?cluster=devnet) · **a shared vault, 2 of 3** (the rental deposit: vote an amount, the agreeing vote pays; run with Phantom 1 Nov) · **a one-page app, no terminal, live at [ledenti.github.io/dareskro](https://ledenti.github.io/dareskro/)** (`web/`: Phantom or a burner key, lock, release, cancel, XRP/SOL/NEAR; devnet) · **deck (9 pages): [dareskro-solana-deck.pdf](https://github.com/LeDenti/dareskro/releases/download/v0.3-solana-final/dareskro-solana-deck.pdf)** (`deck/`) · **the pay desk has a Solana tab** (`app/`, services in `desk/`, run measured 1 Nov) · **the invoice advance, 5 Nov**: a 2-of-3 pool whose ceilings the program holds (on XRPL two signers could overrule them), measured on devnet · **Aurora Intents run live on mainnet, 1 Nov 2026**: XRP → 3 USDC on Solana in 37 s ([XRPL](https://livenet.xrpl.org/transactions/56205926A4B9F65FBE7775F7607D4D568F94995BEF722731577B721C3C74A1E1) · [Solana](https://solscan.io/tx/58Az4DDmpE9MQBMfKjw6bU4SFNuPDkmF1mW1EF2qjaZV6K3W1VMDpXToJZjm7HoKw8bUm4MfyNjyKuQ4x9oguQ9g)).

> The agent reads the evidence. The code computes the amount. A human validates.
> A Solana program pays at the date, or when the proof is public. Nobody holds the
> funds in between — not the employer, not the oracle, not us.

Developer feedback for the Solana and Aurora teams, every item pinned to a line of code or a transaction: [`FEEDBACK.md`](FEEDBACK.md).

## What existed before, what is built here

dareskro was built on the XRP Ledger at the XRPL hackathon in New York (24–25
October 2026, see the [root README](../README.md)): the evidence agent, the pay desk,
the oracle, the Ledger-device signing, six payer scenarios. XRPL has a **native
escrow** (`EscrowCreate`), so no contract was needed there.

Solana has no native escrow. **Everything in this folder is new for this
hackathon**: the Anchor program, its test suite, the client library, the devnet
demo, and the Aurora Intents funding path. The design goal is strict: port the
*guarantees* dareskro measured on XRPL, not just the feature list.

| Guarantee measured on XRPL | How the program gives it on Solana |
|---|---|
| The money goes to the `Destination` written at creation; `EscrowFinish` has no field for another address | `finish` takes no destination argument; the destination account must equal the one stored in the escrow (`WrongDestination` otherwise), whoever signs |
| Before `FinishAfter`, finish is refused by the ledger (`tecNO_PERMISSION`) | `Clock::unix_timestamp < finish_after` → `TooEarly`; the cluster's clock, not a server's |
| An escrow without `CancelAfter` cannot be cancelled, even by its owner | `cancel` on an escrow with `cancel_after = None` → `NotCancellable` |
| A `Condition` (PREIMAGE-SHA-256) is released only by its preimage, which becomes public in the transaction | `condition: Option<[u8; 32]>`; `finish` recomputes sha256 of the fulfillment on chain and **stores the revealed secret in the record** |
| Past `CancelAfter`, finish is refused and anyone may cancel; the refund can only go to the owner | `TooLate` / `CancelTooEarly`; the refund account must equal the stored owner |
| Batch (XLS-56): several escrows under one signature, all or nothing | A Solana transaction is atomic: two `create` instructions in one transaction either both land or neither does (tested) |
| Anyone can finish after the date — if the oracle dies, the employee can | `caller` is any signer; it pays the fee and nothing else |

Who holds the funds: a PDA of the program, one per escrow. Native SOL sits in the
escrow account itself; an SPL token (USDC, Token or Token-2022) sits in a vault
token account whose only authority is that PDA. The program has **no admin
instruction**. Once the upgrade authority is revoked
(`solana program set-upgrade-authority --final`), the only moves left are the
seven below.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `create(id, destination, amount, finish_after?, cancel_after?, condition?, memos)` | the owner (payer) | locks `amount` lamports in a new escrow PDA `["escrow", owner, id]` |
| `create_token(...)` same arguments | the owner | same, for a mint: the tokens move to a vault PDA `["vault", escrow]` |
| `finish(fulfillment?)` | anyone | pays the destination if the clock and the condition allow |
| `finish_token(fulfillment?)` | anyone | same, to a token account owned by the destination; the vault is **emptied** (anyone can drop a stray unit in it, and a non-empty account cannot be closed — the stray unit goes with the pay), then closed, its rent back to the owner |
| `cancel()` | anyone | refunds the owner, only after `cancel_after` |
| `cancel_token()` | anyone | same, for a token escrow |
| `close()` | the owner | deletes a **Finished or Cancelled** record and takes the rent back; a Locked one cannot be deleted |

Shape checks at creation: amount > 0, `cancel_after > finish_after` when both are
set, at most 3 memos of 128 bytes (statement SHA-256, fiat line, oracle address —
what the employer read on the Ledger device on XRPL). Times are Unix seconds.

The record stays readable after the payment (status, who closed it, when, the
revealed secret), so the pay desk's registry is the chain itself:
`listEscrows({ owner })` is a `getProgramAccounts` with a memcmp on the owner.

Events `Created`, `Finished`, `Cancelled` are emitted for indexers.

## The four shapes, unchanged

| Shape | Fields | Who decides what |
|---|---|---|
| payroll | `finish_after` only | the oracle decides *when*, bounded below by the clock; nobody can cancel |
| delivery | `condition` + `cancel_after` | the oracle decides *whether*, by reading a public fact, and reveals the secret |
| presence | `condition` + `finish_after` + `cancel_after` | the oracle checks the post is still there *at the date* |
| affiliate | `condition` + `cancel_after` | the merchant's system confirms the sale; the oracle only guarantees the money was locked first |

## Build, test, run

```bash
cd solana
npm install
anchor build
anchor test --skip-build --validator legacy     # solana-test-validator; 11 tests, ~45 s
```

Toolchain used: Rust 1.99 / rustup toolchain 1.89 (Anchor's pin), Solana CLI 4.3.2
(Agave), Anchor 1.2.2, Node 26. On macOS 26 with the Command Line Tools' 27.0 SDK
the linker refuses `arm64e.x1-macos`; `~/.cargo/config.toml` pins
`SDKROOT = …/MacOSX26.5.sdk`.

### Measured on a local validator (31/10/2026)

```
dareskro escrow on Solana
  ✔ payroll shape: no finish before the date, no cancel ever, anyone finishes after (7744ms)
  ✔ condition: only the secret releases, and the secret becomes public (965ms)
  ✔ refund: before cancel_after nobody can cancel, after it anyone can, and finish is over (6776ms)
  ✔ shape: zero amount, cancel before finish, too many memos are refused at creation
  ✔ batch: several escrows in one transaction are all or nothing (952ms)
  ✔ close: the owner deletes a closed record and gets the rent back; a Locked one stays (1940ms)
  ✔ token: USDC-like mint locked in a vault, released to the destination's token account, vault closed (7745ms)
  ✔ token refund: cancel_after reached, the vault pays the owner back (7323ms)
8 passing (35s)
```

### Devnet — measured 31/10/2026, 08:33–08:35 UTC

Program [`6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu`](https://explorer.solana.com/address/6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu?cluster=devnet),
deployed with its IDL on chain (`anchor deploy --provider.cluster devnet`, 1.4 SOL of rent).
`client/demo_devnet.mjs` replays the XRPL table; every refused attempt is sent
**without preflight**, so the refusal is recorded on chain and visible on the
explorer, like a `tecNO_PERMISSION` on XRPL. Raw results: `client/compte_rendu.json`.

| Step | Signed by | Result |
|---|---|---|
| `create` 0.05 SOL, finish_after +90 s, memos = statement sha256 + "466.57 EUR" + oracle — escrow [`HbMBRDxK…`](https://explorer.solana.com/address/HbMBRDxKM4YRZYyutDc2P8VHa1SBByDdRpD9mqTjhpqr?cluster=devnet) — [28WMXA1o…](https://explorer.solana.com/tx/28WMXA1oscVodSug53vhjQpmXBqy5LayoMFgwT2ecDpoQgZtzQucqe3Up2oMEuSit7xnyZwAZ8DZCiimE5LF4DjS?cluster=devnet) | the employer | locked |
| `finish` by a passer-by **before** the date — [2ZZiTCoe…](https://explorer.solana.com/tx/2ZZiTCoeenbsDWiSwg781vJv8vejaYwWbCgRDsUJwFHfVj3wdABk5LLCi45q98bhexFCcZ2dY7nNzRYXsSuJu8vT?cluster=devnet) | a fresh account | **`TooEarly`**, recorded on chain |
| `cancel` by the employer — [3Bz8geRP…](https://explorer.solana.com/tx/3Bz8geRPhusMAxCW4XVuNcHaZP8fy6cJThWDD4BgLzvDo1TmvH4U7vjAW6yJjNdSAh64HqDGFRQrNdZviGwRogSw?cluster=devnet) | the employer | **`NotCancellable`** (no cancel_after: nobody can) |
| `finish` towards the passer-by's own account — [46QA1yhz…](https://explorer.solana.com/tx/46QA1yhzD9STnSfB3ySE8tUSMjnQnxUBGvkuf6HGvpoKo2ggvEDw7jYP2Du88aF71SMEP7d9pP1v7rBUskF6qavS?cluster=devnet) | the passer-by | **`WrongDestination`** |
| `finish` by the passer-by **after** the date — [5cbxdS3d…](https://explorer.solana.com/tx/5cbxdS3dyJ5yQ2nHcfsdvdcmA5ibJYhLiwbXd8onCWfVSzKNNGu9ntghgyLikrFrpMZtGxPuDYhgDyxQcsKbDWfR?cluster=devnet) | a fresh account | success, employee credited 0.05 SOL, `closed_by` = the passer-by |
| conditional `create` 0.02 SOL, sha256(secret), cancel_after +1 h — [544cTPxx…](https://explorer.solana.com/tx/544cTPxxafcRsubUTaPkdSMGNGCtS3s6HPfQUtz89Zxre7t12QBDthQmgpaqsXEDpq5aZ6xpCGRkqjbhTMopf49n?cluster=devnet) | the employer | locked |
| `finish` with a **wrong** secret — [4is1iBKP…](https://explorer.solana.com/tx/4is1iBKPTNLWNAFsTh3u9EukWqRXiKGfjjLeHzQpAipMFTiGDN3XGoAQEZ81nZ6m86s1U1Gjwhm8Q9bEfp7uAcgd?cluster=devnet) | the oracle | **`WrongFulfillment`** |
| `finish` with the **right** secret — [61y8jSQc…](https://explorer.solana.com/tx/61y8jSQc4ZGW2xnctzGD1UZae15vga1Jig4Q8Edza4EG8AX8tMYDbaJpghjdBaKaa28YMx2mRPM7mr3G9rFUkAFn?cluster=devnet) | the oracle | success; the secret is now stored in the record and readable by anyone |
| two `create` in one transaction, the second unaffordable | the employer | the transaction fails as a whole; the first escrow does not exist |

Same shape as the XRPL table of 24/10: the device signed `EscrowCancel` and the
ledger refused it; here the employer signs `cancel` and the program refuses it.

## The sealed statement — invisible to the public, readable by the administrations

The escrow is public: accounts, amount, the statement's SHA-256 in a memo. The
statement itself is sealed **next to it on chain**, in a `SealedStatement` record
at `["statement", escrow]`:

- public: the SHA-256 of the statement (the memo's), the ciphertext padded to a
  1 024-byte class, its hash, and the list of readers (role + X25519 key);
- private: every line of the payslip. The content key is AES-256-GCM, bound by
  AAD to the hash and the escrow; it is wrapped once per reader with X25519 +
  HKDF-SHA256 + AES-GCM — the primitives of `agent/confidentiel.mjs`, imported,
  not rewritten.

A Solana transaction is 1 232 bytes, so the ciphertext is written in chunks:
`seal_statement` announces the hash and length and the readers, `write_ciphertext`
appends in order, `finalize_statement` recomputes the SHA-256 on chain and only
then marks the record sealed. Afterwards nothing can change but the list of
readers: `add_reader` lets the employer wrap the same key for a pension fund that
got its key later, without re-encrypting anything.

The employee also receives a **Token-2022 token that cannot move** (NonTransferable
extension, metadata pointing at the record, mint authority revoked): a payslip in
their wallet that nobody can take, sell or fake, and that reveals nothing by itself.
The record stores the token's mint.

| Instruction | Who | What |
|---|---|---|
| `seal_statement(sha256_plain, sha256_cipher, cipher_len, iv, tag, uri, readers, token?)` | the escrow's owner | creates the record (≤ 8 192 bytes of ciphertext, or a `uri` for larger) |
| `write_ciphertext(offset, bytes)` | the owner | one chunk, in order, while not sealed |
| `finalize_statement()` | the owner | hash checked on chain → sealed |
| `add_reader(reader)` | the owner | one more wrapped key, up to 6 readers, no duplicate key |

Honest limits: no French administration publishes an encryption key today, so the
demo generates one per administration; the DSN remains the legal channel and this
record is the opposable, timestamped copy. Encrypted personal data on an
immutable ledger is a choice the payer makes knowingly: the `uri` path keeps the
ciphertext in erasable storage and anchors only its hash, with the same readers.

### Measured on devnet, 2026-10-31 09:33 UTC — `client/demo_scelle.mjs`, raw results in `client/compte_rendu_scelle.json`

Record [`EwRpdCAo…`](https://explorer.solana.com/address/EwRpdCAo9w1d99qJCh4MPMY2scg4TWaTwB7ttT3Ta1V5?cluster=devnet), statement = the real `agent/sortie/bulletin.json` of the New York run.

| Step | Signed by | Result on chain |
|---|---|---|
| payroll escrow, memo = `sha256:1eff5d758800…` — [iZ1rJ8eH…](https://explorer.solana.com/tx/iZ1rJ8eHKbSHCuHsbVBY5r3PAmKebqdBTBTEg6j5DPJBEyjjUUmuLB9KMMChWaa8Kf4i7K1tchbxF1wn5ugkHfC?cluster=devnet) | the employer | locked |
| Token-2022 mint, NonTransferable + MetadataPointer, 1 unit to the employee, mint authority revoked — [`BeURzSfU…`](https://explorer.solana.com/address/BeURzSfU7aw2CmubvUnAQWfaTE53ZH5vdVqpXQmTbsWs?cluster=devnet) | the employer | the employee holds it; metadata points at the record |
| `seal_statement` (5 readers: employee, URSSAF, retraite, DGFiP, employer) — [3mxKQDBK…](https://explorer.solana.com/tx/3mxKQDBKarsKWw7Eifkm2RVhisyx2ns2xE9Akd3icp8FtzrcmhYdb27m1K98SNqLfGAxGeBobXM591v7BqYyAE52?cluster=devnet) | the employer | record created, not sealed yet |
| `write_ciphertext` × 7 (5120 bytes for a 4845-byte statement) | the employer | chunks accepted in order |
| `finalize_statement` — [rJu7B5aL…](https://explorer.solana.com/tx/rJu7B5aLZGxPBDuvbABVF47dpeREnkdsRjUi59bk9tyKUciNQ3KiwjJ8M7ebBzXqecwnfsnak8kAYtPpiQQzh9e?cluster=devnet) | the employer | sha256 of the ciphertext checked **on chain**, `sealed = true` |
| employee, URSSAF, retraite, DGFiP each unwrap and decrypt | their own key | 4845 bytes, SHA-256 equal to the escrow memo |
| a fresh key tries | a stranger | `not a reader of this statement` |
| one byte of the ciphertext flipped | anyone | GCM refuses: `unable to authenticate data` |
| `add_reader` agirc-arrco, wrapped from the employer's copy — [4bTaguC8…](https://explorer.solana.com/tx/4bTaguC8hqNQupqXFZiZc4oGAPszRYxQiAbuZcRjZ3LYqBtXkMNhLwvWCvsPBsp6rdzcmXA7DDbmu3j6P5C2WG2s?cluster=devnet) | the employer | 6 readers; Agirc-Arrco opens 4845 bytes |
| the employee transfers the token to someone | the employee | **refused** by Token-2022: Token-2022 error 37, NonTransferable |


## Client

`client/dareskro_solana.mjs` — the same verbs as the XRPL rail, for the pay desk,
the oracle and the demos: `connect`, `createEscrow`, `createInstruction` (for
batches), `finishEscrow`, `cancelEscrow`, `closeEscrow`, `getEscrow`,
`listEscrows`, `conditionPair`, `chainNow`, `sendRecorded`. `client/scelle.mjs` seals and opens the statement, writes it in chunks and mints the employee's token; `node client/scelle.mjs selftest` runs the crypto offline. The signer is always
passed in; nothing here holds a key for anyone else.

## Aurora Intents: funding the escrow from any chain

The employer or the client rarely holds Solana USDC. Aurora Intents (NEAR Intents
underneath) gives them a deposit address on a chain they do hold assets on and
settles **USDC on Solana** to the recipient we name. The cross-chain leg is
Aurora's; the escrow's guarantees are the program's. The two never mix: Aurora
never touches a locked escrow, and the program never sees a foreign chain.

`client/aurora_intents.mjs` talks to `https://intents-api.aurora.dev` over plain
HTTPS (Aurora publishes no SDK for these two flows):

| Flow | Endpoint | Who may use it | What dareskro does with it |
|---|---|---|---|
| quote | `POST /api/quote/{apiKey}` with `swapType: EXACT_OUTPUT`, `destinationAsset` = Solana USDC (`nep141:sol-5ce3…omft.near`), `recipient` = the payer's Solana address; then `GET /api/status/{apiKey}?depositAddress=…` | any API key | the desk asks for exactly the escrow's amount; the payer sends the origin asset to the quote's deposit address; on `SUCCESS` the desk calls `create_token` |
| persistent address | `POST /api/persistent-deposit-address/{apiKey}` (`destinationChain: "sol"`) | organisations approved by Aurora; others get **403** | one address per payer, forever; the module returns `{ approved: false }` on 403 so the desk falls back to a quote — nothing is mocked |
| Intents Connect | `POST /api/v1/executions/{wallet}` with Solana `steps` (one instruction each, `{INTERMEDIARY}` as the only signer) | any key, header `x-api-key` | the deposit could call `create_token` itself from the payer's intermediary account — the "contract-level composability" bonus; not built yet |

Facts that shape the demo: Aurora runs on **mainnet only** (no testnet), the API
key goes in the URL path and is documented as not confidential, fees are set per
key in Aurora's Client Portal (60 % integrator / 40 % Aurora, floor 2 bps on
stables), and a quote carries an optional `appFees` line for the desk's margin.

**Measured on 1 November 2026, with the project's own API key (`dareskro`,
created in Aurora's Client Portal), `dry: true`, so no funds moved:**

| Call | Result |
|---|---|
| `GET /api/tokens` | 210 assets, 15 of them on Solana (SOL, USDC, USDT, USD1, xBTC, …) |
| quote: pay **1 USDC on Solana** with **SOL** | `amountIn` 0.013278573 SOL (1.27 $), delivered in ~19 s, deadline 15 min, withdraw fee 253 550 lamports |
| quote: pay **3 USDC on Solana** with **XRP** (the chain dareskro comes from) | `amountIn` 2.630367 XRP (3.29 $), delivered in ~22 s |
| quote: 1 USDC paid in XRP | **refused**: `Amount is too low for bridge, try at least 2245679` drops (≈ 2.25 XRP). Aurora enforces a bridge minimum per origin asset; the desk must surface it instead of retrying |
| quote with a malformed `refundTo` | **refused** `400 refundTo is not valid` before any deposit address is issued: a refund address is validated up front, which is what a payroll desk needs |

**Run for real on 1 November 2026, 07:44 UTC, mainnet, real funds** — the desk's
Solana address was paid in XRP from dareskro's own XRPL account, the chain the
product comes from. `client/aurora_paye_xrp.mjs` asked a real quote, signed the
XRPL Payment with the account's key (run by Julien, in his own terminal, with an
explicit `--go`), told Aurora the hash, and polled `/api/status` until settlement:

| Step | Where | Proof |
|---|---|---|
| Quote (`dry: false`), 3 USDC out, 15-min deadline | Aurora | `amountIn` 2.627332 XRP (3.28 $), deposit address `rMYEgFREZcNUt3viG3L7NkbefYta6Yb3NU`, no destination tag |
| XRP leaves the payer `rNY2Vc9hBPBcbZZVqzLgzxtTp7e9wVGknb` | XRPL mainnet, ledger 108 040 855 | [`56205926…`](https://livenet.xrpl.org/transactions/56205926A4B9F65FBE7775F7607D4D568F94995BEF722731577B721C3C74A1E1) `tesSUCCESS`, fee 12 drops |
| Aurora status | `PENDING_DEPOSIT` → `PROCESSING` → `SUCCESS` | 37 s after the quote (07:44:56 → 07:45:33), intent `C15Xn2BC…`, 0 refunded |
| USDC land on the desk's address `4ypF64RB…` | Solana mainnet, slot 464 012 735 | [`58Az4DDm…`](https://solscan.io/tx/58Az4DDmpE9MQBMfKjw6bU4SFNuPDkmF1mW1EF2qjaZV6K3W1VMDpXToJZjm7HoKw8bUm4MfyNjyKuQ4x9oguQ9g) — USDC balance 0 → **3.000000**, token account created by the settlement |

Honest numbers at this size: 3.28 $ paid for 3.00 $ delivered, because the
withdraw fee is fixed (0.254 USDC) and dwarfs the 10 bps app fee; at 466 € of
payroll the same fee is 0.05 %. The escrow itself stays on devnet for the
hackathon: deploying the program on mainnet would cost ~2 SOL of rent and prove
nothing more. What the live run proves is the thing Aurora's track asks for: a
real cross-chain funding flow, refund address validated up front, settlement
observed on both chains. The full record of the run (quote, hashes, status
ticks, balances) is written to `client/sortie/`, which stays out of git.

## The pay desk on Solana — same desk, another ledger

The pay desk of the XRPL product (`app/`, React) gained a tab, **Solana · same
desk**: the same statement, the same human validation, the same escrow with one
possible outcome, on Solana. Two local services do what the Ledger and the XRPL
oracle do on the other rail:

| Piece | File | Role |
|---|---|---|
| desk service, 127.0.0.1:8790 | `desk/desk_solana.mjs` | holds the **employer's** devnet key; `POST /lock` turns the validated statement into `create(finish_after)` with memos `sha256:<statement>` · `<fiat> @ <rate> USD/SOL <statement id>` · `dareskro/oracle:<address>`, then tells the oracle; `POST /attempt` sends a forbidden action without preflight so the refusal is recorded; `GET /escrows` reads the employer's escrows **from the chain** and merges the oracle's word; `/fund/*` is Aurora Intents (quote for the statement's USDC, status, the run of 1 Nov as `/fund/proof`) |
| oracle, 127.0.0.1:8791 | `desk/oracle_solana.mjs` | its own key, fees only; `/condition` issues a PREIMAGE-SHA-256 for a delivery escrow and keeps the secret (0600); `/watch` registers an escrow; every 5 s it reads the chain and calls `finish` when the cluster clock passes `finish_after` (payroll) or when the agreed file hashes right (delivery), `cancel` past `cancel_after` |
| the tab | `app/src/SolanaDesk.tsx`, `app/src/solana.ts` | six cards: rail · statement · funding from any chain · lock · proofs · registry |

Run it: `cd solana/desk && node oracle_solana.mjs create && node oracle_solana.mjs watch`
in one terminal, `node desk_solana.mjs` in another (employer key = `~/.config/solana/id.json`
or `SOLANA_KEYPAIR`), `cd app && npm run dev` for the desk, then the Solana tab.
The rate comes from Aurora's own token list (the same source as the funding leg).

**Run from the tab on 1 November 2026, 08:02–08:04 UTC, devnet, the full amount:**

| Step | What happened | Proof |
|---|---|---|
| Statement | `bulletin.json`, net to pay **440.36 USD**, sha256 `384ec59c…`, validated by Julien at 08:02:24Z | the sha256 is the first memo |
| Funding quote (dry) | 440.36 USDC on Solana for 355.539142 XRP (444.42 $), ≈ 24 s | Aurora quote, no deposit address issued |
| Lock | `create`, **4.612065354 SOL** at 95.48 USD/SOL, payable at 08:04:23Z, escrow [`Fu4yEH4Y…`](https://explorer.solana.com/address/Fu4yEH4Y1sycRQPLDPZxo3G5sKm92PgfmFyERnUPQS2V?cluster=devnet) | [`5Lqp5sAz…`](https://explorer.solana.com/tx/5Lqp5sAzbDQAY7r9jNcWUDS5fSRebURJCQWwCh6KEhbYEnXrNTFGJYqJNVKt1bEr6G58fQsFmx9cY4snGVsrtCtm?cluster=devnet) |
| Passer-by releases before the date | **refused `TooEarly`**, recorded | [`34QsK7is…`](https://explorer.solana.com/tx/34QsK7is7j8ajK4Xe8RGVc4VhG5TpuN3boxiaykLBiK2XmVMEhSJEHjHGnLneFiVZ4XwZ1VL9vwK4hxWhezibKSM?cluster=devnet) |
| Employer takes the money back | **refused `NotCancellable`**, recorded | [`2hZBEFmp…`](https://explorer.solana.com/tx/2hZBEFmpCqPQX25qPubsdNa8CvJ2m6fm3ujjBYJiZ5VLcsoH3WDnfBJMGP7Dv7PtjKHBCegrZ1WNszWFw3jMsL3M?cluster=devnet) |
| Passer-by releases to themselves | **refused `WrongDestination`**, recorded | [`2mcFfLPq…`](https://explorer.solana.com/tx/2mcFfLPqPxVYUE8Ckt9VTXwQFVtGCu98hHWoXjyvjdAFb1GwhPDHcQRTYNtJRAijDcDtk3V1RcuDKdMKDb4dAQfj?cluster=devnet) |
| The oracle, 7 s after the date | `finish` by `5k8j3SXM…`, 4.612065354 SOL to the employee `9SnQCNbh…` | [`QfWj923H…`](https://explorer.solana.com/tx/QfWj923Hp4RvPHzej5Gssnzm6935KGAPJjS6SToh5PqFXVhdfLv1ggHL9WQXDeb9diSfVZ1cxRSEdgph8Qrt434?cluster=devnet) |

The same sequence had run through the API alone a few minutes earlier (564.56 USD
gross, escrow `2v8A2JYT…`, finished by the oracle at 07:59:55Z); the devnet SOL
was returned to the employer's key afterwards to keep rehearsing.

What is honest about it: on Solana the employer signs with a key held by the
desk machine, not a hardware device (the Ledger path exists on XRPL only); the
escrow is in SOL on devnet because Aurora's USDC lands on mainnet, and the two
cannot meet without a mainnet deployment; the delivery kind is wired in both
services but was exercised in the program's tests, not from the tab.

## The page — no terminal

**Live: [ledenti.github.io/dareskro](https://ledenti.github.io/dareskro/)** — the same page, built with
`vite build --base=/dareskro/` and published from the `gh-pages` branch (GitHub Pages). It talks to the
devnet program directly; a burner key is created in the browser and funded by the page's airdrop button
or by [faucet.solana.com](https://faucet.solana.com) when the public faucet rate-limits. Measured from
the live page on 6 November 2026: burner `2sgCvFA5…`, lock of 25 USD (0.2781 SOL, fee 0.0005 SOL on top)
to `4ypF64RB…`, escrow [`6kohkoG7…`](https://explorer.solana.com/address/6kohkoG7rBWZMkpctYkgxg5Ee1F8kBfTeSnaJAFiy1Z?cluster=devnet).


`web/` is a single page (Vite, `@solana/web3.js`, nothing else) for the judge or
the employer who will not open a terminal: connect **Phantom** or use a devnet
**burner key**, fill *recipient · amount in USD · pay date*, choose what the payer
pays with — **SOL** from the wallet, **XRP** or **NEAR** through an Aurora Intents
quote — and lock. The list below is read from the chain: **Release** (anyone, after
the date), **Cancel** (only if a cancel date was written, only after it), **Close**
(the payer deletes a finished record and gets the rent back). Before the date the
buttons are greyed out; a **demo mode** checkbox enables the forbidden actions and
sends them without preflight, so the program's refusal is recorded and linked
(the wallet then warns that the simulation fails, which is the point). `cd solana/web && npm install && npm run dev`.

**Run from the page on 1 November 2026, 09:48–09:52 Paris, devnet, burner key `BCkzP6Qn…`:**

| Click | Result | Proof |
|---|---|---|
| Quote, pay with NEAR, 10 USDC | Aurora answered (dry): the NEAR amount, delivered in ≈ 24 s | — |
| Quote, pay with XRP, 10 USDC | 8.282573 XRP (10.35 $), ≈ 22 s, withdraw fee 0.254 USDC | written in the escrow's second memo |
| Lock 10 USD → 0.1046 SOL, payable 09:50 | escrow `67BSAgWy…` | [`43fe85DH…`](https://explorer.solana.com/tx/43fe85DHLSe3j12haMyAy9ecK5xp4hukHobpTXkv8kjpjvFBgUUQEM9aQiEC1i7uteefKCxymVtrmc3ZpmG9RLrX?cluster=devnet) |
| Cancel (no cancel date) | **refused `NotCancellable`**, recorded | [`5SpfSJCS…`](https://explorer.solana.com/tx/5SpfSJCSvmFF29p9nUtZrxVScgsJnZ18GX6KnE53pCZ59wDZLaWwBbJi2WqbsseXEhCbbeE3FH4zQTrtbHTnvbkk?cluster=devnet) |
| Release, after the date | paid to the recipient | [`3feiFwWb…`](https://explorer.solana.com/tx/3feiFwWb1LBtGKNcwE9gQkN4ikgwwtHhxLotBCDJDv8iiQMS141QFbRkNe5Dn7NKaKSbLhrWf5mr5gtJ9FdiYw16?cluster=devnet) |
| Close | record deleted, rent back to the payer | [`c85AtMMV…`](https://explorer.solana.com/tx/c85AtMMVkH8kSc2JZkqgQ2XrbzFeTXZnhMhsfAtW6qEhksik1fjwixZtKPDq92zEtbsksVZHNtNWqGNjSKkLcug?cluster=devnet) |
| Lock 5 USD → 0.0523 SOL, payable 09:58 | escrow `FNe5fU…` | [`2AmDMo6T…`](https://explorer.solana.com/tx/2AmDMo6TJkRSZmiPxoE73pThBNSAodsGHJja9vGy9TyJb7oM4VpVK1UK6KZXmTndWzxYhWBBNiTft7PxfX7ZdxeG?cluster=devnet) |
| Release, before the date | **refused `TooEarly`**, recorded | [`3Lye6E6v…`](https://explorer.solana.com/tx/3Lye6E6vexBdn5Z3smDjcc4HRHvaRuWVeCUaRz6iNvTRE6E9hYEQPLh3U9t5BXgKQUPuWwWA93ovNXP5mYjqWv9x?cluster=devnet) |

**And with a real wallet — Phantom, 1 November 2026, 10:20–10:34 Paris, devnet, Julien's own address `3Q4rQktX…`, every signature confirmed on his screen:**

| Click | Result | Proof |
|---|---|---|
| Lock 5 USD → 0.0523 SOL, payable 10:30 | escrow `3YKUNVWj…` | [`5goJHuro…`](https://explorer.solana.com/tx/5goJHuro3BBk6Qaah1kpv749WDY5bPYRcaNFsxFaiunERTtd8AQS252b55q1wmy2JxRVkYvotyMw3im1A6i5qr19?cluster=devnet) |
| Release, before the date (demo mode) | **refused `TooEarly`**, recorded; Phantom warned that the simulation fails, which is the point | [`AdKHTtCZ…`](https://explorer.solana.com/tx/AdKHTtCZCG5Jf584Vh3mTN5YRz2E1sD5oQu64wPubqQBgC2ms9PQmKs8hx4kryatto5NsohgE3cJm8Zd9B2whMc?cluster=devnet) |
| Release, at 10:30 | paid to the recipient, no wallet warning | [`5BQPRfTi…`](https://explorer.solana.com/tx/5BQPRfTiYhKWVR5YxEdYKwTJkD1bhbNxMz4WdwVnm2fAKbJY64D2T8xmgAqNSR9cJj7egiQ9v4QUa3n3ATitVFDm?cluster=devnet) |
| Close | record deleted, rent back | [`4NJTjqNv…`](https://explorer.solana.com/tx/4NJTjqNvgczfRiwkpFxf74N9eLb2iocX3r71LfJ4xACZz8GvzWJuRWBAH3zq81r42ZNxnrVRhqS4f2JGuvj6RDff?cluster=devnet) |

What the wallet run taught, and what changed because of it: a Solana blockhash lives about a
minute, and a person confirming in Phantom often takes longer, so the page now asks for a
fresh signature when the first one expires (three tries); and a consumer must never meet
the wallet's red warning by accident, so before the date the buttons are greyed out unless
**demo mode** is on. Phantom must be set to Devnet (Settings → Developer settings → Testnet mode).

## The shared vault — a deposit several people decide on (2 of 3)

The rental-deposit shape of dareskro, as a program account: the tenant (owner)
funds it, the landlord is the beneficiary, a mediator is the third voice. Each
party votes **how much goes to the beneficiary**, the rest returns to the owner;
a party may change its vote while nothing is decided; the vote that makes
`threshold` identical votes pays, in that same call. Past an optional deadline
with no decision, anyone may return the whole deposit to the owner. Nobody holds
the money in between, and nobody can route it anywhere but to the two addresses
written at creation.

| Instruction | Who | What the program checks |
|---|---|---|
| `vault_create(id, beneficiary, amount, parties, threshold, deadline?, memos)` | the owner | 2–5 distinct parties, 1 ≤ threshold ≤ parties, amount > 0, deadline in the future; the lamports move into the vault account |
| `vault_vote(to_beneficiary)` | one of the parties | `NotAParty` otherwise; ≤ amount; beneficiary and owner accounts must be the ones written (`WrongDestination`, `WrongOwner`); when `threshold` votes agree, pays beneficiary + owner and marks Finished |
| `vault_timeout()` | anyone | `NoDeadline` / `DeadlineNotReached` otherwise; returns everything to the owner, marks Cancelled |
| `vault_close()` | the owner | only a decided vault (`StillLocked`), rent back |

Two tests cover it (13 pass in all): the full story with a split, the stranger, the
swapped beneficiary, the double payment; and the deadline refund with the shape refusals.

**Run from the page on 1 November 2026, 22:39–22:45 Paris, devnet, Julien's Phantom as tenant:**

| Click | Result | Proof |
|---|---|---|
| Fund the shared vault, 20 USD → 0.212 SOL, 2 of 3 (tenant `3Q4rQktX…`, landlord `9SnQCNbh…`, mediator `5k8j3SXM…`) | vault `B8GFUQKm…` | [`2cyqvZoQ…`](https://explorer.solana.com/tx/2cyqvZoQDG3JSf2MZ4uLLYPxyEVrXpzKVvY6jdhzrTRRn1vnjpjsEWFmBM3zFWb41mnU8u2aMH9zD47paV64Nqn3?cluster=devnet) |
| Landlord votes: all 0.212 SOL to me (`client/coffre.mjs`) | 1 vote, nothing moves | [`3xgkXtxY…`](https://explorer.solana.com/tx/3xgkXtxYvNRnB3ycaXgk82BrU8bYj3aybEccsUSgGXj6Vc4i8AffaW8fxZ89AGi6f3YKmcjfYxHc7pmrN7r226x7?cluster=devnet) |
| Mediator votes: 0.08 SOL to the landlord, the rest back | 2 votes, none alike, nothing moves | [`43qF93KQ…`](https://explorer.solana.com/tx/43qF93KQpf2sDt6mKfT6eUS22EB7oL35psGmke7XnXZRLQSHno8y9Dz1RSV41PzhcnEzm5V4qtWyNVDMSFdAduXz?cluster=devnet) |
| Tenant clicks "Agree with the mediator: 0.080 SOL" in Phantom | **2 of 3 — paid in that call**: 0.08 SOL to the landlord, 0.132 SOL back to the tenant, status Finished | [`5y9EGV42…`](https://explorer.solana.com/tx/5y9EGV42HyGG3QLKhcVF72fi3ay9k5Sf1DoyY2zJT5puLnTJcmUr7DQ7GhwMnNKAJ86ZVoMaPY2ynTkNH5Bb581K?cluster=devnet) |
| Close, by the tenant in Phantom | record deleted, rent back | [`axSasdpk…`](https://explorer.solana.com/tx/axSasdpkMG2nvsqZjoqardEicfrgGYBbTipisHkd7ZXxEyM5gqKUgiy1k7KxPRSnrEiG34emQwUxXvp1AneqKna?cluster=devnet) |

The page lists every vault where the wallet is owner, beneficiary or party, with
the votes cast, one-click "Agree with…" buttons for the amounts already on the
table, the free choices (pay all, refund all, split), the deadline refund once it
is due, and Close. Honest note: the on-chain IDL account could not be re-created
after this deployment (devnet RPC refusals); the page encodes the instructions
itself and does not need it, explorers decode the new calls less prettily until it is back.

## The fee per act — three rails, one line on the invoice

The service may charge each act, even a small amount. Where it is charged depends on
the rail, not on the contract — and no single act ever goes through more than two levers.
The schedule is **zero by default** everywhere, **bounded by the code** wherever code can
bind it, and **paid by the payer on top** of what is locked: what the recipient receives
is never touched, so the claim at the top of this file stays true.

| The payer pays… | …and the funds lock on | Lever | Bound by |
|---|---|---|---|
| SOL | Solana | **1** — `fee_bps` of the SOL locked with a floor, in `create` / `create_token` / `vault_create` | the program: `MAX_FEE_BPS` = 100, `MAX_FEE_MIN` = 0.01 SOL |
| XRP or NEAR, bridged by Aurora | Solana | **2 + 1** — an `appFees` cut asked of Aurora, then lever 1 | Aurora's API (see the measurement: it keeps its own 10 bps) |
| XRP, conditioned escrow | XRPL | **3** — drops the oracle asks before it signs the release (`oracle/tarif.json`) | the oracle's own rule; the refund at `CancelAfter` never depends on it |
| XRP, date-only escrow | XRPL | none that holds: anyone may finish it | — |
| NEAR | NEAR | the same rule in `near/`, since 02/11 (≤ 1 %, floor ≤ 0.1 NEAR) | the contract |

**On Solana** (`programs/dareskro_escrow`, instructions `config_init`, `set_fee`, `set_admin`,
`withdraw_fees`; account `FeeConfig`, seeds `["config"]`): the schedule account is created once by
the program's upgrade authority, starts at zero, and only the administrator key may set it or
withdraw the till — but never above the two constants compiled in, whoever administers. A token
escrow, which locks no SOL, pays the floor. The fee sits in the schedule account above its rent and
leaves in one `withdraw_fees`; release, cancel, vote and the deadline cost nothing. The `Created`
and `VaultCreated` events carry the fee charged. The page shows it before the wallet signs
(`Fee per act: …`), the desk records it on each lock (`fee` on the record, `/identity.fee`).

Test `fee per act` (14 passing): a stranger cannot set it, the administrator cannot exceed the
ceilings, 1 SOL at 50 bps costs the owner exactly 0.005 SOL on top while the escrow holds exactly
1 SOL, 0.01 SOL pays the floor, a vault and a token escrow are charged, the schedule account cannot be
swapped (wrong owner, unknown key and another program account are each refused), a stranger cannot
withdraw, the administrator withdraws the till and the account keeps its rent, and back at zero an
act costs rent and gas only.

### Measured on devnet, 03/11/2026 05:56 UTC — `client/frais.mjs measure`, `client/sortie/frais.log`

Schedule account [`9jdayx9U…`](https://explorer.solana.com/address/9jdayx9UcxXC5EMtRXVyAZMSx1icFPDZhjX7EzZ2sg8m?cluster=devnet),
created by the upgrade authority ([2zsw9Xht…](https://explorer.solana.com/tx/2zsw9XhtU5WTy7ovBqiTSFZ92xcNfxWBq3FUPdu2j82YhgqXKHQGgk5t9VBVko2u9CpYRYCeAnC77DM5iY5hQw3d?cluster=devnet)); program redeployed at slot 518117218 (496 528 bytes).

| UTC | Step | Result | Transaction |
|---|---|---|---|
| 05:56:35 | 1 | schedule: administrator `4ypF64RB…`, 0 bps / floor 0 SOL, 0 act charged; ceiling 100 bps / 0.01 SOL | |
| 05:56:36 | 2a | a stranger `set_fee` → refused **NotAdmin** | |
| 05:56:36 | 2b | the administrator at 101 bps → refused **FeeAboveCeiling** | |
| 05:56:36 | 2b' | the administrator with a floor of 0.0101 SOL → refused **FeeAboveCeiling** | |
| 05:56:37 | 2c | the administrator sets 50 bps with a floor of 0.001 SOL | [AmBoQffE…](https://explorer.solana.com/tx/AmBoQffETm6U3u9xsoUcKYQYMpEDotdHH2RpU3G3RttYBgFxGm1u4h1LjUhCfBUxZBDevCUf8bPTg6xUaroGoqY?cluster=devnet) |
| 05:56:38 | 3 | escrow [`EDS6KS2y…`](https://explorer.solana.com/address/EDS6KS2yK9Mnx6DpeYFkK6eEhtTzpuPAKVEMJwJnVQPb?cluster=devnet): 0.05 SOL locked, on chain 0.05 for the destination; the owner paid **0.001 SOL on top** (0.5 % is under the floor) + rent + signature | [2dLaUKYp…](https://explorer.solana.com/tx/2dLaUKYppbeuBARWzigESoPNpm74ZePzEGwNrcHRZHirYGPxEQBR2MEhKKn9zUsHpfg9CsZaju4tBq8qf8bVYx44?cluster=devnet) |
| 05:56:38 | 4 | till: held 0.0010, total 0.0010, 1 act charged | |
| 05:56:38 | 5a | a stranger `withdraw_fees` → refused **NotAdmin** | |
| 05:56:39 | 5b | the administrator withdraws: 10.4737 → 10.4746 SOL (+0.0010 after the signature); held 0 | [5raCMBsH…](https://explorer.solana.com/tx/5raCMBsHkC1Bs1HH4Wf9SRh7ZZoSyKeRKJew6yRFYNDvC1xyHggjRZaJffYbFMDuAYvewh4ygGxAfTPDp3tJeG1t?cluster=devnet) |
| 05:56:47 | 6 | schedule back to 0 bps / 0 SOL; total charged since creation 0.0010 SOL over 1 act | [3pzGqG5P…](https://explorer.solana.com/tx/3pzGqG5PYarK1Ag6dqqnxwjANoWaLL4YBt72Mesn7BnXW45oczyvZVdBaEcbrGSrHFLsDDtNJZFLZsV5abVdJ93H?cluster=devnet) |

Live on that schedule, 03/11 06:05–07:05 UTC: the desk locked 1 USD ([`9TiyEU4V…`](https://explorer.solana.com/address/9TiyEU4VcBjGSutitF5GSVfqvXHN5Gc1pa4wWM3p27mQ?cluster=devnet), record `fee: 0.0005 SOL, paid by the employer on top`) and the page, from a burner key, locked 1 USD too ([`4AsEWbt1…`](https://explorer.solana.com/address/4AsEWbt1TnjUkhqDZ5C94dzyWCofLLqJdiNBix139NdD?cluster=devnet)) with the line *dareskro fee 0.0005 SOL on top* shown before the signature.

The devnet schedule now reads **0 bps with a floor of 0.0005 SOL** ([6MEaDNBb…](https://explorer.solana.com/tx/6MEaDNBbnadSGHBqzRNuZWEecoRB6x89RPywE5zdKFgTR4c2ar1NiT5SbZSc63enbVQERoFKYDSMnNhCBk1GHtA?cluster=devnet)): every
escrow or vault the page or the desk creates from now on shows and pays that small fee. `node client/frais.mjs show | set <bps> <floorSol> | withdraw | admin <key>`.

### Lever 2, measured on Aurora — 03/11/2026, three dry quotes

`aurora_intents.mjs` sends `appFees: [{ recipient: "dareskro.near", fee: <bps> }]` with every quote.
Aurora's API **echoes back its own fee whatever is asked** — 0, 10 or 100 bps, or no `appFees`
at all — `[{ recipient: 2da316c1…, fee: 10 }]`, and the amounts do not move (2.436793 XRP for
3 USDC, 81.031827 XRP for 100 USDC, in every case). So on this key the bridge already carries a
10 basis-point app fee, Aurora's, and **no dareskro cut can be added on that leg**. A cut on the
bridge would mean calling the NEAR Intents 1Click API directly, with its own key. The desk and the
page show what was asked and what Aurora applied, side by side.

### Lever 3, measured on XRPL testnet — `oracle/demo_frais.mjs`

Oracle [`rUuvu1XP…`](https://testnet.xrpl.org/accounts/rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW), `oracle/tarif.json` set to 1000 drops for the run, then back to 0
(the drops in force at `/watch` stay on the entry). The gate is the oracle's constat: the ledger has no commission field, and
the Batch that would bind escrow + payment is not signable on the Ledger's XRP app, so the service is billed where the service
is — the signature that reveals the secret. The refund at `CancelAfter` does not depend on it; a date-only payroll escrow has no gate.

| UTC | Step | Result | Transaction |
|---|---|---|---|
| 06:04:18 | 0 | schedule in force: 1000 drops per conditioned escrow, memo `dareskro/fee "<owner>:<sequence>"` (`GET /fee`) | |
| 06:04:41 | 2 | client `rQD6K9dV…` locks 20 XRP behind the condition, refund after 420 s | [4A313F47…](https://testnet.xrpl.org/transactions/4A313F47197CED7A182EBE2AA74EFB1142BF83AF85E32F4892AE076011C91395) |
| 06:04:41 | 3 | `/watch` answers with the fee due: 1000 drops to the oracle, memo `rQD6K9dV…:22030056` | |
| 06:04:47 | 4 | the RIGHT file is published at once; the oracle: *match (76 bytes); the service fee is not paid* — **waiting**, nothing signed | |
| 06:04:56 | 4b | 9 s later, still waiting: the proof alone does not open the escrow (freelancer still at 100 XRP) | |
| 06:05:01 | 5 | the client pays the fee: 1000 drops to the oracle with the memo asked, `tesSUCCESS` | [D462E57B…](https://testnet.xrpl.org/transactions/D462E57B89E83AD18770F06EE12D16FD37C0A2809DC734A731A70F54D5BF835E) |
| 06:05:13 | 6 | next tick: fee seen (1000 drops, `D462E57B…`), the secret is revealed, **finished** | [5D232FA9…](https://testnet.xrpl.org/transactions/5D232FA95F9E7222E1DAF07BA1883FA0D49324CFDAAACE0D7FF4DE224259D369) |
| 06:05:13 | 7 | freelancer 100 → **120 XRP**, the full amount: the fee came on top, from the client; oracle 99.990744 → 99.991284 XRP (+0.000540 = the fee minus its own EscrowFinish fee) | |

Raw rows in `oracle/sortie/frais_2026-11-03T06-05-13-918Z.json` (not committed). `GET /fee` publishes the schedule; `/watch` returns the fee due with each registration.

**Where this leaves the invoice.** One line, « frais dareskro », whatever the rail: a fixed amount per act on Solana, NEAR and XRPL,
each paid on top and visible before the signature (Phantom, the Ledger, the desk). The percentage exists in the code (Solana and
NEAR, capped at 1 %) but stays at zero until counsel says whether charging it makes dareskro a crypto-asset service provider
under MiCA — a fixed fee for the oracle's constat and the lock is a software service; dareskro never holds the parties' funds,
only its own fee, and that is worth keeping. When two levers stack (a bridged payment then locked on Solana), the bridge's
10 bps are Aurora's, not ours: the payer sees both figures and the sum, nothing is charged twice by dareskro.

## The invoice advance — a pool whose ceilings the program holds

The seventh dareskro case ([`facture/`](../facture/README.md), XRPL, 1 November): a supplier
is advanced most of an invoice before its debtor pays, by a pool decided 2 of 3 — the AI
seat that reads the dossier, the risk policy, the operator. On XRPL the pool is a 2-of-3
multisig account and the measurement showed its limit: F-002 broke the 30 % concentration
cap, the policy signer refused, the AI seat and the operator signed anyway and the ledger
paid (`tesSUCCESS`) — **the ledger knew no cap, only a signer held it**. XLS-66 fixed that
on devnet with `DebtMaximum` (`tecLIMIT_EXCEEDED`), but it is not on mainnet.

Here the program is the pool. `pool_create` writes the ceilings into the account —
`max_share_bps` (one debtor's exposure over the capital), `max_debtor_abs` (the same, in
lamports whatever the capital), `max_advance_bps` (advance over face), `max_term`, `grace` —
and `advance_approve` checks them **at the moment the threshold is reached**, after the
signatures are verified. No proposal exists without the AI seat's memo: `advance_propose`
carries the SHA-256 of the analysis next to the dossier's (`AnalysisRequired` otherwise) — the
"analyse obligatoire et ancrée" of `facture/politique.mjs`, held by the program instead of by
a signer. The rule is Faktura's (Casper, 2026): *the AI approves, only the contract moves the
money*. Two valid signatures out of three cannot
pay what the policy refuses; the refusal is the program's (`ConcentrationBreached`,
`DebtorCapBreached`, `AdvanceAboveCap`, `PoolIlliquid`), and a refused approval is not even
recorded. The rest
is the XRPL scenario written as instructions:

| instruction | who | what |
|---|---|---|
| `pool_create(id, signers, threshold, policy)` | the operator | the pool account (PDA `["pool", operator, id]`) and its ceilings, fixed at creation |
| `pool_deposit(amount)` | a lender (≤ 5) | lamports into the pool, a claim on the book |
| `pool_withdraw()` | a lender | its share: deposit × capital ÷ deposits, out of cash not on advances; a loss lowers it, fees earned raise it |
| `advance_propose(invoice, analysis, supplier, debtor, face, advance, fee, due)` | one signer | `invoice` is the SHA-256 of the canonical dossier (`facture.mjs`, `empreinte`), the fingerprint the XRPL version anchors; `analysis` the SHA-256 of the AI seat's memo, never empty; shape checks only |
| `advance_approve()` | another signer | the approval that reaches the threshold pays the supplier, after the ceilings; dareskro's fee per act leaves the pool here |
| `advance_repay(amount)` | the debtor, or anyone | into the advance account; once advance + fee are covered: pool repaid, fee booked, surplus to the supplier, same call |
| `advance_default()` | a signer, after due + grace | the loss leaves the book (the lenders carry it), what was partly paid goes to the pool; **nothing is seized**, the program holds nothing of the supplier's |
| `advance_buyback()` | the supplier, or anyone for it | the recourse: what is unpaid goes to the pool, the loss leaves the book |
| `advance_close()` | the operator | deletes a settled or never-funded record; a Funded one stays |

Test: `anchor test` replays it on a local validator (15 passing, the absolute cap and the missing memo included). Devnet: `node client/affacturage.mjs measure`
(the three seats and the parties are throwaway keys in `client/cles/affacturage/`, the dossiers are
`facture/pieces/F-2026-00{1,2,3}.txt` canonicalised exactly as on XRPL). Unit: 0.01 SOL, so that the
numbers are the XRPL run's (pool 160, advances 45 / 54 / 36).

### Measured on devnet, 05/11/2026 09:38 UTC — pool [`hsfRkEtS…`](https://explorer.solana.com/address/hsfRkEtSf39K4KgQAY3JndacW8rmfcWpXdYLuuRiaJH?cluster=devnet), `client/sortie/affacturage.log`

Schedule in force: 0 bps, floor 0.0005 SOL per act, paid by the pool. Program redeployed at slot 518895329 (608 424 bytes, after `solana program extend 120000`). A first run at 09:30 (pool `DddwWVqJ…`) measured the same scenario without the memo and the absolute cap.

| step | what the program did | |
|---|---|---|
| 1 | pool hsfRkEtSf39K4KgQAY3JndacW8rmfcWpXdYLuuRiaJH created: 2 of 3, one debtor ≤ 30 % of the capital and ≤ 100 absolute, advance ≤ 90 % of the face, term ≤ 90 d, grace 20 s, the AI seat's memo mandatory | [tx](https://explorer.solana.com/tx/4evJxRow9KVyKkx1dkiUh3h2sw5nkEw3NNnk4bKGrLq27JkRCVpLfvwxJ8iXjZwDUk6uZA2wbPa6moYzLgBsC5KH?cluster=devnet) |
| 2a | lender A deposits 80 (0.8 SOL) | [tx](https://explorer.solana.com/tx/5BKn3QjsDBrDReUguiF5X2zgA9d4AH7FpB8ytjnsniFjjTcRhSSt1ok9p8c66iSgaw1C6TrL8kuVRR7gWRqz3v6P?cluster=devnet) |
| 2b | lender B deposits 80 — capital 160 | [tx](https://explorer.solana.com/tx/4nwrjrVtNBFx2uhQS9uqo1pEBr8EeKDtc8BhJvtxD2U8a1wCvR8cYqCnZNQrQokzRpJSXP5SygbsTo7nxJmEWom7?cluster=devnet) |
| · | a stranger proposes F-001: refused — NotAParty | |
| · | the AI seat proposes F-001 without its memo: refused — AnalysisRequired | |
| 3 | F-001 (dossier 7478bd584137…, memo dbbfeb80e4c9…): 50 due, 45 asked, fee 1 — proposed by the AI seat with its memo anchored, 1 of 2 | [tx](https://explorer.solana.com/tx/5qnisu7eLCZ2iMPvQtL71xvHETxGawMzMRWErTB5en15Wryt5LwkRfSPHYquEfoi8ttTKEhgNsm4KSQkuXAJsCeL?cluster=devnet) |
| · | the AI seat approves its own proposal again: refused — AlreadyApproved | |
| · | a stranger approves: refused — NotAParty | |
| 4 | F-001 approved by the risk policy: 2 of 2, the supplier receives 45 (1.180 → 1.630 SOL); the act fee 0.0005 SOL left the pool — capital 159.95, outstanding 45, losses 0, fees earned 0, exposures A1rJtd… 46 | [tx](https://explorer.solana.com/tx/3RWCNohLD7c3RPX3XC5jpk6jqsdGxaeYG7BwttrCfjCh3ufKQfUi67x4p3Ka4TJyfVah8PvyGFzuZn2ELRJ5XE62?cluster=devnet) |
| 5 | F-002: 60 due, 54 asked for a second debtor — 54 / 160 = 33.75 % of the capital, above the 30 % cap; proposed by the AI seat | [tx](https://explorer.solana.com/tx/xzv8xRYoSRwGRE6tkYTdb4EYLTWM6SCSk6J14iS4dCunQ6powmkYAFCZ9pxxz1YuvxD6Xy1dJoA7gfMzz3rDL2m?cluster=devnet) |
| · | the operator approves F-002 (AI + operator = 2 of 3, as on XRPL): refused — ConcentrationBreached | |
| · | the risk policy approves F-002 as well (3 of 3): refused — ConcentrationBreached | |
| 6 | F-002 stays proposed with 1 approval recorded: the signatures were valid, the program refused (ConcentrationBreached, ConcentrationBreached) — on XRPL the same two signatures paid |  |
| 7 | F-003: 40 due in 25 s, 36 advanced, fee 1 — operator + AI seat, paid — capital 159.9, outstanding 81, losses 0, fees earned 0, exposures A1rJtd… 46 86Z3ht… 37 | [tx](https://explorer.solana.com/tx/2qiZFX6tosawkLENJNp1EfcyG6t1LBkQ6B3bxjxwJCEtvTU6aFNbLCAtdHG3YaZwjtFNRGLc1qjS6v4fAo1tgBQd?cluster=devnet) |
| · | lender A withdraws while 81 are out on advances: refused — PoolIlliquid | |
| 8 | F-001 paid by its debtor: 50 in — 46 to the pool (45 + fee 1), 4 to the supplier (1.990 → 2.030 SOL) — capital 160.9, outstanding 36, losses 0, fees earned 1, exposures 86Z3ht… 37 | [tx](https://explorer.solana.com/tx/2iFY6NFhpdWias5CuHUMU4Gxc1rFSYK7AG5Gk6ynRNqnAiF2zgwJSMMGEhnJAjzmMuHUwhC4RmEbyDMTQNZ7HQYn?cluster=devnet) |
| 9 | F-003: the debtor pays 10 of 40, then nothing | [tx](https://explorer.solana.com/tx/5X5pyThSkHPF8gJSjTD3tBdrFZmogUuPR2YbyHfLETCWECzpNaRLLcRKKP5MN25vgW9pV81KqpB7LQc8WPci7RnR?cluster=devnet) |
| · | default written before due + grace: refused — DefaultTooEarly | |
| · | buyback before any default: refused — NotDefaulted | |
| · | a stranger writes the default: refused — NotAParty | |
| 10 | F-003 in default, written by the AI seat after due + grace: loss 26 on the book (36 − 10), the 10 recovered go to the pool; the program seizes nothing — capital 134.9, outstanding 0, losses 26, fees earned 1, exposures none | [tx](https://explorer.solana.com/tx/67dQmED4Po7YD9SMBasN7QZ3tqM4unJZcec1bHubmiXQZvANRQkwWCGZkYesVeJNE6fzyrrNPgQC54mz2qy6gQ4w?cluster=devnet) |
| 11 | lender A leaves: 80 × capital ÷ 160 = 67.450 (deposited 80) — it carries half the loss — capital 67.45, outstanding 0, losses 26, fees earned 1, exposures none | [tx](https://explorer.solana.com/tx/5siHqD1mQKgQwTt7CtPFj1DdeMVVTnneX8AHYaGgP3Pj5c7aG9WaLktUDa6ijGhgSN5tCvMWWZuzjbsQzZWdSbRC?cluster=devnet) |
| 12 | F-003 bought back by the supplier: 27 unpaid (36 + 1 − 10) paid to the pool, the loss leaves the book — capital 94.45, outstanding 0, losses 0, fees earned 2, exposures none | [tx](https://explorer.solana.com/tx/4GL5C4hLB54MUvoFJBpVX5kRK7osuDWSfHPDmdGDsdB6R7FTBuo6PcmRicEj7eteZpxMDB8BkxVDGJQypwqrtBtE?cluster=devnet) |
| 13 | lender B leaves last with the whole book: 94.450 (deposited 80): the two fees earned, minus the act fees, A's share gone — capital 0, outstanding 0, losses 0, fees earned 2, exposures none | [tx](https://explorer.solana.com/tx/4aacAKAVB64TsAfY8gj1WAADqzoBjtpaju2G2Fn6UbZdQmYhqZqShDVjEocQSbKGxh6epkhWPyj1AoYgWAHNXYgJ?cluster=devnet) |
| 14 | the operator deletes the three records, rent back — pool https://explorer.solana.com/address/hsfRkEtSf39K4KgQAY3JndacW8rmfcWpXdYLuuRiaJH?cluster=devnet | [tx](https://explorer.solana.com/tx/62TMmuWnvTBFjMhD9M8BBnawLY97Xuf8thAbFzVct1783aUB6q6kbPaznqSb5pbB2kyJviqFFHSBmXJYoDwqxHR1?cluster=devnet) |

What this measures, against the XRPL run of 1 November: the same F-002 with the same two
signatures is **refused by the program**, not by a signer's conscience; no proposal is even
written without the AI seat's memo; the loss of F-003 is carried by the lenders in proportion
and lender A, who leaves before the buyback, takes it (67.45 for 80) while lender B, who
leaves after, takes the whole book (94.45 for 80); the dareskro fee per act is a cost of the
pool, visible in `capital` and in the `AdvanceFunded` event (`act_fee`).

## Honest limits

- The record costs ~0.005 SOL of rent until the owner closes it.
- `finish_token` needs a token account of the destination to exist (its ATA,
  usually); anyone may create it, the oracle does in the demo.
- Whatever lands in a vault beyond the escrow's amount is paid out with it: the
  alternative (paying exactly `amount`) would let one stray unit jam the escrow for
  good, since the Token program refuses to close a non-empty account (tested).
- A payroll escrow is **one possible outcome**: if the statement was wrong, the
  correction is a new escrow, as on XRPL. That is the point.
- The invoice advance is a prototype of a **lending** activity (the licence question of
  `facture/README.md` is not settled by moving it to Solana). It is SOL only here (the
  escrow already knows USDC; the pool does not yet), the lenders share pro rata without
  interest or seniority, the book is lamport-exact but not an accounting standard, and the
  pool's signers are plain keys — the AI seat's reading of the dossier happens off-chain, as
  on XRPL; what reaches the program is its signature and the hash of its memo, not the memo.
  The ceilings are fixed at the pool's creation: nobody, not even the operator, changes them
  afterwards (a `pool_set_limits` under compiled caps would be the next step, with a policy
  administrator key).
- Devnet only for the hackathon. On mainnet the upgrade authority would be
  revoked before the first real escrow; the fee administrator (`set_fee`,
  `withdraw_fees`) is a separate key that survives that, bounded by the two
  constants above — the same split as on NEAR.
- The fee schedule account (`config_init`) must exist before any `create`: on a
  fresh deployment the upgrade authority creates it first (`client/frais.mjs init`).

## AI disclosure

Built with AI assistance (Claude), as Encode encourages. The guarantees table and
the tests were written first; the program had to pass them.
