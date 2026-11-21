// The collector's check: "is this paying agent accountable?" Run by whoever receives an
// agent's money (here the employee's 402 service) BEFORE accepting the payment.
// Four questions, all answered by the public registry, nothing installed:
//   1. Does the badge resolve to an Active agent in OUR registry (testnet CIS-8004 12802.0)?
//   2. Is the badge valid: card fetched, its SHA-256 equal to the hash pinned on chain,
//      badge block well-formed and conformant? (hosted /v1/check-badge, same engine as MCP)
//   3. Is the account that pays the agent's registered wallet (CIS-8004 agentWallet)?
//   4. Is the owner a real account on chain? On Concordium every account is created from a
//      verified identity, so an owner that exists is a verified human, with no personal data shown.
import { AccountAddress } from '@concordium/web-sdk';
import { outil } from '../mcp.mjs';
import { client } from '../chaine.mjs';

const REGISTRE = '12802,0';
const SERVICE = 'https://agent-registry-mcp.concordium.com/v1/check-badge/';

export async function verifierPayeur({ badge, payeur = null }) {
  const motifs = [];
  if (!badge) return { accepte: false, motifs: ['anonymous agent: no Concordium badge presented'] };
  let fiche = null, verdict = null;
  try { fiche = await outil('agent_by_token_address', { token_address: badge }); } catch (e) { motifs.push(`badge not found in the registry: ${e.message.slice(0, 80)}`); }
  try { verdict = await (await fetch(SERVICE + badge)).json(); } catch (e) { motifs.push(`badge check unreachable: ${e.message}`); }
  if (fiche) {
    if (fiche.status !== 'Active') motifs.push(`agent status is ${fiche.status}`);
  } else if (!motifs.length) motifs.push('badge not found in the registry');
  if (verdict) {
    if (verdict.expected?.contracts?.cis8004 !== REGISTRE) motifs.push(`registry ${verdict.expected?.contracts?.cis8004} is not ${REGISTRE}`);
    if (!verdict.badge_valid) {
      const raisons = (verdict.issues ?? []).map((i) => i.message).slice(0, 3);
      motifs.push(`badge not valid${raisons.length ? ': ' + raisons.join('; ') : ''}`);
    }
  }
  if (fiche && payeur && fiche.agent_wallet !== payeur)
    motifs.push(`payer ${payeur.slice(0, 8)}... is not the agent's wallet ${String(fiche.agent_wallet).slice(0, 8)}...`);
  if (fiche?.owner_account) {
    try { await client.getAccountInfo(AccountAddress.fromBase58(fiche.owner_account)); }
    catch { motifs.push('owner account not found on chain'); }
  }
  return { accepte: motifs.length === 0, motifs, badge, token_id: fiche?.token_id ?? null,
           proprietaire: fiche?.owner_account ?? null, portefeuille: fiche?.agent_wallet ?? null,
           carte: fiche?.agent_uri ?? null };
}
