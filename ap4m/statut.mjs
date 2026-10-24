/**
 * État de l'équipe sur AP4M, vu par l'agent : connexion, fiche participant
 * (agent, marchand, budget), canaux, gaz. Rien n'est envoyé sur la chaîne.
 * Usage : node statut.mjs
 */
import { ethers } from "ethers";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { loadEnv, need } from "./env.mjs";

const { signIn, listChannels } = hackathonSdk;
loadEnv();
const API = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";

const config = await (await fetch(`${API}/public/config`)).json();
const provider = new ethers.JsonRpcProvider(config.network.rpcUrl);
const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"), provider);
console.log("agent     ", agent.address, `gaz ${ethers.formatEther(await provider.getBalance(agent.address))} XRP`);
if (process.env.MERCHANT_PAYOUT) {
  console.log("marchand  ", process.env.MERCHANT_PAYOUT, `gaz ${ethers.formatEther(await provider.getBalance(process.env.MERCHANT_PAYOUT))} XRP`);
}

const session = await signIn(API, process.env.TEAM_NAME || "dareskro", agent);
console.log("connexion  ok, equipe", process.env.TEAM_NAME || "dareskro");
if (session.paymentState) console.log("etat      ", JSON.stringify(session.paymentState));

const me = await fetch(`${API}/public/participant/me`, { headers: { Authorization: `Bearer ${session.token}` } });
const body = await me.json();
console.log("fiche     ", me.status, JSON.stringify(body, null, 2).slice(0, 2500));

const channels = await listChannels(API, session.token);
console.log("canaux    ", channels.length ? JSON.stringify(channels, null, 2) : "aucun");
