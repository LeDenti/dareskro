# depot — the rental security deposit, held by nobody

Prototype run on the XRP Ledger testnet on 27/10/2026 (`run.log`, `compte_rendu.json`).

## Why this is not an escrow

A deposit is held in euros. On 27/10/2026 neither euro token on XRPL (EURØP,
Schuman Financial, issuer `rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK`) nor RLUSD
carries the issuer flag that allows `EscrowCreate` on a trust-line token
(`lsfAllowTrustLineLocking`, bit `0x40000000`; both measured absent on mainnet,
`account_info`, ledger 107 939 265). An escrow is also all or nothing, and a
deposit is usually returned in part.

So each lease gets its own **account**, controlled by a **2-of-3 signer list**:
landlord, tenant, arbiter (dareskro). The account holds the euro token; its own
key is disabled. It needs no issuer flag, pays any split, and nobody moves the
money alone. Measured on testnet:

| who tries | result |
|---|---|
| the arbiter alone | `tefBAD_QUORUM` |
| the landlord alone | `tefBAD_QUORUM` |
| the account's old master key | `tefMASTER_DISABLED` |
| landlord + tenant (inventory matches) | `tesSUCCESS`, 1 200 € back to the tenant |
| landlord + arbiter, then tenant + arbiter (180 € deduction, quote on file) | `tesSUCCESS` × 2 |

Hashes in `run.log`. Memos carry the lease id, the SHA-256 of the entry and
exit inventories, and of the quote behind each deduction: the public trace a
judge can read.

## The law, in code

`bail.mjs` (loi du 6 juillet 1989, art. 22), pure functions, euro cents,
14 self-checks (`node bail.mjs`):

- cap: 1 month of rent excl. charges unfurnished, 2 furnished, 0 in a bail mobilité
- deadline: 1 month after the keys are handed back if the exit inventory
  matches, 2 months otherwise; month to month, 31 Jan + 1 month = 28 Feb
- late penalty: 10 % of the monthly rent per month started, of right
  (Cass. 3e civ., 12 févr. 2026, n° 24-21.258); one day late = one month
- a deduction needs a motive, a document hash, and never exceeds the deposit;
  in a co-owned building, 20 % at most before the yearly accounts are closed

The ledger moves the amounts the code computed. It cannot enforce a calendar on
a multisig account: the arbiter's job is to sign on time, and the memo is the
public trace of who was late.

## Cost per lease

≈ 1.5 XRP of reserve (account + trust line + signer list), paid by the tenant
at opening, returned by a 2-of-3 `AccountDelete` once the account is 256
ledgers old (not run here).

## What this prototype does not do, on purpose

- **Fiat legs.** The tenant's euros arrive from a test issuer. In production a
  licensed partner turns a SEPA transfer into EURØP and back; if the tenant has
  to "buy crypto", the product is dead.
- **Legal opinion.** Whether a 2-of-3 signer in which dareskro cannot act alone
  keeps dareskro out of the loi Hoguet (holding funds for others in a real-estate
  deal) and out of payment-services licensing is an argument, not a certainty.
  A written opinion comes before the first real euro.
- **Lease clause.** The law says the deposit is "paid to the landlord"; a
  three-party clause in the lease must immobilise it in the account instead.
- **Dispute process.** The arbiter signs after mediation (commission
  départementale de conciliation) or a judgment; nothing here replaces either.

## Run

```
npm install
node bail.mjs                 # the rules
node demo_depot_garantie.mjs  # ≈ 3 minutes on testnet, 4 faucet accounts, no seed written
```
