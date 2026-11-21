// Checks the keys in cles/ against the chain, prints only yes/no per role, never the key.
import { verifierCle } from './chaine.mjs';
for (const role of ['proprietaire', 'agent']) {
  try { const v = await verifierCle(role); console.log(`${role.padEnd(13)} ${v.ok ? 'OK, matches' : 'WRONG KEY for'} ${v.adresse}`); }
  catch (e) { console.log(`${role.padEnd(13)} ${e.message}`); }
}
process.exit(0);
