# Third-party notices

## Ledger — device-management-kit-ts-workshop (Apache-2.0)

The pay desk in `app/` started from Ledger's XRPL hackathon workshop,
<https://github.com/LedgerHQ/device-management-kit-ts-workshop> (folder
`xrpl-hackathon/app`), licensed under the Apache License 2.0. A copy of that
license is in [LICENSE-APACHE](LICENSE-APACHE). As required by its section 4:

Copied unchanged from the workshop:
- `app/src/useDeviceAction.ts`
- `app/src/SpeculosScreen.tsx`
- `app/tsconfig.app.json`, `app/tsconfig.node.json`
- `app/public/favicon.svg`

Derived from the workshop and modified by dareskro (24–25 October 2026):
- `app/src/App.tsx` — the connection, address, sign and submit scaffolding, the
  `Card`, `ActionStatus`, `ErrorBox` and `formatError` helpers come from the
  workshop; the pay desk itself (statement, validation, rate, employee and payout
  choice, escrow, proofs, oracle) is new.
- `app/src/App.css` — the workshop's stylesheet, with dareskro additions after
  the `/* dareskro additions */` marker.
- `app/src/xrpl.ts` — `getBalance`, `fundFromFaucet`, `encodeUnsigned`,
  `encodeSigned` and `submit` come from the workshop; the escrow builder, the
  memos, the rate, the retry logic and the third-party finish are new.
- `app/src/ledger.ts`, `app/index.html`, `app/vite.config.ts` — same pattern,
  adapted.

Everything else in this repository is dareskro's own work, under the MIT
license in [LICENSE](LICENSE).

## Mastercard — Agent Pay for Machines hackathon SDK

`ap4m/` uses Mastercard's AP4M hackathon SDK ("for hackathon use only"). It is
**not** redistributed here: the README says where to download it. No line of it
is copied into this repository.
