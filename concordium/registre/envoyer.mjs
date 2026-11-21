// Sign and submit the registry acts prepared by registre/preparer.mjs, as the owner
// (who pays its own fees: these are the human's acts, not the agent's). Order matters: the CIS-8 binding first,
// then the NFT whose external reference points at it.
//   node registre/envoyer.mjs            -> both acts
//   node registre/envoyer.mjs cis8004    -> only the acts whose name contains the word
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transaction, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy } from '@concordium/web-sdk';
import { ICI } from '../config.mjs';
import { soumettre, json } from '../chaine.mjs';

const filtre = process.argv[2] ?? '';
const prep = JSON.parse(readFileSync(join(ICI, 'sortie', 'actes-registre.json'), 'utf8'));
const faits = [];
for (const a of prep.actes.filter((x) => x.nom.includes(filtre))) {
  const b = Transaction.updateContract({
    amount: CcdAmount.zero(),
    address: ContractAddress.create(a.contract_address.index, a.contract_address.subindex),
    receiveName: ReceiveName.fromString(a.receive_name),
    message: Parameter.fromHexString(a.parameter_hex),
  }, Energy.create(a.suggested_energy));
  const r = await soumettre(b, { par: 'proprietaire' });
  console.log(a.nom, r.hash, r.lien);
  faits.push({ nom: a.nom, ...r });
}
writeFileSync(join(ICI, 'sortie', `registre-envoye-${Date.now()}.json`), json({ carte: prep.carte, faits }) + '\n');
