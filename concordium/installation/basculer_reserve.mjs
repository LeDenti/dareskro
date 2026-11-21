// One-time setup, from workshop 4: the token reserve belongs to the EMPLOYER, not to the agent.
// The 1,000,000 hh-EURD were issued to the agent account (nominated at issuance). This moves
// them to `proprietaire` and sweeps the agent's CCD too, both sponsored by the employer, so the
// agent ends with nothing: it only ever holds the exact net of an approved pay statement.
//   node installation/basculer_reserve.mjs          -> dry run, prints balances
//   node installation/basculer_reserve.mjs --go     -> does it
import { AccountAddress, Transaction, CcdAmount } from '@concordium/web-sdk';
import { COMPTES } from '../config.mjs';
import { client, soumettre, json } from '../chaine.mjs';
import { transfert, soldes } from '../jeton.mjs';

const avant = await soldes();
console.log('before', json(avant));
if (!process.argv.includes('--go')) process.exit(0);

const res = [];
if (avant.agent['hh-EURD'] > 0)
  res.push(await soumettre(transfert('proprietaire', String(avant.agent['hh-EURD']), 'reserve to employer (workshop 4: small balance on the agent)'),
                           { par: 'agent', sponsor: 'proprietaire' }));
const info = await client.getAccountInfo(AccountAddress.fromBase58(COMPTES.agent));
const micro = info.accountAmount.microCcdAmount;
if (micro > 0n)
  res.push(await soumettre(Transaction.transfer({ amount: CcdAmount.fromMicroCcd(micro),
                                                  toAddress: AccountAddress.fromBase58(COMPTES.proprietaire) }),
                           { par: 'agent', sponsor: 'proprietaire' }));
for (const r of res) console.log(r.hash, r.lien);
console.log('after', json(await soldes()));
