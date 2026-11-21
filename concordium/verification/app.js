// Browser side of the owner check, with the Concordium Wallet extension already in Chrome:
// no phone, no QR code, no WalletConnect. The server issues a fresh challenge (anchored on
// chain first), the extension asks the owner to approve, and returns a zero-knowledge
// verifiable presentation of "age >= 18" bound to that challenge. Nothing else is revealed.
import { detectConcordiumProvider } from '@concordium/browser-wallet-api-helpers';

const etat = (t, classe = '') => { const e = document.getElementById('etat'); e.textContent = t; e.className = classe; };
const post = async (u, o) => { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) })).json(); if (r.error) throw new Error(r.error); return r; };

document.getElementById('go').addEventListener('click', async () => {
  try {
    etat('Looking for the Concordium Wallet extension...');
    const wallet = await detectConcordiumProvider(5000);
    const compte = await wallet.connect();
    etat('Creating the request (its fingerprint is anchored on chain first)...');
    const d = await post('/api/demande', { account: compte ?? null });
    etat(`Request anchored (${d.ancre.slice(0, 12)}...). Approve the proof in the wallet window...`);
    const vp = await wallet.requestVerifiablePresentation(d.challenge, d.statements);
    etat('Proof received. Verifying it against the chain...');
    const r = await post('/api/verifier', { demande: d.id, presentation: vp.toString() });
    etat(`Verified: a human over 18 owns agent 1345 (account ${r.compte.slice(0, 8)}..., owner: ${r.proprietaire ? 'yes' : 'NO'}). Record ${r.ancre.slice(0, 12)}...`, r.proprietaire ? 'ok' : 'ko');
  } catch (e) { etat(`Failed: ${e.message ?? e}`, 'ko'); }
});
