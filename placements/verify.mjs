#!/usr/bin/env node
/**
 * Look at a publication the way the oracle does, once, and print the observation.
 *
 *   node verify.mjs <url> [required text]
 *   node verify.mjs https://x.com/jack/status/20 twttr
 *   node verify.mjs https://www.youtube.com/watch?v=… "bottomradar.com"
 */
import { observe } from "./presence.mjs";

const [url, must = ""] = process.argv.slice(2);
if (!url) {
  console.error("usage: node verify.mjs <url> [required text]");
  process.exit(2);
}
const obs = await observe(url, must);
console.log(JSON.stringify(obs, null, 2));
console.error(`${obs.ok ? "OK " : "NO "} ${obs.platform}/${obs.method} ${obs.status} — ${obs.why}`);
process.exit(obs.ok ? 0 : 1);
