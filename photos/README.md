# photos — wedding photos sold to the guests, nobody holds the money

Prototype run on the XRP Ledger testnet on 28/10/2026 (`run.log`, `compte_rendu.json`).

## The case

An agency shot 2,000 photos of 88 guests and puts them online. A guest picks
photos and, for each, either the full-resolution **file** (sent to him) or a
**print** (the file goes to a lab that prints and ships). One price, split by
code between the agency, the photographer who took each photo, and the lab
(print cost + postage). The guest pays once; the agency never touches the
lab's share, and nobody — not the agency, not us — holds the guest's money.

## Two ways to be paid, one signature

| payee | how the money is released | who decides |
|---|---|---|
| agency, photographers (the files) | **key reveal**: the files are boxed under a key K; the escrows' condition is sha256(K); the only way to collect is to put K on the ledger, and K is then public for the guest | nobody — the ledger swaps money for key atomically |
| the lab (the prints) | **proof of shipping**: the oracle reads the carrier's tracking page at the agreed date; shipped → paid, never shipped → refunded | the oracle, reading a public fact ("presence" shape, unchanged since the hackathon) |

The guest signs **one Batch** (XLS-56, all or nothing): one `EscrowCreate` per
payee, priced in XRP at the Kraken EUR rate, with the order's hash, the box's
hash, the payee, the fiat line and (for the lab) the proof and the oracle in
the memos.

Measured on testnet (hashes in `run.log`):

| step | result |
|---|---|
| order A: 3 files (2 by Léa, 1 by Marc) + 2 prints 20×30 (Marc) + postage = 46.90 € → agency 16.50, Léa 8.00, Marc 8.50, lab 13.90 — one Batch, 4 escrows | `tesSUCCESS` |
| order B: 1 print 10×15 = 7.40 € → agency 0.65, Marc 0.65, lab 6.10 — one Batch, 3 escrows | `tesSUCCESS` |
| a stranger finishes the agency's escrow without K | `tecCRYPTOCONDITION_ERROR` |
| the guest tries to take his money back before K is revealed | `tecCRYPTOCONDITION_ERROR` |
| the agency finishes its escrow with K as Fulfillment | `tesSUCCESS` — K is now on the ledger |
| Léa and Marc finish theirs with the K they read on the ledger | `tesSUCCESS` × 2 |
| the guest opens the box with the ledger's K: every file's hash matches the order; a wrong key is refused (AES-GCM) | ok |
| the lab opens the same box, prints, the tracking page of A says EXPEDIE | oracle: `finished` at the date |
| order B's page never says EXPEDIE | oracle: `expired-refunded` at the deadline, the guest gets the lab's share back |

## The price list, in code

`tarif.mjs`, pure functions, euro cents, 8 self-checks (`node tarif.mjs`):
file 8.00 € (6.00 € from 10 files), prints 10×15 2.50 / 20×30 9.00 / 30×45
19.00, lab cost 1.20 / 4.50 / 9.50, postage 4.90 per order with prints (the
lab pays the carrier), the margin split half agency / half the photo's author,
each line rounded to the cent then added, the rounding residue to the agency.
The split equals the total by construction, or the function throws.

## What this is honest about

- **RLUSD and euros.** No euro or dollar token can be escrowed on XRPL today
  (issuers without trust-line locking, measured 27/10/2026), so the lock is in
  XRP at the day's rate, written in the memo — as the hackathon's payroll. The
  payees' conversion to RLUSD is the existing `ap4m/payout.mjs` leg; a guest
  paying by card needs a licensed partner buying the XRP for him. Not simulated.
- **The key is public once revealed.** Anyone holding the box can open it
  afterwards. The box is served only to the buyer, one key per order; a leak
  of the box is the agency's problem, as a leak of a download link is today.
- **The lab's date is a date, not an event.** The oracle looks at the tracking
  page at the agreed date, not the minute the parcel ships. Good enough for a
  lab; a carrier webhook would make it instant.
- **The files are stand-ins** (labelled random bytes), the carrier's page is a
  local server. The ledger side is real.

## Run

```
npm install
node tarif.mjs                                   # the rules
(cd ../oracle && node oracle.mjs watch) &        # the oracle, port 8787
node demo_photos_mariage.mjs                     # ≈ 5 minutes on testnet, 6 faucet accounts, no seed written
```
