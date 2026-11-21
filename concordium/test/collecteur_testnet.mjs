// The collector against REAL testnet agents (picked on 20 Nov 2026 from recent registrations):
// a valid badge whose wallet is not the payer, a revoked agent, an active agent with no card
// pinned on chain, an anonymous caller, a valid badge paid from its own wallet.
// Expected: only the last one is accepted.
import { verifierPayeur } from '../x402/collecteur.mjs';

const cas = [
  { nom: 'anonymous agent', badge: null, payeur: '4ATXveK2NKvMYSruV7rxKTWmz5Gm4mchtJAEPNToz5UfqHQuzr', attendu: false },
  { nom: 'revoked agent', badge: 'JyP9UsLUPZY5yPsJ7LMUR', payeur: null, attendu: false },
  { nom: 'active agent, no card on chain', badge: 'JyP9UrEzTY3A9GdZqEsCM', payeur: null, attendu: false },
  { nom: 'valid badge, wrong payer', badge: 'JyP9Ujg6sP3bAXCoG1qVD', payeur: '4ATXveK2NKvMYSruV7rxKTWmz5Gm4mchtJAEPNToz5UfqHQuzr', attendu: false },
  { nom: 'valid badge, its own wallet pays', badge: 'JyP9Ujg6sP3bAXCoG1qVD', payeur: '3eM7mwKunBpXiTQDJri8nnpGBTTyc68eCZGLkVPXHR9LidndS3', attendu: true },
];
let ok = 0;
for (const c of cas) {
  const v = await verifierPayeur(c);
  const bon = v.accepte === c.attendu; ok += bon;
  console.log(`${bon ? 'PASS' : 'FAIL'}  ${c.nom.padEnd(32)} -> ${v.accepte ? 'ACCEPTED' : 'REFUSED: ' + v.motifs.join(' | ')}`);
}
console.log(`${ok}/${cas.length}`);
process.exit(ok === cas.length ? 0 : 1);
