/**
 * Enregistre le portefeuille de paiement du marchand sur le portail AP4M,
 * comme le ferait le bouton « Add my wallet », mais signe avec la clé du
 * marchand qui vit ici (MetaMask ne la connaît pas).
 *   1. connexion de l'équipe avec la clé de l'agent (jeton de session)
 *   2. POST /public/participant/wallet-challenge { role: "merchant", wallet }
 *   3. la clé du marchand signe le message (personal_sign)
 *   4. POST /public/participant/merchant { challenge_id, signature }
 * Usage : node marchand-inscrire.mjs
 */
import { ethers } from "ethers";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { loadEnv, need } from "./env.mjs";

const { signIn } = hackathonSdk;
loadEnv();
const API = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";

const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"));
const merchant = new ethers.Wallet(need("MERCHANT_SUBMITTER_KEY"));
if (process.env.MERCHANT_PAYOUT && merchant.address.toLowerCase() !== process.env.MERCHANT_PAYOUT.toLowerCase()) {
  throw new Error(`MERCHANT_SUBMITTER_KEY derive ${merchant.address}, pas MERCHANT_PAYOUT`);
}
const { token } = await signIn(API, process.env.TEAM_NAME || "dareskro", agent);
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

const ch = await fetch(`${API}/public/participant/wallet-challenge`, {
  method: "POST", headers, body: JSON.stringify({ role: "merchant", wallet: merchant.address }),
});
const challenge = await ch.json();
if (!ch.ok) throw new Error(`wallet-challenge ${ch.status}: ${challenge.error ?? JSON.stringify(challenge)}`);
console.log("defi recu, message signe par le marchand", merchant.address);

const signature = await merchant.signMessage(challenge.message);
const reg = await fetch(`${API}/public/participant/merchant`, {
  method: "POST", headers, body: JSON.stringify({ challenge_id: challenge.challenge_id, signature }),
});
const result = await reg.json();
if (!reg.ok) throw new Error(`merchant ${reg.status}: ${result.error ?? JSON.stringify(result)}`);
console.log("enregistrement:", JSON.stringify(result));

const me = await (await fetch(`${API}/public/participant/me`, { headers })).json();
console.log("portail: merchant_wallet", me.team?.merchant_wallet, "merchant_id", me.team?.merchant_id, "pool", me.team?.merchant_is_pool);
